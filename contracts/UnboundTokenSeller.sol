pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./openzeppelin/SafeMath.sol";
import "./interfaces/IERC20.sol";
import "./lib/FixedPoint.sol";
import { IUniswapV2Pair as Pair } from "./interfaces/IUniswapV2Pair.sol";
import { IUniswapV2Router02 as UniV2Router } from "./interfaces/IUniswapV2Router02.sol";
import { SafeERC20 } from "./openzeppelin/SafeERC20.sol";
import { IPool } from "./balancer/IPool.sol";
import { UniSwapV2PriceOracle } from "./UniSwapV2PriceOracle.sol";

/**
 * @dev Contract for swapping undesired tokens to desired tokens for
 * an index pool.
 *
 * This contract is deployed as a proxy for each index pool.
 *
 * When tokens are unbound from a pool, they are transferred to this
 * contract and sold on UniSwap or to anyone who calls the contract
 * in exchange for any token which is currently bound to its index pool
 * and which has a desired weight about zero.
 *
 * It uses a short-term uniswap price oracle to price swaps and has a
 * configurable slippage rate which determines the range around the
 * moving average for which it will accept a trade.
 */
contract UnboundTokenSeller {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;
  using SafeMath for uint256;
  using SafeMath for uint144;
  using SafeERC20 for IERC20;

/* ---  Constants  --- */

  UniV2Router internal immutable _uniswapRouter;
  address internal immutable _controller;
  UniSwapV2PriceOracle internal immutable _oracle;

/* ---  Events  --- */

  event NewTokensToSell(
    address indexed token,
    uint256 amountReceived
  );

  /**
   * @param tokenSold Token sent to caller
   * @param tokenBought Token received from caller and sent to pool
   * @param soldAmount Amount of `tokenSold` paid to caller
   * @param boughtAmount Amount of `tokenBought` sent to pool
   */
  event SwapWithCaller(
    address indexed tokenSold,
    address indexed tokenBought,
    uint256 soldAmount,
    uint256 boughtAmount
  );

  /**
   * @param tokenSold Token sent to UniSwap
   * @param tokenBought Token received from UniSwap and sent to pool
   * @param soldAmount Amount of `tokenSold` paid to UniSwap
   * @param boughtAmount Amount of `tokenBought` sent to pool
   * @param premiumPaid Amount of `tokenBought` sent to caller
   */
  event SwapWithUniSwap(
    address indexed tokenSold,
    address indexed tokenBought,
    uint256 soldAmount,
    uint256 boughtAmount,
    uint256 premiumPaid
  );

/* ---  Storage  --- */
  // Pool the contract is selling tokens for.
  IPool internal _pool;
  // Premium on the amount paid in swaps.
  // Half goes to the caller, half is used to increase payments.
  uint8 internal _premiumPercent;
  // Reentrance lock
  bool internal _mutex;

/* ---  Modifiers  --- */

  modifier _control_ {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    _;
  }

  modifier _lock_ {
    require(!_mutex, "ERR_REENTRY");
    _mutex = true;
    _;
    _mutex = false;
  }

  modifier _desired_(address token) {
    IPool.Record memory record = _pool.getTokenRecord(token);
    require(record.desiredDenorm > 0, "ERR_UNDESIRED_TOKEN");
    _;
  }

/* ---  Constructor  --- */

  constructor(
    UniV2Router uniswapRouter,
    UniSwapV2PriceOracle oracle,
    address controller
  ) public {
    _uniswapRouter = uniswapRouter;
    _oracle = oracle;
    _controller = controller;
  }

  /**
   * @dev Initialize the proxy contract with the acceptable premium rate
   * and the address of the pool it is for.
   */
  function initialize(IPool pool, uint8 premiumPercent)
    external
    _control_
  {
    require(address(_pool) == address(0), "ERR_INITIALIZED");
    require(address(pool) != address(0), "ERR_NULL_ADDRESS");
    require(
      premiumPercent > 0 && premiumPercent < 20,
      "ERR_PREMIUM"
    );
    _premiumPercent = premiumPercent;
    _pool = pool;
  }

/* ---  Controls  --- */

  /**
   * @dev Receive `amount` of `token` from the pool.
   */
  function handleUnbindToken(address token, uint256 amount)
    external
  {
    require(msg.sender == address(_pool), "ERR_ONLY_POOL");
    emit NewTokensToSell(token, amount);
  }

  /**
   * @dev Set the premium rate as a percent.
   */
  function setPremiumRate(uint8 premiumPercent) external _control_ {
    require(
      premiumPercent > 0 && premiumPercent < 20,
      "ERR_PREMIUM"
    );
    _premiumPercent = premiumPercent;
  }

  function emergencyExecuteSwapTokensForExactTokens(
    address tokenIn,
    address tokenOut,
    uint256 maxAmountIn,
    uint256 amountOut,
    address[] calldata path
  )
    external
    _lock_
    _control_
  {
    // Approve UniSwap to transfer the input tokens
    IERC20(tokenIn).safeApprove(address(_uniswapRouter), maxAmountIn);
    // Verify that the first token in the path is the input token and that
    // the last is the output token.
    require(
      path[0] == tokenIn && path[path.length - 1] == tokenOut,
      "ERR_PATH_TOKENS"
    );
    // Execute the swap.
    uint256[] memory amounts = _uniswapRouter.swapTokensForExactTokens(
      amountOut,
      maxAmountIn,
      path,
      address(_pool),
      block.timestamp + 1
    );
    uint256 amountIn = amounts[0];
    _pool.gulp(tokenOut);
    emit SwapWithUniSwap(
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      0
    );
  }

/* ---  Token Swaps  --- */

  /**
   * @dev Execute a trade with UniSwap to sell some tokens held by the contract
   * for some tokens desired by the pool and pays the caller any tokens received
   * above the minimum acceptable output.
   *
   * @param tokenIn Token to sell to UniSwap
   * @param tokenOut Token to receive from UniSwap
   * @param maxAmountIn Max amount of `tokenIn` to give UniSwap
   * @param amountOut Exact amount of `tokenOut` to receive from UniSwap
   * @param path Swap path to execute
   */
  function executeSwapTokensForExactTokens(
    address tokenIn,
    address tokenOut,
    uint256 maxAmountIn,
    uint256 amountOut,
    address[] calldata path
  )
    external
    _lock_
    _desired_(tokenOut)
    returns (uint256 premiumPaidToCaller)
  {
    // Approve UniSwap to transfer the input tokens
    IERC20(tokenIn).safeApprove(address(_uniswapRouter), maxAmountIn);
    // Verify that the first token in the path is the input token and that
    // the last is the output token.
    require(
      path[0] == tokenIn && path[path.length - 1] == tokenOut,
      "ERR_PATH_TOKENS"
    );
    // Execute the swap.
    uint256[] memory amounts = _uniswapRouter.swapTokensForExactTokens(
      amountOut,
      maxAmountIn,
      path,
      address(this),
      block.timestamp + 1
    );
    // Get the actual amount paid
    uint256 amountIn = amounts[0];
    uint256 poolAmountOut;
    // Compute the amount to pay to the pool and caller and verify
    // that the amount received is sufficient.
    (premiumPaidToCaller, poolAmountOut) = _calcAmountToCallerAndPool(
      tokenIn,
      amountIn,
      tokenOut,
      amountOut
    );

    // If we did not swap the full amount, remove the UniSwap allowance.
    if (amountIn != maxAmountIn) {
      IERC20(tokenIn).safeApprove(address(_uniswapRouter), 0);
    }
    // Transfer the received tokens to the pool
    IERC20(tokenOut).safeTransfer(address(_pool), poolAmountOut);
    // Transfer any tokens received beyond the minimum acceptable payment
    // to the caller as a reward.
    IERC20(tokenOut).safeTransfer(msg.sender, premiumPaidToCaller);
    // Update the pool's balance of the token.
    _pool.gulp(tokenOut);
    emit SwapWithUniSwap(
      tokenIn,
      tokenOut,
      amountIn,
      poolAmountOut,
      premiumPaidToCaller
    );
  }

  /**
   * @dev Executes a trade with UniSwap to sell some tokens held by the contract
   * for some tokens desired by the pool and pays the caller any tokens received
   * above the minimum acceptable output.
   *
   * @param tokenIn Token to sell to UniSwap
   * @param tokenOut Token to receive from UniSwap
   * @param amountIn Exact amount of `tokenIn` to give UniSwap
   * @param minAmountOut Minimum amount of `tokenOut` to receive from UniSwap
   * @param path Swap path to execute
   */
  function executeSwapExactTokensForTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minAmountOut,
    address[] calldata path
  )
    external
    _lock_
    _desired_(tokenOut)
    returns (uint256 premiumPaidToCaller)
  {
    // Approve UniSwap to transfer the input tokens
    IERC20(tokenIn).safeApprove(address(_uniswapRouter), amountIn);
    // Verify that the first token in the path is the input token and that
    // the last is the output token.
    require(
      path[0] == tokenIn && path[path.length - 1] == tokenOut,
      "ERR_PATH_TOKENS"
    );
    // Execute the swap.
    uint256[] memory amounts = _uniswapRouter.swapExactTokensForTokens(
      amountIn,
      minAmountOut,
      path,
      address(this),
      block.timestamp + 1
    );
    // Get the actual amount paid
    uint256 amountOut = amounts[amounts.length - 1];
    uint256 poolAmountOut;
    // Compute the amount to pay to the pool and caller and verify
    // that the amount received is sufficient.
    (premiumPaidToCaller, poolAmountOut) = _calcAmountToCallerAndPool(
      tokenIn,
      amountIn,
      tokenOut,
      amountOut
    );
    // Transfer the received tokens to the pool
    IERC20(tokenOut).safeTransfer(address(_pool), poolAmountOut);
    // Transfer any tokens received beyond the minimum acceptable payment
    // to the caller as a reward.
    IERC20(tokenOut).safeTransfer(msg.sender, premiumPaidToCaller);
    // Update the pool's balance of the token.
    _pool.gulp(tokenOut);
    emit SwapWithUniSwap(
      tokenIn,
      tokenOut,
      amountIn,
      poolAmountOut,
      premiumPaidToCaller
    );
  }

  /**
   * @dev Swap exactly `amountIn` of `tokenIn` for at least `minAmountOut`
   * of `tokenOut`.
   *
   * @param tokenIn Token to sell to pool
   * @param tokenOut Token to buy from pool
   * @param amountIn Amount of `tokenIn` to sell to pool
   * @param minAmountOut Minimum amount of `tokenOut` to buy from pool
   */
  function swapExactTokensForTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minAmountOut
  )
    external
    _lock_
    _desired_(tokenIn)
    returns (uint256 amountOut)
  {
    (
      FixedPoint.uq112x112 memory avgPriceIn,
      FixedPoint.uq112x112 memory avgPriceOut
    ) = _getAveragePrices(tokenIn, tokenOut);
    // Compute the average weth value for `amountIn` of `tokenIn`
    uint144 avgInValue = avgPriceIn.mul(amountIn).decode144();
    // Compute the maximum weth value the contract will give for `avgInValue`
    uint256 maxOutValue = _maximumPaidValue(avgInValue);
    // Compute the average amount of `tokenOut` worth `maxOutValue` weth
    amountOut = avgPriceOut.reciprocal().mul(maxOutValue).decode144();
    // Verify the amount is above the provided minimum.
    require(amountOut >= minAmountOut, "ERR_MIN_AMOUNT_OUT");
    // Transfer the input tokens to the pool
    IERC20(tokenIn).safeTransferFrom(msg.sender, address(_pool), amountIn);
    _pool.gulp(tokenIn);
    // Transfer the output tokens to the caller
    IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    emit SwapWithCaller(
      tokenOut,
      tokenIn,
      amountOut,
      amountIn
    );
  }

  /**
   * @dev Swap up to `maxAmountIn` of `tokenIn` for exactly `amountOut`
   * of `tokenOut`.
   *
   * @param tokenIn Token to sell to pool
   * @param tokenOut Token to buy from pool
   * @param maxAmountIn Maximum amount of `tokenIn` to sell to pool
   * @param amountOut Amount of `tokenOut` to buy from pool
   */
  function swapTokensForExactTokens(
    address tokenIn,
    address tokenOut,
    uint256 maxAmountIn,
    uint256 amountOut
  )
    external
    _lock_
    _desired_(tokenIn)
    returns (uint256 amountIn)
  {
    (
      FixedPoint.uq112x112 memory avgPriceIn,
      FixedPoint.uq112x112 memory avgPriceOut
    ) = _getAveragePrices(tokenIn, tokenOut);
    // Compute the average weth value for `amountOut` of `tokenOut`
    uint144 avgOutValue = avgPriceOut.mul(amountOut).decode144();
    // Compute the minimum weth value the contract must receive for `avgOutValue`
    uint256 minInValue = _minimumReceivedValue(avgOutValue);
    // Compute the average amount of `tokenIn` worth `minInValue` weth
    amountIn = avgPriceIn.reciprocal().mul(minInValue).decode144();
    require(amountIn <= maxAmountIn, "ERR_MAX_AMOUNT_IN");
    // Transfer the input tokens to the pool
    IERC20(tokenIn).safeTransferFrom(msg.sender, address(_pool), amountIn);
    _pool.gulp(tokenIn);
    // Transfer the output tokens to the caller
    IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    emit SwapWithCaller(
      tokenOut,
      tokenIn,
      amountOut,
      amountIn
    );
  }

