pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import {
  UniswapV2OracleLibrary as UniV2Oracle
} from "./lib/UniswapV2OracleLibrary.sol";
import "./openzeppelin/SafeMath.sol";
import "./interfaces/IERC20.sol";
import { UniswapV2Library as UniV2 } from "./lib/UniswapV2Library.sol";
import { IUniswapV2Router02 as UniV2Router } from "./interfaces/IUniswapV2Router02.sol";
import { SafeERC20 } from "./openzeppelin/SafeERC20.sol";
import { IPool } from "./balancer/IPool.sol";


contract PoolInitializer {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

/* ---  Constants  --- */

  // Delay between price updates
  uint256 internal constant UPDATE_DELAY = 1 hours;
  uint256 internal constant MINIMUM_PRICE_AGE = UPDATE_DELAY / 2;

  UniV2Router internal immutable _uniswapRouter;
  address internal immutable _uniswapFactory;
  address internal immutable _weth;

/* ---  Structs  --- */

  struct PriceObservation {
    uint32 timestamp;
    uint224 priceCumulativeLast;
  }

/* ---  Events  --- */

  event PriceUpdated(
    address token,
    uint224 priceCumulativeLast
  );

  event TokensContributed(
    address from,
    address token,
    uint256 amount,
    uint256 credit
  );

/* ---  Storage  --- */

  // Price observations per token
  mapping(address => PriceObservation) internal _lastPriceObservation;
  // Token amounts to purchase
  mapping(address => uint256) internal _remainingDesiredAmounts;
  // Value contributed in ether
  mapping(address => uint256) internal _credits;
  address[] internal _tokens;
  // Total value in ether contributed to the pool, computed at the time
  // of receipt.
  uint256 public totalCredit;
  // Whether all the desired tokens have been received.
  bool public finished;
  // Address that can withdraw tokens and set desired purchases.
  address internal _controller;
  address internal _poolAddress;
  bool internal _mutex;
  uint256 internal constant TOKENS_MINTED = 100e18;

/* ---  Modifiers  --- */

  modifier _lock_ {
    require(!_mutex, "ERR_REENTRY");
    _mutex = true;
    _;
    _mutex = false;
  }

  modifier _control_ {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    _;
  }

  modifier _finished_ {
    require(finished, "ERR_NOT_FINISHED");
    _;
  }

  modifier _not_finished_ {
    require(!finished, "ERR_FINISHED");
    _;
  }

/* ---  Constructor  --- */

  constructor(
    address uniswapFactory,
    UniV2Router uniswapRouter,
    address weth
  ) public {
    _uniswapFactory = uniswapFactory;
    _uniswapRouter = uniswapRouter;
    _weth = weth;
  }

/* ---  Start & Finish Functions  --- */

  /**
   * @dev Sets up the pre-deployment pool.
   *
   * @param controller Pool controller
   * @param poolAddress Address of the pool this pre-deployment pool is for
   * @param tokens Array of desired tokens
   * @param amounts Desired amounts of the corresponding `tokens`
   */
  function initialize(
    address controller,
    address poolAddress,
    address[] calldata tokens,
    uint256[] calldata amounts
  )
    external
  {
    require(_controller == address(0), "ERR_INITIALIZED");
    require(controller != address(0), "ERR_NULL_ADDRESS");
    _controller = controller;
    _poolAddress = poolAddress;
    uint256 len = tokens.length;
    require(amounts.length == len, "ERR_ARR_LEN");
    _tokens = tokens;
    for (uint256 i = 0; i < len; i++) {
      _remainingDesiredAmounts[tokens[i]] = amounts[i];
    }
  }
  /**
   * @dev Finishes the pre-deployment pool and triggers pool initialization.
   *
   * Note: The desired amounts of all tokens must be 0.
  */
  function finish()
    external
    _lock_
    _not_finished_
  {
    uint256 len = _tokens.length;
    address controller = _controller;
    address[] memory tokens = new address[](len);
    uint256[] memory balances = new uint256[](len);
    for (uint256 i = 0; i < len; i++) {
      address token = _tokens[i];
      tokens[i] = token;
      uint256 balance = IERC20(token).balanceOf(address(this));
      balances[i] = balance;
      IERC20(token).safeApprove(_poolAddress, balance);
      require(
        _remainingDesiredAmounts[token] == 0,
        "ERR_PENDING_TOKENS"
      );
    }
    PoolController(controller).finishPreparedIndexPool(
      _poolAddress,
      tokens,
      balances
    );
    finished = true;
  }

  /**
   * @dev Claims the tokens owed to `account` based on their proportion
   * of the total credits.
  */
  function claimTokens() external _lock_ _finished_ {
    _claimTokens(msg.sender);
  }

  /**
   * @dev Claims the tokens owed to `account` based on their proportion
   * of the total credits.
  */
  function claimTokens(address account) external _lock_ _finished_ {
    _claimTokens(account);
  }

  /**
   * @dev Claims the tokens owed to `account` based on their proportion
   * of the total credits.
  */
  function claimTokens(address[] calldata accounts) external _lock_ _finished_ {
    for (uint256 i = 0; i < accounts.length; i++) {
      _claimTokens(accounts[i]);
    }
  }

/* ---  Contribution  --- */

  /**
   * @dev Contribute up to `amountIn` of `token` to the pool for credit.
   * The caller will be credited for the average weth value of the provided
   * tokens.
   *
   * Caller must receive at least `minimumCredit` to not revert.
   *
   * If `amountIn` is greater than the desired amount of `token`, the
   * desired amount will be used instead. 
   */
  function contributeTokens(
    address token,
    uint256 amountIn,
    uint256 minimumCredit
  )
    external
    _lock_
    _not_finished_
    returns (uint256 credit)
  {
    uint256 desiredAmount = _remainingDesiredAmounts[token];
    require(desiredAmount > 0, "ERR_NOT_NEEDED");
    if (amountIn > desiredAmount) {
      amountIn = desiredAmount;
    }
    credit = _calcCredit(token, amountIn);
    require(credit > 0 && amountIn > 0, "ERR_ZERO_AMOUNT");
    require(credit >= minimumCredit, "ERR_MIN_CREDIT");
    IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
    _remainingDesiredAmounts[token] = desiredAmount.sub(amountIn);
    _credits[msg.sender] = _credits[msg.sender].add(credit);
    totalCredit = totalCredit.add(credit);
    emit TokensContributed(msg.sender, token, amountIn, credit);
  }

  /**
   * @dev Contribute maximum values from `amountsIn` of the corresponding
   * tokens in `tokens` to the pool for credit.
   *
   * The caller will be credited for the average weth value of the provided
   * tokens.
   *
   * Caller must receive at least `minimumCredit` to not revert.
   *
   * If any input amount is greater than the desired amount of the corresponding
   * token, the desired amount will be used instead.
   */
  function contributeTokens(
    address[] calldata tokens,
    uint256[] calldata amountsIn,
    uint256 minimumCredit
  )
    external
    _lock_
    _not_finished_
    returns (uint256 credit)
  {
    uint256 len = tokens.length;
    require(amountsIn.length == len, "ERR_ARR_LEN");
    credit = 0;
    for (uint256 i = 0; i < len; i++) {
      address token = tokens[i];
      uint256 amountIn = amountsIn[i];
      uint256 desiredAmount = _remainingDesiredAmounts[token];
      require(desiredAmount > 0, "ERR_NOT_NEEDED");
      if (amountIn > desiredAmount) {
        amountIn = desiredAmount;
      }
      uint256 creditOut = _calcCredit(token, amountIn);
      require(creditOut > 0 && amountIn > 0, "ERR_ZERO_AMOUNT");
      IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
      _remainingDesiredAmounts[token] = desiredAmount.sub(amountIn);
      credit = credit.add(creditOut);
      emit TokensContributed(msg.sender, token, amountIn, creditOut);
    }
    require(credit >= minimumCredit, "ERR_MIN_CREDIT");
    _credits[msg.sender] = _credits[msg.sender].add(credit);
    totalCredit = totalCredit.add(credit);
  }

/* ---  Price Actions  --- */

  /**
   * @dev Updates the latest price observation for a token if allowable.
   *
   * Note: Price updates must be at least UPDATE_DELAY seconds apart.
   *
   * @param token Token to update the price of
   * @return didUpdate Whether the token price was updated.
   */
  function updatePrice(address token) public returns (bool didUpdate) {
    PriceObservation memory current = _lastPriceObservation[token];
    uint256 timeElapsed = now - current.timestamp;
    if (timeElapsed < UPDATE_DELAY) return false;
    PriceObservation memory _new = _observePrice(token);
    _lastPriceObservation[token] = _new;
    emit PriceUpdated(token, _new.priceCumulativeLast);
    return true;
  }

  /**
   * @dev Updates the prices of multiple tokens.
   *
   * @param tokens Array of tokens to update the prices of
   * @return updates Array of boolean values indicating which tokens
   * successfully updated their prices.
   */
  function updatePrices(address[] calldata tokens)
    external
    returns (bool[] memory updates)
  {
    updates = new bool[](tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      updates[i] = updatePrice(tokens[i]);
    }
  }

  /**
   * @dev Updates the prices of all tokens.
   */
  function updatePrices() external {
    uint256 len = _tokens.length;
    for (uint256 i = 0; i < len; i++) {
      updatePrice(_tokens[i]);
    }
  }

/* ---  Token Queries  --- */

  function getDesiredTokens()
    external
    view
    returns (address[] memory tokens)
  {
    tokens = _tokens;
  }

  function getDesiredAmount(address token)
    external
    view
    returns (uint256)
  {
    return _remainingDesiredAmounts[token];
  }

/* ---  External Price Queries --- */

  function getLastPriceObservation(address token)
    external
    view
    returns (PriceObservation memory)
  {
    return _lastPriceObservation[token];
  }

  /**
   * @dev Returns the timestamp of the next time that the
   * price of `token` can be updated.
   */
  function getNextPriceObservationTimestamp(address token)
    external
    view
    returns (uint256 timestampNext)
  {
    PriceObservation memory last = _lastPriceObservation[token];
    if (last.timestamp == 0) return now;
    return last.timestamp + UPDATE_DELAY;
  }

  /**
   * @dev Get the amount of WETH the contract will credit a user
   * for providing `amountIn` of `token`.
   *
   * Note: If `amountIn` is greater than the desired amount of
   * `token`, this will calculate the output using the desired
   * amount instead of `amountIn`.
   */
  function getCreditForTokens(address token, uint256 amountIn)
    external
    view
    returns (uint144 amountOut)
  {
    uint256 desiredAmount = _remainingDesiredAmounts[token];
    require(desiredAmount > 0, "ERR_NOT_NEEDED");
    if (amountIn > desiredAmount) {
      amountIn = desiredAmount;
    }
    uint144 averageWethValue = _calcCredit(token, amountIn);
    amountOut = averageWethValue;
  }

/* ---  Internal Claims Functions  --- */

  /**
   * @dev Claims pool tokens owed to `account` based on their
   * proportion of the total credit.
   * Note: Must be called in a function with the `_finished` modifier.
   * Note: Must be called in a function with the `_lock_` modifier.
   */
  function _claimTokens(address account) internal {
    uint256 credit = _credits[account];
    require(credit > 0, "ERR_NULL_CREDIT");
    uint256 amountOut = (TOKENS_MINTED.mul(credit)).div(totalCredit);
    _credits[account] = 0;
    IERC20(_poolAddress).safeTransfer(account, amountOut);
  }

/* ---  Internal Price Queries  --- */

  /**
   * @dev Returns the acceptable payment in weth for `amountIn` of `token`
   * and the fee that the caller should receive.
   */
  function _calcCredit(
    address token,
    uint256 amountIn
  )
    internal
    view
    returns (uint144 averageWethValue)
  {
    PriceObservation memory previous = _lastPriceObservation[token];
    uint256 timeElapsed = now - previous.timestamp;
    require(timeElapsed >= MINIMUM_PRICE_AGE, "ERR_MINIMUM_PRICE_AGE");
    PriceObservation memory current = _observePrice(token);

    averageWethValue = UniV2Oracle.computeAverageAmountOut(
      previous.priceCumulativeLast,
      current.priceCumulativeLast,
      uint32(current.timestamp - previous.timestamp),
      amountIn
    );
  }

  /**
   * @dev Query the current cumulative price for weth relative to `token`.
   */
  function _observePrice(address token)
    internal
    view
    returns (PriceObservation memory)
  {
    (uint256 priceCumulative, uint32 blockTimestamp) = UniV2Oracle
      .getCurrentCumulativePrice(_uniswapFactory, token, _weth);
    return PriceObservation(blockTimestamp, uint224(priceCumulative));
  }
}


interface PoolController {
  function finishPreparedIndexPool(
    address poolAddress,
    address[] calldata tokens,
    uint256[] calldata balances
  ) external;
}