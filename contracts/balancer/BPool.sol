// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./BToken.sol";
import "./BMath.sol";


/**
 * @title BPoolBase
 */
contract BPool is BToken, BMath {
  /**
   * @dev Token record data structure
   * @param bound is token bound to pool
   * @param ready has token been initialized
   * @param lastDenormUpdate timestamp of last denorm change
   * @param denorm denormalized weight
   * @param desiredDenorm desired denormalized weight (used for incremental changes)
   * @param index index of address in tokens array
   * @param balance token balance
   */
  struct Record {
    bool bound;
    bool ready;
    uint40 lastDenormUpdate;
    uint96 denorm;
    uint96 desiredDenorm;
    uint8 index;
    uint256 balance;
  }

  event LOG_SWAP(
    address indexed caller,
    address indexed tokenIn,
    address indexed tokenOut,
    uint256 tokenAmountIn,
    uint256 tokenAmountOut
  );

  event LOG_JOIN(
    address indexed caller,
    address indexed tokenIn,
    uint256 tokenAmountIn
  );

  event LOG_EXIT(
    address indexed caller,
    address indexed tokenOut,
    uint256 tokenAmountOut
  );

  event LOG_DENORM_UPDATED(address indexed token, uint256 newDenorm);
  event LOG_DESIRED_DENORM_SET(address indexed token, uint256 desiredDenorm);
  event LOG_TOKEN_REMOVED(address token);
  event LOG_TOKEN_ADDED(address indexed token, uint256 desiredDenorm, uint256 minimumBalance);

  modifier _lock_ {
    require(!_mutex, "ERR_REENTRY");
    _mutex = true;
    _;
    _mutex = false;
  }

  modifier _viewlock_ {
    require(!_mutex, "ERR_REENTRY");
    _;
  }

  modifier _control_ {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    _;
  }

  modifier _public_ {
    require(_publicSwap, "ERR_NOT_PUBLIC");
    _;
  }

  bool internal _mutex;

  address internal _factory; // BFactory address to push token exitFee to
  address internal _controller; // has CONTROL role

  // `setPublicSwap` requires CONTROL
  // `bindInitial` sets _publicSwap to true
  bool internal _publicSwap; // true if PUBLIC can call SWAP functions

  // `setSwapFee` requires CONTROL
  uint256 internal _swapFee;

  address[] internal _tokens;
  // Internal records of the pool's underlying tokens
  mapping(address => Record) internal _records;
  uint256 internal _totalWeight;
  // minimum balances for tokens which have been added without the
  // requisite initial balance.
  mapping(address => uint256) internal _minimumBalances;

  function initialize(
    address controller,
    string calldata name,
    string calldata symbol,
    address[] calldata tokens,
    uint256[] calldata balances,
    uint96[] calldata denorms
  ) external {
    require(
      _controller == address(0) && controller != address(0),
      "ERR_INITIALIZED"
    );
    _controller = controller;
    _factory = msg.sender;
    // default fee is 2.5%
    _swapFee = BONE / 40;
    _initializeToken(name, symbol);
    uint256 len = tokens.length;
    require(len >= MIN_BOUND_TOKENS, "ERR_MIN_TOKENS");
    require(len <= MAX_BOUND_TOKENS, "ERR_MAX_TOKENS");
    require(balances.length == len && denorms.length == len, "ERR_ARR_LEN");
    uint256 totalWeight = 0;
    for (uint256 i = 0; i < len; i++) {
      // _bind(tokens[i], balances[i], denorms[i]);
      address token = tokens[i];
      uint96 denorm = denorms[i];
      uint256 balance = balances[i];
      require(denorm >= MIN_WEIGHT, "ERR_MIN_WEIGHT");
      require(denorm <= MAX_WEIGHT, "ERR_MAX_WEIGHT");
      require(balance >= MIN_BALANCE, "ERR_MIN_BALANCE");
      _records[token] = Record({
        bound: true,
        ready: true,
        lastDenormUpdate: uint40(now),
        denorm: denorm,
        desiredDenorm: denorm,
        index: uint8(i),
        balance: balance
      });
      _tokens.push(token);
      totalWeight = badd(totalWeight, denorm);
      _pullUnderlying(token, msg.sender, balance);
    }
    require(totalWeight <= MAX_TOTAL_WEIGHT, "ERR_MAX_TOTAL_WEIGHT");
    _totalWeight = totalWeight;
    _publicSwap = true;
    _mintPoolShare(INIT_POOL_SUPPLY);
    _pushPoolShare(msg.sender, INIT_POOL_SUPPLY);
  }

/* ---  Configuration Actions  --- */

  function setSwapFee(uint256 swapFee) external _lock_ _control_ {
    require(swapFee >= MIN_FEE, "ERR_MIN_FEE");
    require(swapFee <= MAX_FEE, "ERR_MAX_FEE");
    _swapFee = swapFee;
  }

  /**
   * @dev Public swapping is enabled as soon as tokens are bound,
   * but this function exists in case of an emergency.
   */
  function setPublicSwap(bool public_) external _lock_ _control_ {
    _publicSwap = public_;
  }

  /**
   * @dev Absorb any tokens that have been sent to this contract into the pool.
   * If the token is not bound, it will be sent to the controller.
   */
  function gulp(address token) external _lock_ {
    Record memory record = _records[token];
    uint256 balance = IERC20(token).balanceOf(address(this));
    if (record.bound) {
      _records[token].balance = balance;
      // If the gulp brings the token above its minimum balance,
      // clear the minimum and mark the token as ready.
      if (!record.ready) {
        uint256 minimumBalance = _minimumBalances[token];
        if (balance >= minimumBalance) {
          _minimumBalances[token] = 0;
          _records[token].ready = true;
        }
      }
    } else {
      _pushUnderlying(token, _controller, balance);
    }
  }

/* ---  Token Management Actions  --- */

  /**
   * @dev Sets the desired weights for the pool tokens, which
   * will be adjusted over time as they are swapped.
   *
   * Note: This does not check for duplicate tokens or that the total
   * of the desired weights is equal to the target total weight (25).
   * Those assumptions should be met in the controller. Further, the
   * provided tokens should only include the tokens which are not set
   * for removal.
   */
  function reweighTokens(
    address[] calldata tokens,
    uint96[] calldata desiredDenorms
  )
    external
    _lock_
    _control_
  {
    uint256 len = tokens.length;
    require(desiredDenorms.length == len, "ERR_ARR_LEN");
    for (uint256 i = 0; i < len; i++)
      _setDesiredDenorm(tokens[i], desiredDenorms[i]);
  }

  /**
   * @dev Update the underlying assets held by the pool and their associated
   * weights. Tokens which are not currently bound will be gradually added
   * as they are swapped in to reach the provided minimum balances, which must
   * be an amount of tokens worth the minimum weight of the total pool value.
   * If a currently bound token is not received in this call, the token's
   * desired weight will be set to 0.
   */
  function reindexTokens(
    address[] calldata tokens,
    uint96[] calldata desiredDenorms,
    uint256[] calldata minimumBalances
  )
    external
    _lock_
    _control_
  {
    uint256 len = tokens.length;
    require(
      desiredDenorms.length == len && minimumBalances.length == len,
      "ERR_ARR_LEN"
    );
    // This size may not be the same as the input size, as it is possible
    // to temporarily exceed the index size while tokens are being phased in
    // or out.
    uint256 tLen = _tokens.length;
    uint256[] memory receivedIndices = new uint256[](tLen);
    // We need to read token records in two separate loops, so
    // write them to memory to avoid duplicate storage reads.
    Record[] memory records = new Record[](len);
    // Read all the records from storage and mark which of the existing tokens
    // were represented in the reindex call.
    for (uint256 i = 0; i < len; i++) {
      Record memory record = _records[tokens[i]];
      if (record.bound) receivedIndices[record.index] = 1;
      records[i] = record;
    }
    // If any bound tokens were not sent in this call, set their desired weights to 0.
    for (uint256 i = 0; i < tLen; i++) {
      if (receivedIndices[i] == 0) {
        _setDesiredDenorm(_tokens[i], 0);
      }
    }
    for (uint256 i = 0; i < len; i++) {
      address token = tokens[i];
      // If an input weight is less than the minimum weight, use that instead.
      uint96 denorm = desiredDenorms[i];
      if (denorm < MIN_WEIGHT) denorm = uint96(MIN_WEIGHT);
      Record memory record = records[i];
      if (!record.bound) {
        // If the token is not bound, bind it.
        _bind(token, minimumBalances[i], denorm);
      } else {
        _setDesiredDenorm(token, denorm);
      }
    }
  }

  /**
   * @dev Unbinds a token from the pool and sends the remaining balance to the
   * pool controller. This should only be used as a last resort if a token is
   * experiencing a sudden crash or major vulnerability. Otherwise, tokens
   * should only be removed gradually through calls to reweighTokens.
   */
  function unbind(address token) external _lock_ _control_ {
    require(_records[token].bound, "ERR_NOT_BOUND");
    _totalWeight = bsub(_totalWeight, _records[token].denorm);
    _unbind(token);
  }

/* ---  Liquidity Provider Actions  --- */
  function joinPool(uint256 poolAmountOut, uint256[] calldata maxAmountsIn)
    external
    _lock_
    _public_
  {
    uint256 poolTotal = totalSupply();
    uint256 ratio = bdiv(poolAmountOut, poolTotal);
    require(ratio != 0, "ERR_MATH_APPROX");
    require(maxAmountsIn.length == _tokens.length, "ERR_ARR_LEN");
    for (uint256 i = 0; i < maxAmountsIn.length; i++) {
      address t = _tokens[i];
      (Record memory record, uint256 realBalance) = _getInputToken(t);
      uint256 tokenAmountIn = bmul(ratio, record.balance);
      require(tokenAmountIn != 0, "ERR_MATH_APPROX");
      require(tokenAmountIn <= maxAmountsIn[i], "ERR_LIMIT_IN");
      _updateBalanceIn(t, record, badd(realBalance, tokenAmountIn));
      emit LOG_JOIN(msg.sender, t, tokenAmountIn);
      _pullUnderlying(t, msg.sender, tokenAmountIn);
    }
    _mintPoolShare(poolAmountOut);
    _pushPoolShare(msg.sender, poolAmountOut);
  }

  function exitPool(uint256 poolAmountIn, uint256[] calldata minAmountsOut)
    external
    _lock_
  {
    uint256 poolTotal = totalSupply();
    uint256 exitFee = bmul(poolAmountIn, EXIT_FEE);
    uint256 pAiAfterExitFee = bsub(poolAmountIn, exitFee);
    uint256 ratio = bdiv(pAiAfterExitFee, poolTotal);
    require(ratio != 0, "ERR_MATH_APPROX");

    _pullPoolShare(msg.sender, poolAmountIn);
    _pushPoolShare(_factory, exitFee);
    _burnPoolShare(pAiAfterExitFee);
    require(minAmountsOut.length == _tokens.length, "ERR_ARR_LEN");
    for (uint256 i = 0; i < minAmountsOut.length; i++) {
      address t = _tokens[i];
      Record memory record = _records[t];
      if (record.ready) {
        uint256 tokenAmountOut = bmul(ratio, record.balance);
        require(tokenAmountOut != 0, "ERR_MATH_APPROX");
        require(tokenAmountOut >= minAmountsOut[i], "ERR_LIMIT_OUT");

        _records[t].balance = bsub(record.balance, tokenAmountOut);
        emit LOG_EXIT(msg.sender, t, tokenAmountOut);
        _pushUnderlying(t, msg.sender, tokenAmountOut);
      } else {
        // If the token is not initialized, it can not exit the pool.
        require(minAmountsOut[i] == 0, "ERR_OUT_NOT_READY");
      }
    }
  }

  function joinswapExternAmountIn(
    address tokenIn,
    uint256 tokenAmountIn,
    uint256 minPoolAmountOut
  )
    external
    _lock_
    _public_
    returns (uint256 poolAmountOut)
  {
    (Record memory inRecord, uint256 realInBalance) = _getInputToken(tokenIn);

    require(
      tokenAmountIn <= bmul(inRecord.balance, MAX_IN_RATIO),
      "ERR_MAX_IN_RATIO"
    );

    poolAmountOut = calcPoolOutGivenSingleIn(
      inRecord.balance,
      inRecord.denorm,
      _totalSupply,
      _totalWeight,
      tokenAmountIn,
      _swapFee
    );

    require(poolAmountOut >= minPoolAmountOut, "ERR_LIMIT_OUT");

    _updateBalanceIn(tokenIn, inRecord, badd(realInBalance, tokenAmountIn));

    emit LOG_JOIN(msg.sender, tokenIn, tokenAmountIn);

    _mintPoolShare(poolAmountOut);
    _pushPoolShare(msg.sender, poolAmountOut);
    _pullUnderlying(tokenIn, msg.sender, tokenAmountIn);

    return poolAmountOut;
  }

  function joinswapPoolAmountOut(
    address tokenIn,
    uint256 poolAmountOut,
    uint256 maxAmountIn
  )
    external
    _lock_
    _public_
    returns (uint256 tokenAmountIn)
  {
    (Record memory inRecord, uint256 realInBalance) = _getInputToken(tokenIn);

    tokenAmountIn = calcSingleInGivenPoolOut(
      inRecord.balance,
      inRecord.denorm,
      _totalSupply,
      _totalWeight,
      poolAmountOut,
      _swapFee
    );

    require(tokenAmountIn != 0, "ERR_MATH_APPROX");
    require(tokenAmountIn <= maxAmountIn, "ERR_LIMIT_IN");

    require(
      tokenAmountIn <= bmul(inRecord.balance, MAX_IN_RATIO),
      "ERR_MAX_IN_RATIO"
    );

    _updateBalanceIn(tokenIn, inRecord, badd(realInBalance, tokenAmountIn));

    emit LOG_JOIN(msg.sender, tokenIn, tokenAmountIn);

    _mintPoolShare(poolAmountOut);
    _pushPoolShare(msg.sender, poolAmountOut);
    _pullUnderlying(tokenIn, msg.sender, tokenAmountIn);

    return tokenAmountIn;
  }

  function exitswapPoolAmountIn(
    address tokenOut,
    uint256 poolAmountIn,
    uint256 minAmountOut
  )
    external
    _lock_
    returns (uint256 tokenAmountOut)
  {
    Record memory outRecord = _getOutputToken(tokenOut);

    tokenAmountOut = calcSingleOutGivenPoolIn(
      outRecord.balance,
      outRecord.denorm,
      _totalSupply,
      _totalWeight,
      poolAmountIn,
      _swapFee
    );

    require(tokenAmountOut >= minAmountOut, "ERR_LIMIT_OUT");

    require(
      tokenAmountOut <= bmul(outRecord.balance, MAX_OUT_RATIO),
      "ERR_MAX_OUT_RATIO"
    );

    _records[tokenOut].balance = bsub(outRecord.balance, tokenAmountOut);
    _decreaseDenorm(outRecord, tokenOut);
    uint256 exitFee = bmul(poolAmountIn, EXIT_FEE);

    emit LOG_EXIT(msg.sender, tokenOut, tokenAmountOut);

    _pullPoolShare(msg.sender, poolAmountIn);
    _burnPoolShare(bsub(poolAmountIn, exitFee));
    _pushPoolShare(_factory, exitFee);
    _pushUnderlying(tokenOut, msg.sender, tokenAmountOut);

    return tokenAmountOut;
  }

  function exitswapExternAmountOut(
    address tokenOut,
    uint256 tokenAmountOut,
    uint256 maxPoolAmountIn
  )
    external
    _lock_
    returns (uint256 poolAmountIn)
  {
    Record memory outRecord = _getOutputToken(tokenOut);
    require(
      tokenAmountOut <= bmul(outRecord.balance, MAX_OUT_RATIO),
      "ERR_MAX_OUT_RATIO"
    );

    poolAmountIn = calcPoolInGivenSingleOut(
      outRecord.balance,
      outRecord.denorm,
      _totalSupply,
      _totalWeight,
      tokenAmountOut,
      _swapFee
    );

    require(poolAmountIn != 0, "ERR_MATH_APPROX");
    require(poolAmountIn <= maxPoolAmountIn, "ERR_LIMIT_IN");

    _records[tokenOut].balance = bsub(outRecord.balance, tokenAmountOut);

    uint256 exitFee = bmul(poolAmountIn, EXIT_FEE);

    emit LOG_EXIT(msg.sender, tokenOut, tokenAmountOut);

    _pullPoolShare(msg.sender, poolAmountIn);
    _burnPoolShare(bsub(poolAmountIn, exitFee));
    _pushPoolShare(_factory, exitFee);
    _pushUnderlying(tokenOut, msg.sender, tokenAmountOut);

    return poolAmountIn;
  }

/* ---  Token Swaps  --- */

  /**
   * @dev Execute a token swap with a specified amount of input
   * tokens and a minimum amount of output tokens.
   * Note: Will throw if `tokenOut` is uninitialized.
   */
  function swapExactAmountIn(
    address tokenIn,
    uint256 tokenAmountIn,
    address tokenOut,
    uint256 minAmountOut,
    uint256 maxPrice
  )
    external
    _lock_
    _public_
    returns (uint256 tokenAmountOut, uint256 spotPriceAfter)
  {
    (Record memory inRecord, uint256 realInBalance) = _getInputToken(tokenIn);
    Record memory outRecord = _getOutputToken(tokenOut);

    require(
      tokenAmountIn <= bmul(inRecord.balance, MAX_IN_RATIO),
      "ERR_MAX_IN_RATIO"
    );

    tokenAmountOut = calcOutGivenIn(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      tokenAmountIn,
      _swapFee
    );
    require(tokenAmountOut >= minAmountOut, "ERR_LIMIT_OUT");
    _updateBalanceIn(tokenIn, inRecord, badd(realInBalance, tokenAmountIn));
    // If needed, update the output token's weight.
    _decreaseDenorm(outRecord, tokenOut);
    // Update the balance after the weight so that the weight adjustment (if any)
    // can be computed correctly.
    outRecord.balance = bsub(outRecord.balance, tokenAmountOut);
    _records[tokenOut].balance = outRecord.balance;
    // Is there any reason for calculating this?
    // Leaving it in temporarily because the output is used in tests.
    spotPriceAfter = calcSpotPrice(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      _swapFee
    );

    require(spotPriceAfter <= maxPrice, "ERR_LIMIT_PRICE");
    emit LOG_SWAP(msg.sender, tokenIn, tokenOut, tokenAmountIn, tokenAmountOut);

    _pullUnderlying(tokenIn, msg.sender, tokenAmountIn);
    _pushUnderlying(tokenOut, msg.sender, tokenAmountOut);

    return (tokenAmountOut, spotPriceAfter);
  }

  function swapExactAmountOut(
    address tokenIn,
    uint256 maxAmountIn,
    address tokenOut,
    uint256 tokenAmountOut,
    uint256 maxPrice
  )
    external
    _lock_
    _public_
    returns (uint256 tokenAmountIn, uint256 spotPriceAfter)
  {
    (Record memory inRecord, uint256 realInBalance) = _getInputToken(tokenIn);
    Record memory outRecord = _getOutputToken(tokenOut);

    require(
      tokenAmountOut <= bmul(outRecord.balance, MAX_OUT_RATIO),
      "ERR_MAX_OUT_RATIO"
    );

    tokenAmountIn = calcInGivenOut(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      tokenAmountOut,
      _swapFee
    );
    require(tokenAmountIn <= maxAmountIn, "ERR_LIMIT_IN");
    _updateBalanceIn(tokenIn, inRecord, badd(realInBalance, tokenAmountIn));
    
    // Update the in-memory record for the spotPriceAfter calculation,
    // then update the storage record with the local balance.
    _decreaseDenorm(outRecord, tokenOut);
    outRecord.balance = bsub(outRecord.balance, tokenAmountOut);
    _records[tokenOut].balance = outRecord.balance;

    spotPriceAfter = calcSpotPrice(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      _swapFee
    );
    require(spotPriceAfter <= maxPrice, "ERR_LIMIT_PRICE");

    emit LOG_SWAP(msg.sender, tokenIn, tokenOut, tokenAmountIn, tokenAmountOut);

    _pullUnderlying(tokenIn, msg.sender, tokenAmountIn);
    _pushUnderlying(tokenOut, msg.sender, tokenAmountOut);

    return (tokenAmountIn, spotPriceAfter);
  }

/* ---  Config Queries  --- */
  function isPublicSwap() external view returns (bool) {
    return _publicSwap;
  }

  /**
   * @dev There is no `_finalized` variable, so this returns `_publicSwap`.
   */
  function isFinalized() external view returns (bool) {
    return _publicSwap;
  }

  function getSwapFee() external view _viewlock_ returns (uint256) {
    return _swapFee;
  }

  function getController() external view _viewlock_ returns (address) {
    return _controller;
  }

/* ---  Token Queries  --- */
  function isBound(address t) external view returns (bool) {
    return _records[t].bound;
  }

  function getNumTokens() external view returns (uint256) {
    return _tokens.length;
  }

  function getCurrentTokens()
    external
    view
    _viewlock_
    returns (address[] memory tokens)
  {
    return _tokens;
  }

  /**
   * @dev Returns the list of tokens which are not set to
   * be phased out. Tokens with a desired weight of 0 will
   * not be included.
   */
  function getCurrentDesiredTokens()
    external
    view
    _viewlock_
    returns (address[] memory tokens)
  {
    address[] memory tempTokens = _tokens;
    tokens = new address[](tempTokens.length);
    uint256 usedIndex = 0;
    for (uint256 i = 0; i < tokens.length; i++) {
      address token = tempTokens[i];
      Record memory record = _records[token];
      if (record.desiredDenorm > 0) {
        tokens[usedIndex++] = token;
      }
    }
    assembly { mstore(tokens, usedIndex) }
  }

  function getDenormalizedWeight(address token)
    external
    view
    _viewlock_
    returns (uint256)
  {
    require(_records[token].bound, "ERR_NOT_BOUND");
    return _records[token].denorm;
  }

  function getTokenRecord(address token)
    external
    view
    _viewlock_
    returns (Record memory record)
  {
    record = _records[token];
    require(record.bound, "ERR_NOT_BOUND");
  }

  /**
   * @dev Returns the address of the token at a specific index 
   * and the pool value in that token according to its portion
   * of the total weight. This takes an index rather than a
   * token address because it is primarily used in a function
   * on the controller which needs a reliable way to assess a
   * rough valuation for the pool.
   */
  function getPoolValueByTokenIndex(uint256 index)
    external
    view
    returns (address token, uint256 vbal)
  {
    token = _tokens[index];
    Record memory record = _records[token];
    vbal = bmul(record.balance, bdiv(_totalWeight, record.denorm));
  }

  function getTotalDenormalizedWeight()
    external
    view
    _viewlock_
    returns (uint256)
  {
    return _totalWeight;
  }

  function getBalance(address token)
    external
    view
    _viewlock_
    returns (uint256)
  {
    // This does not return the minimum balance for uninitialized
    // tokens because the actual internal balance stored may be
    // relevant.
    require(_records[token].bound, "ERR_NOT_BOUND");
    return _records[token].balance;
  }

  function getMinimumBalance(address token)
    external
    view
    _viewlock_
    returns (uint256)
  {
    require(!_records[token].ready, "ERR_READY");
    return _minimumBalances[token];
  }

/* ---  Price Queries  --- */
  function getSpotPrice(address tokenIn, address tokenOut)
    external
    view
    _viewlock_
    returns (uint256 spotPrice)
  {
    Record memory inRecord = _records[tokenIn];
    Record memory outRecord = _records[tokenOut];
    require(inRecord.bound && outRecord.bound, "ERR_NOT_BOUND");
    require(outRecord.ready, "ERR_OUT_NOT_READY");
    if (!inRecord.ready) {
      inRecord.denorm = uint96(MIN_WEIGHT);
      inRecord.balance = _minimumBalances[tokenIn];
    }
    return
      calcSpotPrice(
        inRecord.balance,
        inRecord.denorm,
        outRecord.balance,
        outRecord.denorm,
        _swapFee
      );
  }

  function getSpotPriceSansFee(address tokenIn, address tokenOut)
    external
    view
    _viewlock_
    returns (uint256 spotPrice)
  {
    Record memory inRecord = _records[tokenIn];
    Record memory outRecord = _records[tokenOut];
    require(inRecord.bound, "ERR_NOT_BOUND");
    require(outRecord.bound, "ERR_NOT_BOUND");
    require(outRecord.ready, "ERR_OUT_NOT_READY");
    if (!inRecord.ready) {
      inRecord.denorm = uint96(MIN_WEIGHT);
      inRecord.balance = _minimumBalances[tokenIn];
    }
    return
      calcSpotPrice(
        inRecord.balance,
        inRecord.denorm,
        outRecord.balance,
        outRecord.denorm,
        0
      );
  }

/* ---  Pool Share Internal Functions  --- */

  function _pullPoolShare(address from, uint256 amount) internal {
    _pull(from, amount);
  }

  function _pushPoolShare(address to, uint256 amount) internal {
    _push(to, amount);
  }

  function _mintPoolShare(uint256 amount) internal {
    _mint(amount);
  }

  function _burnPoolShare(uint256 amount) internal {
    _burn(amount);
  }

/* ---  Underlying Token Internal Functions  --- */
  // 'Underlying' token-manipulation functions make external calls but are NOT locked
  // You must `_lock_` or otherwise ensure reentry-safety

  function _pullUnderlying(
    address erc20,
    address from,
    uint256 amount
  ) internal {
    bool xfer = IERC20(erc20).transferFrom(from, address(this), amount);
    require(xfer, "ERR_ERC20_FALSE");
  }

  function _pushUnderlying(
    address erc20,
    address to,
    uint256 amount
  ) internal {
    bool xfer = IERC20(erc20).transfer(to, amount);
    require(xfer, "ERR_ERC20_FALSE");
  }

/* ---  Token Management Internal Functions  --- */
  /**
   * @dev Bind a token by address without actually depositing a balance.
   * The token will be unable to be swapped out until it reaches the minimum balance.
   * Note: Token must not already be bound.
   * Note: `minimumBalance` should represent an amount of the token which is worth
   * the portion of the current pool value represented by the minimum weight.
   * @param token Address of the token to bind
   * @param minimumBalance minimum balance to reach before the token can be swapped out
   * @param desiredDenorm Desired weight for the token.
   */
  function _bind(
    address token,
    uint256 minimumBalance,
    uint96 desiredDenorm
  ) internal {
    require(!_records[token].bound, "ERR_IS_BOUND");

    require(desiredDenorm >= MIN_WEIGHT, "ERR_MIN_WEIGHT");
    require(desiredDenorm <= MAX_WEIGHT, "ERR_MAX_WEIGHT");
    require(minimumBalance >= MIN_BALANCE, "ERR_MIN_BALANCE");

    _records[token] = Record({
      bound: true,
      ready: false,
      lastDenormUpdate: 0,
      denorm: 0,
      desiredDenorm: desiredDenorm,
      index: uint8(_tokens.length),
      balance: 0
    });
    _tokens.push(token);
    _minimumBalances[token] = minimumBalance;
    emit LOG_TOKEN_ADDED(token, desiredDenorm, minimumBalance);
  }

  /**
   * @dev Remove a token from the pool.
   * Replaces the address in the tokens array with the last address,
   * then removes it from the array.
   * Note: This should only be called after the total weight has been adjusted.
   * Note: Must be called in a function with:
   * - _lock_ modifier to prevent reentrance
   * - requirement that the token is bound
   */
  function _unbind(address token) internal {
    Record memory record = _records[token];
    uint256 tokenBalance = record.balance;

    // Swap the token-to-unbind with the last token,
    // then delete the last token
    uint256 index = record.index;
    uint256 last = _tokens.length - 1;
    // Only swap the token with the last token if it is not
    // already at the end of the array.
    if (index != last) {
      _tokens[index] = _tokens[last];
      _records[_tokens[index]].index = uint8(index);
    }
    _tokens.pop();
    _records[token] = Record({
      bound: false,
      ready: false,
      lastDenormUpdate: 0,
      denorm: 0,
      desiredDenorm: 0,
      index: 0,
      balance: 0
    });
    // transfer any remaining tokens out
    _pushUnderlying(token, _controller, tokenBalance);
    emit LOG_TOKEN_REMOVED(token);
  }

  function _setDesiredDenorm(address token, uint96 desiredDenorm) internal {
    Record memory record = _records[token];
    require(record.bound, "ERR_NOT_BOUND");
    // If the desired weight is 0, this will trigger a gradual unbinding of the token.
    // Therefore the weight only needs to be above the minimum weight if it isn't 0.
    require(
      desiredDenorm >= MIN_WEIGHT || desiredDenorm == 0,
      "ERR_MIN_WEIGHT"
    );
    require(desiredDenorm <= MAX_WEIGHT, "ERR_MAX_WEIGHT");
    record.desiredDenorm = desiredDenorm;
    _records[token].desiredDenorm = desiredDenorm;
    emit LOG_DESIRED_DENORM_SET(token, desiredDenorm);
  }

  function _increaseDenorm(Record memory record, address token) internal {
    // If the weight does not need to increase or the token is not
    // initialized, don't do anything.
    if (
      record.denorm >= record.desiredDenorm ||
      !record.ready ||
      now - record.lastDenormUpdate < WEIGHT_UPDATE_DELAY
    ) return;
    uint96 oldWeight = record.denorm;
    uint96 denorm = record.desiredDenorm;
    uint256 maxDiff = bmul(oldWeight, _swapFee / 2);
    uint256 diff = bsub(denorm, oldWeight);
    if (diff > maxDiff) {
      denorm = uint96(badd(oldWeight, maxDiff));
      diff = maxDiff;
    }
    _totalWeight = badd(_totalWeight, diff);
    require(_totalWeight <= MAX_TOTAL_WEIGHT, "ERR_MAX_TOTAL_WEIGHT");
    // Update the in-memory denorm value for spot-price computations.
    record.denorm = denorm;
    // Update the storage record
    _records[token].denorm = denorm;
    _records[token].lastDenormUpdate = uint40(now);
    emit LOG_DENORM_UPDATED(token, denorm);
  }

  function _decreaseDenorm(Record memory record, address token) internal {
    // If the weight does not need to decrease, don't do anything.
    if (
      record.denorm <= record.desiredDenorm ||
      !record.ready ||
      now - record.lastDenormUpdate < WEIGHT_UPDATE_DELAY
    ) return;
    uint96 oldWeight = record.denorm;
    uint96 denorm = record.desiredDenorm;
    uint256 maxDiff = bmul(oldWeight, _swapFee / 2);
    uint256 diff = bsub(oldWeight, denorm);
    if (diff > maxDiff) {
      denorm = uint96(bsub(oldWeight, maxDiff));
      diff = maxDiff;
    }
    if (denorm <= MIN_WEIGHT) {
      denorm = 0;
      _totalWeight = bsub(_totalWeight, denorm);
      // Because this is removing the token from the pool, the
      // in-memory denorm value is irrelevant, as it is only used
      // to calculate the new spot price, but the spot price calc
      // will throw if it is passed 0 for the denorm.
      _unbind(token);
    } else {
      _totalWeight = bsub(_totalWeight, diff);
      // Update the in-memory denorm value for spot-price computations.
      record.denorm = denorm;
      // Update the stored denorm value
      _records[token].denorm = denorm;
      _records[token].lastDenormUpdate = uint40(now);
    }
    emit LOG_DENORM_UPDATED(token, denorm);
  }

/* ---  Token Query Internal Functions  --- */
  /**
   * @dev Get the record for a token which is being swapped in.
   * The token must be bound to the pool. If the token is not
   * initialized (meaning it does not have the minimum balance)
   * this function will return the actual balance of the token
   * which the pool holds, but set the record's balance and weight
   * to the token's minimum balance and the pool's minimum weight.
   * This allows the token swap to be priced correctly even if the
   * pool does not own any of the tokens.
   */
  function _getInputToken(address token)
    internal
    view
    returns (Record memory record, uint256 realBalance)
  {
    record = _records[token];
    require(record.bound, "ERR_NOT_BOUND");

    realBalance = record.balance;
    // If the input token is not initialized, we use the minimum
    // initial weight and minimum initial balance instead of the
    // real values for price and output calculations.
    if (!record.ready) {
      record.balance = _minimumBalances[token];
      record.denorm = uint96(MIN_WEIGHT);
    }
  }

  function _getOutputToken(address token)
    internal
    view
    returns (Record memory record)
  {
    record = _records[token];
    require(record.bound, "ERR_NOT_BOUND");
    // Tokens which have not reached their minimum balance can not be
    // swapped out.
    require(record.ready, "ERR_OUT_NOT_READY");
  }

  /**
   * @dev Handle the balance increase for an input token.
   *
   * If the token is not initialized and the new balance is
   * still below the minimum, this will only store the new
   * balance.
   *
   * If the token is not initialized but the new balance will
   * bring the token above the minimum balance, this will
   * mark the token as initialized, remove the minimum
   * balance and set the weight to the minimum weight plus
   * 1.25%.
   *
   * If the token is already initialized, this will only store
   * the new balance and execute a weight increase if one is ready.
   *
   * @param token Address of the input token
   * @param record Token record with minimums applied to the balance
   * and weight if the token was uninitialized.
   */
  function _updateBalanceIn(
    address token,
    Record memory record,
    uint256 realBalance
  )
    internal
  {
    if (!record.ready) {
      // Check if the minimum balance has been reached
      if (realBalance >= record.balance) {
        // Remove the minimum balance record
        _minimumBalances[token] = 0;
        // Mark the token as initialized
        _records[token].ready = true;
        record.ready = true;
        // Since the denorm value in the uninitialized storage record is still 0,
        // the total weight has not absorbed the in-memory weight we are using
        // for price calculations.
        _totalWeight = badd(_totalWeight, MIN_WEIGHT);
        // _increaseDenorm will set the weight to the minimum plus 1.25%
        // This _increaseDenorm call will never fail to execute because of the
        // lastDenormUpdate, as it is set to 0 when the token is bound, and
        // this condition is only ever met when a token is newly bound
        _increaseDenorm(record, token);
      }

      // If the token is still not ready, do not adjust the in-memory weight or balance,
      // but do update the stored balance.
    } else {
      // If the token is already initialized, update the weight (if any adjustment
      // is needed) and increase the in-memory balance.
      _increaseDenorm(record, token);
      record.balance = realBalance;
    }
    // Regardless of whether the token is initialized, store the actual new balance.
    // This may not be the same as the in-memory balance.
    _records[token].balance = realBalance;
  }
}