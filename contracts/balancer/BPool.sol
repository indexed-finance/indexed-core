// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;


import "@nomiclabs/buidler/console.sol";
import "./BToken.sol";
import "./BMath.sol";


/**
 * @title BPoolBase
 * @dev Defines the data structures, storage, events and initializer
 * for the BPool contract.
 */
contract BPoolBase is BBronze, BToken, BMath {
  /**
   * @dev Token record data structure
   * @param bound is token bound to pool
   * @param lastDenormUpdate timestamp of last weight change
   * @param denorm denormalized weight
   * @param desiredDenorm desired denormalized weight (used for incremental changes)
   * @param index index of address in tokens array
   * @param balance token balance
   */
  struct Record {
    bool bound;
    uint48 lastDenormUpdate;
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

  event LOG_CALL(bytes4 indexed sig, address indexed caller, bytes data);

  modifier _logs_() {
    emit LOG_CALL(msg.sig, msg.sender, msg.data);
    _;
  }

  modifier _lock_() {
    require(!_mutex, "ERR_REENTRY");
    _mutex = true;
    _;
    _mutex = false;
  }

  modifier _viewlock_() {
    require(!_mutex, "ERR_REENTRY");
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
  mapping(address => Record) internal _records;
  uint256 internal _totalWeight;

  function initialize(
    address controller,
    string calldata name,
    string calldata symbol,
    address[] calldata tokens,
    uint256[] calldata balances,
    uint96[] calldata denorms
  )
    external
  {
    require(
      _controller == address(0) &&
      controller != address(0),
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
    require(
      balances.length == len &&
      denorms.length == len,
      "ERR_ARR_LEN"
    );
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
        lastDenormUpdate: uint48(now),
        denorm: denorm,
        desiredDenorm: denorm,
        index: uint8(_tokens.length),
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

  // Absorb any tokens that have been sent to this contract into the pool
  function gulp(address token) external _logs_ _lock_ {
    require(_records[token].bound, "ERR_NOT_BOUND");
    _records[token].balance = IERC20(token).balanceOf(address(this));
  }

  /* <-- Swap Actions --> */
  function swapExactAmountIn(
    address tokenIn,
    uint256 tokenAmountIn,
    address tokenOut,
    uint256 minAmountOut,
    uint256 maxPrice
  )
    external
    _logs_
    _lock_
    returns (uint256 tokenAmountOut, uint256 spotPriceAfter)
  {
    require(_records[tokenIn].bound, "ERR_NOT_BOUND");
    require(_records[tokenOut].bound, "ERR_NOT_BOUND");
    require(_publicSwap, "ERR_SWAP_NOT_PUBLIC");

    Record memory inRecord = _records[address(tokenIn)];
    Record memory outRecord = _records[address(tokenOut)];

    require(
      tokenAmountIn <= bmul(inRecord.balance, MAX_IN_RATIO),
      "ERR_MAX_IN_RATIO"
    );
    uint256 spotPriceBefore = calcSpotPrice(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      _swapFee
    );
    require(spotPriceBefore <= maxPrice, "ERR_BAD_LIMIT_PRICE");

    tokenAmountOut = calcOutGivenIn(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      tokenAmountIn,
      _swapFee
    );
    require(tokenAmountOut >= minAmountOut, "ERR_LIMIT_OUT");
    // Update the in-memory record for the spotPriceAfter calculation,
    // then update the storage record with the local balance.
    inRecord.balance = badd(inRecord.balance, tokenAmountIn);
    _records[address(tokenIn)].balance = inRecord.balance;
    outRecord.balance = bsub(outRecord.balance, tokenAmountOut);
    _records[address(tokenOut)].balance = outRecord.balance;

    bool didUpdateIn = _updateDenorm(inRecord, address(tokenIn));
    bool didUpdateOut = _updateDenorm(outRecord, address(tokenOut));
    bool didUpdate = didUpdateIn || didUpdateOut;

    spotPriceAfter = calcSpotPrice(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      _swapFee
    );
    // Only validate the resulting spot price if the weights did not change.
    require(didUpdate || spotPriceAfter >= spotPriceBefore, "ERR_MATH_APPROX");
    require(spotPriceAfter <= maxPrice, "ERR_LIMIT_PRICE");
    require(
      spotPriceBefore <= bdiv(tokenAmountIn, tokenAmountOut),
      "ERR_MATH_APPROX"
    );

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
    _logs_
    _lock_
    returns (uint256 tokenAmountIn, uint256 spotPriceAfter)
  {
    require(_records[tokenIn].bound, "ERR_NOT_BOUND");
    require(_records[tokenOut].bound, "ERR_NOT_BOUND");
    require(_publicSwap, "ERR_SWAP_NOT_PUBLIC");

    Record memory inRecord = _records[address(tokenIn)];
    Record memory outRecord = _records[address(tokenOut)];

    require(
      tokenAmountOut <= bmul(outRecord.balance, MAX_OUT_RATIO),
      "ERR_MAX_OUT_RATIO"
    );

    uint256 spotPriceBefore = calcSpotPrice(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      _swapFee
    );
    require(spotPriceBefore <= maxPrice, "ERR_BAD_LIMIT_PRICE");

    tokenAmountIn = calcInGivenOut(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      tokenAmountOut,
      _swapFee
    );
    require(tokenAmountIn <= maxAmountIn, "ERR_LIMIT_IN");

    // Update the in-memory record for the spotPriceAfter calculation,
    // then update the storage record with the local balance.
    inRecord.balance = badd(inRecord.balance, tokenAmountIn);
    _records[address(tokenIn)].balance = inRecord.balance;
    outRecord.balance = bsub(outRecord.balance, tokenAmountOut);
    _records[address(tokenOut)].balance = outRecord.balance;

    bool didUpdate = (
      _updateDenorm(inRecord, address(tokenIn)) &&
      _updateDenorm(outRecord, address(tokenOut))
    );

    spotPriceAfter = calcSpotPrice(
      inRecord.balance,
      inRecord.denorm,
      outRecord.balance,
      outRecord.denorm,
      _swapFee
    );
    // Only validate the resulting spot price if the weights did not change.
    require(didUpdate || spotPriceAfter >= spotPriceBefore, "ERR_MATH_APPROX");
    require(spotPriceAfter <= maxPrice, "ERR_LIMIT_PRICE");
    require(
      spotPriceBefore <= bdiv(tokenAmountIn, tokenAmountOut),
      "ERR_MATH_APPROX"
    );

    emit LOG_SWAP(msg.sender, tokenIn, tokenOut, tokenAmountIn, tokenAmountOut);

    _pullUnderlying(tokenIn, msg.sender, tokenAmountIn);
    _pushUnderlying(tokenOut, msg.sender, tokenAmountOut);

    return (tokenAmountIn, spotPriceAfter);
  }

  /* <-- Pool Share Internal Functions --> */
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

  /* <-- Underlying Token Internal Functions --> */
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

  /* <-- Token Binding Internal Functions --> */
  /**
   * @dev Directly bind a token by address.
   * Note: Token must not already be bound.
   * Note: `balance` must be a valid balance and denorm must be a valid denormalized weight.
   * Note: `balance` should match the weight which will immediately be set, i.e. max()
   */
  function _bind(
    address token,
    uint256 balance,
    uint96 denorm
  ) internal {
    require(!_records[token].bound, "ERR_IS_BOUND");

    require(denorm >= MIN_WEIGHT, "ERR_MIN_WEIGHT");
    require(denorm <= MAX_WEIGHT, "ERR_MAX_WEIGHT");
    require(balance >= MIN_BALANCE, "ERR_MIN_BALANCE");

    require(_tokens.length < MAX_BOUND_TOKENS, "ERR_MAX_TOKENS");
    _records[token] = Record({
      bound: true,
      lastDenormUpdate: uint48(now),
      denorm: denorm,
      desiredDenorm: denorm,
      index: uint8(_tokens.length),
      balance: balance
    });
    _tokens.push(token);
    uint256 totalWeight = badd(_totalWeight, denorm);
    require(totalWeight <= MAX_TOTAL_WEIGHT, "ERR_MAX_TOTAL_WEIGHT");
    _totalWeight = totalWeight;
    _pullUnderlying(token, msg.sender, balance);
  }

  function _setDesiredDenorm(address token, uint96 desiredDenorm) internal {
    Record memory record = _records[token];
    require(record.bound, "ERR_NOT_BOUND");
    // If the desired weight is 0, this will trigger a gradual unbinding of the token.
    // Therefore the weight only needs to be greater than the minimum weight if it isn't 0.
    require(desiredDenorm >= MIN_WEIGHT || desiredDenorm == 0, "ERR_MIN_WEIGHT");
    require(desiredDenorm <= MAX_WEIGHT, "ERR_MAX_WEIGHT");
    record.desiredDenorm = desiredDenorm;
    _records[token].desiredDenorm = desiredDenorm;
    _updateDenorm(record, token);
  }

  /**
   * @dev Executes the logic to remove a token:
   * Replaces the address in the tokens array with the last address,
   * then removes it from the array.
   * Note: This should only be called after the total weight has been adjusted.
   * Note: Must be called in a function with:
   * - _lock_ modifier to prevent reentrance
   * - requirement that the token is bound
   */
  function _onUnbind(address token) internal {
    Record memory record = _records[token];
    uint256 tokenBalance = record.balance;
    uint256 tokenExitFee = bmul(tokenBalance, EXIT_FEE);

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
      lastDenormUpdate: 0,
      denorm: 0,
      desiredDenorm: 0,
      index: 0,
      balance: 0
    });
    // transfer any remaining tokens out
    _pushUnderlying(token, msg.sender, bsub(tokenBalance, tokenExitFee));
    _pushUnderlying(token, _factory, tokenExitFee);
  }

  /**
   * @dev Move a record's denorm value closer to its desired denorm.
   * Note: Does not verify that the record is bound.
   */
  function _updateDenorm(Record memory record, address token)
    internal
    returns (bool didUpdate)
  {
    // Don't do anything if there's no change ready.
    if (
      record.desiredDenorm == record.denorm ||
      now - record.lastDenormUpdate < MIN_WEIGHT_DELAY
    ) return false;
    uint96 oldWeight = record.denorm;

    uint256 maxDiff = bmul(oldWeight, _swapFee);
    uint96 denorm = record.desiredDenorm;
    // Restrict the proportional weight change to swapFee
    // Adjust the denorm and totalWeight
    if (denorm > oldWeight) {
      uint256 diff = bsub(denorm, oldWeight);
      if (oldWeight != 0 && diff > maxDiff) {
        denorm = uint96(badd(oldWeight, maxDiff));
        diff = maxDiff;
      }
      _totalWeight = badd(_totalWeight, diff);
      require(_totalWeight <= MAX_TOTAL_WEIGHT, "ERR_MAX_TOTAL_WEIGHT");
    } else {
      uint256 diff = bsub(oldWeight, denorm);
      if (diff > maxDiff) {
        denorm = uint96(bsub(oldWeight, maxDiff));
        diff = maxDiff;
      }
      _totalWeight = bsub(_totalWeight, diff);
      // Don't need to verify total weight since it is decreasing
    }

    // If the new weight is 0, unbind it.
    if (denorm == 0) {
      _onUnbind(token);
    } else {
      // Update the in-memory denorm value, because it is needed in some functions
      // the timestamp is never needed within the contract.
      record.denorm = denorm;
      // Update the storage record
      _records[token].denorm = denorm;
      _records[token].lastDenormUpdate = uint48(now);
    }
    return true;
  }
}


/**
 * @title BPoolQueries
 * @dev Defines the BPool external query functions.
 */
contract BPoolQueries is BPoolBase {
  /* <-- Meta Queries --> */
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

  /* <-- Token Queries --> */
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

  function getTotalDenormalizedWeight()
    external
    view
    _viewlock_
    returns (uint256)
  {
    return _totalWeight;
  }

  function getNormalizedWeight(address token)
    external
    view
    _viewlock_
    returns (uint256)
  {
    require(_records[token].bound, "ERR_NOT_BOUND");
    uint256 denorm = _records[token].denorm;
    return bdiv(denorm, _totalWeight);
  }

  function getBalance(address token)
    external
    view
    _viewlock_
    returns (uint256)
  {
    require(_records[token].bound, "ERR_NOT_BOUND");
    return _records[token].balance;
  }

  /* <-- Price Queries --> */
  function getSpotPrice(address tokenIn, address tokenOut)
    external
    view
    _viewlock_
    returns (uint256 spotPrice)
  {
    require(_records[tokenIn].bound, "ERR_NOT_BOUND");
    require(_records[tokenOut].bound, "ERR_NOT_BOUND");
    Record storage inRecord = _records[tokenIn];
    Record storage outRecord = _records[tokenOut];
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
    require(_records[tokenIn].bound, "ERR_NOT_BOUND");
    require(_records[tokenOut].bound, "ERR_NOT_BOUND");
    Record storage inRecord = _records[tokenIn];
    Record storage outRecord = _records[tokenOut];
    return
      calcSpotPrice(
        inRecord.balance,
        inRecord.denorm,
        outRecord.balance,
        outRecord.denorm,
        0
      );
  }
}


/**
 * @title BPoolShares
 * @dev Defines the functions for joining and exiting the pool.
 */
contract BPoolShares is BPoolBase {
  /* <-- Liquidity Provider Actions --> */
  function joinPool(uint256 poolAmountOut, uint256[] calldata maxAmountsIn)
    external
    _logs_
    _lock_
  {
    require(_publicSwap, "ERR_JOIN_NOT_PUBLIC");
    uint256 poolTotal = totalSupply();
    uint256 ratio = bdiv(poolAmountOut, poolTotal);
    require(ratio != 0, "ERR_MATH_APPROX");

    for (uint256 i = 0; i < _tokens.length; i++) {
      address t = _tokens[i];
      uint256 bal = _records[t].balance;
      uint256 tokenAmountIn = bmul(ratio, bal);
      require(tokenAmountIn != 0, "ERR_MATH_APPROX");
      require(tokenAmountIn <= maxAmountsIn[i], "ERR_LIMIT_IN");
      _records[t].balance = badd(_records[t].balance, tokenAmountIn);
      emit LOG_JOIN(msg.sender, t, tokenAmountIn);
      _pullUnderlying(t, msg.sender, tokenAmountIn);
    }
    _mintPoolShare(poolAmountOut);
    _pushPoolShare(msg.sender, poolAmountOut);
  }

  function exitPool(uint256 poolAmountIn, uint256[] calldata minAmountsOut)
    external
    _logs_
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

    for (uint256 i = 0; i < _tokens.length; i++) {
      address t = _tokens[i];
      uint256 bal = _records[t].balance;
      uint256 tokenAmountOut = bmul(ratio, bal);
      require(tokenAmountOut != 0, "ERR_MATH_APPROX");
      require(tokenAmountOut >= minAmountsOut[i], "ERR_LIMIT_OUT");
      _records[t].balance = bsub(_records[t].balance, tokenAmountOut);
      emit LOG_EXIT(msg.sender, t, tokenAmountOut);
      _pushUnderlying(t, msg.sender, tokenAmountOut);
    }
  }

  function joinswapExternAmountIn(
    address tokenIn,
    uint256 tokenAmountIn,
    uint256 minPoolAmountOut
  ) external _logs_ _lock_ returns (uint256 poolAmountOut) {
    require(_publicSwap, "ERR_JOIN_NOT_PUBLIC");
    require(_records[tokenIn].bound, "ERR_NOT_BOUND");
    require(
      tokenAmountIn <= bmul(_records[tokenIn].balance, MAX_IN_RATIO),
      "ERR_MAX_IN_RATIO"
    );
    Record storage inRecord = _records[tokenIn];

    poolAmountOut = calcPoolOutGivenSingleIn(
      inRecord.balance,
      inRecord.denorm,
      _totalSupply,
      _totalWeight,
      tokenAmountIn,
      _swapFee
    );

    require(poolAmountOut >= minPoolAmountOut, "ERR_LIMIT_OUT");

    inRecord.balance = badd(inRecord.balance, tokenAmountIn);

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
  ) external _logs_ _lock_ returns (uint256 tokenAmountIn) {
    require(_publicSwap, "ERR_JOIN_NOT_PUBLIC");
    require(_records[tokenIn].bound, "ERR_NOT_BOUND");

    Record storage inRecord = _records[tokenIn];

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
      tokenAmountIn <= bmul(_records[tokenIn].balance, MAX_IN_RATIO),
      "ERR_MAX_IN_RATIO"
    );

    inRecord.balance = badd(inRecord.balance, tokenAmountIn);

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
  ) external _logs_ _lock_ returns (uint256 tokenAmountOut) {
    require(_records[tokenOut].bound, "ERR_NOT_BOUND");

    Record storage outRecord = _records[tokenOut];

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
      tokenAmountOut <= bmul(_records[tokenOut].balance, MAX_OUT_RATIO),
      "ERR_MAX_OUT_RATIO"
    );

    outRecord.balance = bsub(outRecord.balance, tokenAmountOut);

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
  ) external _logs_ _lock_ returns (uint256 poolAmountIn) {
    require(_records[tokenOut].bound, "ERR_NOT_BOUND");
    require(
      tokenAmountOut <= bmul(_records[tokenOut].balance, MAX_OUT_RATIO),
      "ERR_MAX_OUT_RATIO"
    );

    Record storage outRecord = _records[tokenOut];

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

    outRecord.balance = bsub(outRecord.balance, tokenAmountOut);

    uint256 exitFee = bmul(poolAmountIn, EXIT_FEE);

    emit LOG_EXIT(msg.sender, tokenOut, tokenAmountOut);

    _pullPoolShare(msg.sender, poolAmountIn);
    _burnPoolShare(bsub(poolAmountIn, exitFee));
    _pushPoolShare(_factory, exitFee);
    _pushUnderlying(tokenOut, msg.sender, tokenAmountOut);

    return poolAmountIn;
  }
}


