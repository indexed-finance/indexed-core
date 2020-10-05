// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./lib/FixedPoint.sol";
import { IPool } from "./balancer/IPool.sol";
import { UniSwapV2PriceOracle } from "./UniSwapV2PriceOracle.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {
  IUniswapV2Pair as Pair
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {
  IUniswapV2Router02 as UniV2Router
} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

import { PriceLibrary as Prices } from "./lib/PriceLibrary.sol";


/**
 * @title UnboundTokenSeller
 * @author d1ll0n
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
 * configurable premium rate which is used to decrease the expected
 * output from a swap and to reward callers for triggering a sale.
 *
 * The contract does not track the tokens it has received in order to
 * reduce gas spent by the pool contract. Tokens must be tracked via
 * events, meaning this is not well suited for trades with other smart
 * contracts.
 */
contract UnboundTokenSeller {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;
  using SafeMath for uint256;
  using SafeMath for uint144;
  using SafeERC20 for IERC20;
  using Prices for Prices.TwoWayAveragePrice;

/* ---  Constants  --- */

  UniV2Router internal immutable _uniswapRouter;
  address internal immutable _controller;
  UniSwapV2PriceOracle internal immutable _oracle;

/* ---  Events  --- */

  event PremiumPercentSet(uint8 premium);

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
  event SwappedTokens(
    address indexed tokenSold,
    address indexed tokenBought,
    uint256 soldAmount,
    uint256 boughtAmount
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
  function setPremiumPercent(uint8 premiumPercent) external _control_ {
    require(
      premiumPercent > 0 && premiumPercent < 20,
      "ERR_PREMIUM"
    );
    _premiumPercent = premiumPercent;
    emit PremiumPercentSet(premiumPercent);
  }

/* ---  Token Swaps  --- */

  /**
   * @dev Execute a trade with UniSwap to sell some tokens held by the contract
   * for some tokens desired by the pool and pays the caller the difference between
   * the maximum input value and the actual paid amount.
   *
   * @param tokenIn Token to sell to UniSwap
   * @param tokenOut Token to receive from UniSwapx
   * @param amountOut Exact amount of `tokenOut` to receive from UniSwap
   * @param path Swap path to execute
   */
  function executeSwapTokensForExactTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountOut,
    address[] calldata path
  )
    external
    _lock_
    returns (uint256 premiumPaidToCaller)
  {
    // calcOutGivenIn uses tokenIn as the token the pool is receiving and
    // tokenOut as the token the pool is paying, whereas this function is
    // the reverse.
    uint256 maxAmountIn = calcOutGivenIn(tokenOut, tokenIn, amountOut);
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
    // Get the actual amount paid
    uint256 amountIn = amounts[0];
    // If we did not swap the full amount, remove the UniSwap allowance.
    if (amountIn != maxAmountIn) {
      IERC20(tokenIn).safeApprove(address(_uniswapRouter), 0);
      premiumPaidToCaller = maxAmountIn - amountIn;
      // Transfer the difference between what the contract was willing to pay and
      // what it actually paid to the caller.
      IERC20(tokenIn).safeTransfer(msg.sender, premiumPaidToCaller);

    }
    // Update the pool's balance of the token.
    _pool.gulp(tokenOut);
    emit SwappedTokens(
      tokenIn,
      tokenOut,
      amountIn,
      amountOut
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
   * @param path Swap path to execute
   */
  function executeSwapExactTokensForTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    address[] calldata path
  )
    external
    _lock_
    returns (uint256 premiumPaidToCaller)
  {
    // calcInGivenOut uses tokenIn as the token the pool is receiving and
    // tokenOut as the token the pool is paying, whereas this function is
    // the reverse.
    uint256 minAmountOut = calcInGivenOut(tokenOut, tokenIn, amountIn);
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
    if (amountOut != minAmountOut) {
      // Transfer any tokens received beyond the minimum acceptable payment
      // to the caller as a reward.
      premiumPaidToCaller = amountOut - minAmountOut;
      IERC20(tokenOut).safeTransfer(msg.sender, premiumPaidToCaller);
    }
    // Transfer the received tokens to the pool
    IERC20(tokenOut).safeTransfer(address(_pool), minAmountOut);
    // Update the pool's balance of the token.
    _pool.gulp(tokenOut);
    emit SwappedTokens(
      tokenIn,
      tokenOut,
      amountIn,
      amountOut
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
    returns (uint256 amountOut)
  {
    amountOut = calcOutGivenIn(tokenIn, tokenOut, amountIn);
    // Verify the amount is above the provided minimum.
    require(amountOut >= minAmountOut, "ERR_MIN_AMOUNT_OUT");
    // Transfer the input tokens to the pool
    IERC20(tokenIn).safeTransferFrom(msg.sender, address(_pool), amountIn);
    _pool.gulp(tokenIn);
    // Transfer the output tokens to the caller
    IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    emit SwappedTokens(
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
   * @param amountOut Amount of `tokenOut` to buy from pool
   * @param maxAmountIn Maximum amount of `tokenIn` to sell to pool
   */
  function swapTokensForExactTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountOut,
    uint256 maxAmountIn
  )
    external
    _lock_
    returns (uint256 amountIn)
  {
    amountIn = calcInGivenOut(tokenIn, tokenOut, amountOut);
    require(amountIn <= maxAmountIn, "ERR_MAX_AMOUNT_IN");
    // Transfer the input tokens to the pool
    IERC20(tokenIn).safeTransferFrom(msg.sender, address(_pool), amountIn);
    _pool.gulp(tokenIn);
    // Transfer the output tokens to the caller
    IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    emit SwappedTokens(
      tokenOut,
      tokenIn,
      amountOut,
      amountIn
    );
  }

/* ---  Swap Queries  --- */

  function getPremiumPercent() external view returns (uint8) {
    return _premiumPercent;
  }

  /**
   * @dev Calculate the amount of `tokenIn` the pool will accept for
   * `amountOut` of `tokenOut`.
   */
  function calcInGivenOut(
    address tokenIn,
    address tokenOut,
    uint256 amountOut
  )
    public
    view
    _desired_(tokenIn)
    returns (uint256 amountIn)
  {
    require(
      IERC20(tokenOut).balanceOf(address(this)) >= amountOut,
      "ERR_INSUFFICIENT_BALANCE"
    );
    (
      Prices.TwoWayAveragePrice memory avgPriceIn,
      Prices.TwoWayAveragePrice memory avgPriceOut
    ) = _getAveragePrices(tokenIn, tokenOut);
    // Compute the average weth value for `amountOut` of `tokenOut`
    uint144 avgOutValue = avgPriceOut.computeAverageEthForTokens(amountOut);
    // Compute the minimum weth value the contract must receive for `avgOutValue`
    uint256 minInValue = _minimumReceivedValue(avgOutValue);
    // Compute the average amount of `tokenIn` worth `minInValue` weth
    amountIn = avgPriceIn.computeAverageTokensForEth(minInValue);
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
    public
    view
    _desired_(tokenIn)
    returns (uint256 amountOut)
  {
    (
      Prices.TwoWayAveragePrice memory avgPriceIn,
      Prices.TwoWayAveragePrice memory avgPriceOut
    ) = _getAveragePrices(tokenIn, tokenOut);
    // Compute the average weth value for `amountIn` of `tokenIn`
    uint144 avgInValue = avgPriceIn.computeAverageEthForTokens(amountIn);
    // Compute the maximum weth value the contract will give for `avgInValue`
    uint256 maxOutValue = _maximumPaidValue(avgInValue);
    // Compute the average amount of `tokenOut` worth `maxOutValue` weth
    amountOut = avgPriceOut.computeAverageTokensForEth(maxOutValue);
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
    // Compute the minimum acceptable received value
    uint256 minReceivedValue = _minimumReceivedValue(avgPaidValue);
    require(avgReceivedValue >= minReceivedValue, "ERR_MIN_RECEIVED");
    // Compute the premium based on the value received above the minimum
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
      Prices.TwoWayAveragePrice memory avgPrice1,
      Prices.TwoWayAveragePrice memory avgPrice2
    )
  {
    address[] memory tokens = new address[](2);
    tokens[0] = token1;
    tokens[1] = token2;
    Prices.TwoWayAveragePrice[] memory prices = _oracle.computeTwoWayAveragePrices(tokens);
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