/* ---  Swap Queries  --- */

  /**
   * @dev Calculate the amount of `tokenIn` the pool must receive for
   * `amountOut` of `tokenOut`.
   */
  function calcInGivenOut(
    address tokenIn,
    address tokenOut,
    uint256 amountOut
  )
    external
    view
    _desired_(tokenIn)
    returns (uint256 amountIn)
  {
    require(
      IERC20(tokenOut).balanceOf(address(this)) >= amountOut,
      "ERR_INSUFFICIENT_BALANCE"
    );
    (
      FixedPoint.uq112x112 memory avgPriceIn,
      FixedPoint.uq112x112 memory avgPriceOut
    ) = _getAveragePrices(tokenIn, tokenOut);
    // Compute the average weth value for `amountOut` of `tokenOut`
    uint144 avgOutValue = avgPriceOut.mul(amountOut).decode144();
    // Compute the minimum weth value the contract must receive for `avgOutValue`
    uint256 minInValue = _minimumReceivedValue(avgOutValue);
    // Compute the average amount of `tokenIn` worth `minInValue` weth
    amountIn = avgPriceIn.reciprocal().mul(minInValue).decode144();
  }

  /**
   * @dev Calculate the amount of `tokenOut` the pool will give for
   * `amountIn` of `tokenIn`.
   */
  function calcOutGivenIn(
    address tokenIn,
    address tokenOut,
    uint256 amountIn
  )
    external
    view
    _desired_(tokenIn)
    returns (uint256 amountOut)
  {
    (
      FixedPoint.uq112x112 memory avgPriceIn,
      FixedPoint.uq112x112 memory avgPriceOut
    ) = _getAveragePrices(tokenIn, tokenOut);
    // Compute the average weth value for `amountIn` of `tokenIn`
    uint144 avgInValue = avgPriceIn.mul(amountIn).decode144();
    // Compute the maximum weth value the contract will give for `avgInValue`
    uint256 maxOutValue = _maximumPaidValue(avgInValue);
    // Compute the average amount of `tokenOut` worth `maxOutValue` weth
    amountOut = avgPriceOut.reciprocal().mul(maxOutValue).decode144();
    require(
      IERC20(tokenOut).balanceOf(address(this)) >= amountOut,
      "ERR_INSUFFICIENT_BALANCE"
    );
  }