/**
 * @title BPoolControls
 * @dev Defines the pool management functions.
 */
contract BPoolControls is BPoolShares {
  /* <-- Configuration Actions --> */
  function setSwapFee(uint256 swapFee) external _logs_ _lock_ {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    require(swapFee >= MIN_FEE, "ERR_MIN_FEE");
    require(swapFee <= MAX_FEE, "ERR_MAX_FEE");
    _swapFee = swapFee;
  }

  /**
   * @dev Public swapping is enabled as soon as tokens are bound,
   * but this function exists in case of an emergency.
   */
  function setPublicSwap(bool public_) external _logs_ _lock_ {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    _publicSwap = public_;
  }

  /**
   * @dev Sets the desired weights for the pool tokens
   * and executes the first weight adjustment.
   */
  function reweighTokens(
    address[] calldata tokens,
    uint96[] calldata desiredDenorms
  )
    external
    _logs_
    _lock_
  {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    uint256 len = tokens.length;
    require(desiredDenorms.length == len, "ERR_ARR_LEN");
    for (uint256 i = 0; i < len; i++) _setDesiredDenorm(tokens[i], desiredDenorms[i]);
  }

  /**
   * @dev Unbinds a token from the pool.
   * Note: Should only be used as a last resort if a token is experiencing
   * a sudden crash or major vulnerability. Otherwise, the token should be
   * gradually removed using `setDesiredDenorm` with desiredDenorm = 0.
   */
  function unbind(address token) external _logs_ _lock_ {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    require(_records[token].bound, "ERR_NOT_BOUND");

    _totalWeight = bsub(_totalWeight, _records[token].denorm);
    _onUnbind(token);
  }
}


contract BPool is BPoolQueries, BPoolShares, BPoolControls {}