// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

/* ========== External Interfaces ========== */
import "@indexed-finance/uniswap-v2-oracle/contracts/interfaces/IIndexedUniswapV2Oracle.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/* ========== External Libraries ========== */
import "@indexed-finance/uniswap-v2-oracle/contracts/lib/PriceLibrary.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

/* ========== Internal Interfaces ========== */
import "./interfaces/IIndexPool.sol";
import "./interfaces/IUnboundTokenSeller.sol";


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
contract UnboundTokenSeller is IUnboundTokenSeller {
  using SafeERC20 for IERC20;
  using PriceLibrary for PriceLibrary.TwoWayAveragePrice;

/* ==========  Constants  ========== */

  uint32 internal constant SHORT_TWAP_MIN_TIME_ELAPSED = 20 minutes;
  uint32 internal constant SHORT_TWAP_MAX_TIME_ELAPSED = 2 days;

  IUniswapV2Router02 internal immutable _uniswapRouter;
  address public immutable controller;
  IIndexedUniswapV2Oracle public immutable oracle;

/* ==========  Events  ========== */

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

/* ==========  Storage  ========== */
  // Pool the contract is selling tokens for.
  IIndexPool internal _pool;
  // Premium on the amount paid in swaps.
  // Half goes to the caller, half is used to increase payments.
  uint8 internal _premiumPercent;
  // Reentrance lock
  bool internal _mutex;

/* ==========  Modifiers  ========== */

  modifier _control_ {
    require(msg.sender == controller, "ERR_NOT_CONTROLLER");
    _;
  }

  modifier _lock_ {
    require(!_mutex, "ERR_REENTRY");
    _mutex = true;
    _;
    _mutex = false;
  }

  modifier _desired_(address token) {
    IIndexPool.Record memory record = _pool.getTokenRecord(token);
    require(record.desiredDenorm > 0, "ERR_UNDESIRED_TOKEN");
    _;
  }

/* ==========  Constructor  ========== */

  constructor(
    IUniswapV2Router02 uniswapRouter,
    IIndexedUniswapV2Oracle oracle_,
    address controller_
  ) public {
    _uniswapRouter = uniswapRouter;
    oracle = oracle_;
    controller = controller_;
  }

  /**
   * @dev Initialize the proxy contract with the acceptable premium rate
   * and the address of the pool it is for.
   */
  function initialize(address pool, uint8 premiumPercent)
    external
    override
    _control_
  {
    require(address(_pool) == address(0), "ERR_INITIALIZED");
    require(pool != address(0), "ERR_NULL_ADDRESS");
    require(
      premiumPercent > 0 && premiumPercent < 20,
      "ERR_PREMIUM"
    );
    _premiumPercent = premiumPercent;
    _pool = IIndexPool(pool);
  }

/* ==========  Controls  ========== */

  /**
   * @dev Receive `amount` of `token` from the pool.
   */
  function handleUnbindToken(address token, uint256 amount)
    external
    override
  {
    require(msg.sender == address(_pool), "ERR_ONLY_POOL");
    emit NewTokensToSell(token, amount);
  }

  /**
   * @dev Set the premium rate as a percent.
   */
  function setPremiumPercent(uint8 premiumPercent) external override _control_ {
    require(
      premiumPercent > 0 && premiumPercent < 20,
      "ERR_PREMIUM"
    );
    _premiumPercent = premiumPercent;
    emit PremiumPercentSet(premiumPercent);
  }

/* ==========  Token Swaps  ========== */

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
    override
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
      block.timestamp
    );
    // Get the actual amount paid
    uint256 amountIn = amounts[0];
    // If we did not swap the full amount, remove the UniSwap allowance.
    if (amountIn < maxAmountIn) {
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
    override
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
      block.timestamp
    );
  
    // Get the actual amount paid
    uint256 amountOut = amounts[amounts.length - 1];
    if (amountOut > minAmountOut) {
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
    override
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
    override
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

/* ==========  Swap Queries  ========== */

  function getPremiumPercent() external view override returns (uint8) {
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
    override
    _desired_(tokenIn)
    returns (uint256 amountIn)
  {
    require(
      IERC20(tokenOut).balanceOf(address(this)) >= amountOut,
      "ERR_INSUFFICIENT_BALANCE"
    );
    (
      PriceLibrary.TwoWayAveragePrice memory avgPriceIn,
      PriceLibrary.TwoWayAveragePrice memory avgPriceOut
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
    override
    _desired_(tokenIn)
    returns (uint256 amountOut)
  {
    (
      PriceLibrary.TwoWayAveragePrice memory avgPriceIn,
      PriceLibrary.TwoWayAveragePrice memory avgPriceOut
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

/* ==========  Internal Functions  ========== */

  function _getAveragePrices(address token1, address token2)
    internal
    view
    returns (
      PriceLibrary.TwoWayAveragePrice memory avgPrice1,
      PriceLibrary.TwoWayAveragePrice memory avgPrice2
    )
  {
    address[] memory tokens = new address[](2);
    tokens[0] = token1;
    tokens[1] = token2;
    PriceLibrary.TwoWayAveragePrice[] memory prices = oracle.computeTwoWayAveragePrices(
      tokens,
      SHORT_TWAP_MIN_TIME_ELAPSED,
      SHORT_TWAP_MAX_TIME_ELAPSED
    );
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