/* ---  Internal Functions  --- */

  function _calcAmountToCallerAndPool(
    address tokenPaid,
    uint256 amountPaid,
    address tokenReceived,
    uint256 amountReceived
  )
    internal
    view
    returns (uint256 premiumAmount, uint256 poolAmount)
  {
    // Get the average weth value of the amounts received and paid
    (uint144 avgReceivedValue, uint144 avgPaidValue) = _getAverageValues(
      tokenReceived,
      amountReceived,
      tokenPaid,
      amountPaid
    );
    uint256 minReceivedValue = _minimumReceivedValue(avgPaidValue);
    require(avgReceivedValue >= minReceivedValue, "ERR_MIN_RECEIVED");
    
    premiumAmount = (amountReceived * (avgReceivedValue - minReceivedValue)) / avgReceivedValue;
    poolAmount = amountPaid - premiumAmount;
  }

  function _getAverageValues(
    address token1,
    uint256 amount1,
    address token2,
    uint256 amount2
  )
    internal
    view
    returns (uint144 avgValue1, uint144 avgValue2)
  {
    address[] memory tokens = new address[](2);
    tokens[0] = token1;
    tokens[1] = token2;
    uint256[] memory amounts = new uint256[](2);
    amounts[0] = amount1;
    amounts[1] = amount2;
    uint144[] memory avgValues = _oracle.computeAverageAmountsOut(tokens, amounts);
    avgValue1 = avgValues[0];
    avgValue2 = avgValues[1];
  }

  function _getAveragePrices(address token1, address token2)
    internal
    view
    returns (
      FixedPoint.uq112x112 memory avgPrice1,
      FixedPoint.uq112x112 memory avgPrice2
    )
  {
    address[] memory tokens = new address[](2);
    tokens[0] = token1;
    tokens[1] = token2;
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    avgPrice1 = prices[0];
    avgPrice2 = prices[1];
  }

  function _maximumPaidValue(uint256 valueReceived)
    internal
    view
    returns (uint256 maxPaidValue)
  {
    maxPaidValue = (100 * valueReceived) / (100 - _premiumPercent);
  }


  function _minimumReceivedValue(uint256 valuePaid)
    internal
    view
    returns (uint256 minValueReceived)
  {
    minValueReceived = (valuePaid * (100 - _premiumPercent)) / 100;
  }
}