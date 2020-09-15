pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import {
  UniswapV2OracleLibrary as UniV2Oracle
} from "./lib/UniswapV2OracleLibrary.sol";
import "./lib/FixedPoint.sol";
import "./lib/SafeMath.sol";
import "./interfaces/IERC20.sol";
import { UniswapV2Library as UniV2 } from "./lib/UniswapV2Library.sol";
import { IUniswapV2Pair as Pair } from "./interfaces/IUniswapV2Pair.sol";
import { IUniswapV2Router02 as UniV2Router } from "./interfaces/IUniswapV2Router02.sol";
import { SafeERC20 } from "./openzeppelin/SafeERC20.sol";

/**
 * @dev Contract for purchasing tokens within some range of the recent
 * UniSwap spot price.
 */
contract RestrictedTokenBuyer {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

/* ---  Constants  --- */

  // Delay between price updates
  uint256 internal constant UPDATE_DELAY = 1 hours;
  uint256 internal constant MINIMUM_PRICE_AGE = UPDATE_DELAY / 2;

  UniV2Router internal immutable _uniswapRouter;
  address internal immutable _uniswapFactory;
  address internal immutable _weth;
  // Address that can withdraw tokens and set desired purchases.
  address internal immutable _controller;

/* ---  Structs  --- */

  struct PriceObservation {
    uint32 timestamp;
    uint224 priceCumulativeLast;
  }

/* ---  Events  --- */

  event DesiredTokensAdded(
    address indexed token,
    uint256 desiredAmountAdded
  );

  event TokensPurchased(
    address indexed token,
    uint256 receivedAmount,
    uint256 paidAmount
  );

  event TokensWithdrawn(
    address indexed token,
    uint256 withdrawnAmount
  );

  event PriceUpdated(
    address indexed token,
    uint224 priceCumulativeLast
  );

/* ---  Storage  --- */
  // Premium on the amount paid in swaps.
  // Half goes to the caller, half is used to increase payments.
  uint8 internal _premiumPercent;
  // Price observations per token
  mapping(address => PriceObservation) internal _lastPriceObservation;
  // Token amounts to purchase
  mapping(address => uint256) internal _desiredTokenAmounts;

/* ---  Modifiers  --- */

  modifier _control_ {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    _;
  }

/* ---  Constructor  --- */

  constructor(
    address controller,
    address uniswapFactory,
    UniV2Router uniswapRouter,
    address weth,
    uint8 premiumPercent
  ) public {
    require(controller != address(0), "ERR_NULL_ADDRESS");
    _controller = controller;
    _uniswapFactory = uniswapFactory;
    _uniswapRouter = uniswapRouter;
    _weth = weth;
    require(
      premiumPercent > 0 && premiumPercent < 20,
      "ERR_PREMIUM"
    );
    _premiumPercent = premiumPercent;
  }

/* ---  Controls  --- */

  /**
   * @dev Increase the desired amount of `token` by `amount`
   */
  function addDesiredTokens(address token, uint256 amount)
    external
    _control_
  {
    _desiredTokenAmounts[token] = _desiredTokenAmounts[token].add(amount);
    emit DesiredTokensAdded(token, amount);
    updatePrice(token);
  }

  /**
   * @dev Increase the desired amount of `token` by `amount`
   */
  function addDesiredTokens(
    address[] calldata tokens,
    uint256[] calldata amounts
  )
    external
    _control_
  {
    require(tokens.length == amounts.length, "ERR_ARR_LEN");
    for (uint256 i = 0; i < tokens.length; i++) {
      // Repeat the logic rather than call the other fn to avoid
      // repeat execution of _control_ modifier
      address token = tokens[i];
      uint256 amount = amounts[i];
      _desiredTokenAmounts[token] = _desiredTokenAmounts[token].add(amount);
      emit DesiredTokensAdded(token, amount);
    }
    updatePrices(tokens);
  }

  /**
   * @dev Withdraw tokens from the contract.
   */
  function withdraw(address token, uint256 amount)
    external
    _control_
  {
    IERC20(token).safeTransfer(msg.sender, amount);
    emit TokensWithdrawn(token, amount);
  }

  /**
   * @dev Withdraw tokens from the contract.
   */
  function withdraw(
    address[] calldata tokens,
    uint[] calldata amounts
  )
    external
    _control_
  {
    require(tokens.length == amounts.length, "ERR_ARR_LEN");
    for (uint256 i = 0; i < tokens.length; i++) {
      IERC20(tokens[i]).safeTransfer(msg.sender, amounts[i]);
    }
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

/* ---  Token Swaps  --- */

  /**
   * @dev Purchase `tokenAmount` of `token` from UniSwap, with an acceptable
   * payment equal to the recent moving average price plus half the premium
   * rate.
   *
   * Note: If `tokenAmount` exceeds the desired amount, use the desired amount
   * instead.
   * Note: The caller will receive half the premium as a reward for
   * triggering the purchase.
   */
  function purchaseTokenFromUniswap(
    address token,
    uint256 tokenAmount
  ) external {
    uint256 amountOut = tokenAmount;
    uint256 desiredAmount = _desiredTokenAmounts[token];
    require(desiredAmount > 0, "ERR_NOT_NEEDED");
    if (amountOut > desiredAmount) {
      amountOut = desiredAmount;
    }
    (uint144 amountInMax, uint144 fee) = _calcMaxPaymentAndFee(token, amountOut);
    require(amountOut > 0 && amountInMax > 0, "ERR_ZERO_AMOUNT");
    IERC20(_weth).safeApprove(address(_uniswapRouter), amountInMax);
    address[] memory path = new address[](2);
    path[0] = _weth;
    path[1] = token;
    uint256[] memory amounts = _uniswapRouter.swapTokensForExactTokens(
      amountOut,
      amountInMax,
      path,
      address(this),
      block.timestamp + 1
    );
    IERC20(_weth).safeApprove(address(_uniswapRouter), 0);
    _desiredTokenAmounts[token] = desiredAmount.sub(amountOut);
    IERC20(_weth).safeTransfer(msg.sender, fee);
    emit TokensPurchased(token, amountOut, amounts[0]);
  }

  /**
   * @dev Sells `amountIn` of `token` to the contract for WETH
   * at the rate of the recent moving average price on UniSwap
   * plus the acceptable premium rate.
   *
   * Note: If `amountIn` exceeds the desired amount, use the desired amount
   * instead.
   */
  function sellTokensForWETH(
    address token,
    uint256 amountIn,
    uint256 minAmountOut
  ) external {
    uint256 desiredAmount = _desiredTokenAmounts[token];
    require(desiredAmount > 0, "ERR_NOT_NEEDED");
    if (amountIn > desiredAmount) {
      amountIn = desiredAmount;
    }
    (uint144 amountOut, uint144 fee) = _calcMaxPaymentAndFee(token, amountIn);
    amountOut += fee;
    require(amountOut > 0 && amountIn > 0, "ERR_ZERO_AMOUNT");
    require(amountOut >= minAmountOut, "ERR_AMOUNT_OUT");
    IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
    IERC20(_weth).safeTransfer(msg.sender, amountOut);
    _desiredTokenAmounts[token] = desiredAmount.sub(amountIn);
    emit TokensPurchased(token, amountIn, amountOut);
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
  function updatePrices(address[] memory tokens)
    public
    returns (bool[] memory updates)
  {
    updates = new bool[](tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      updates[i] = updatePrice(tokens[i]);
    }
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
    PriceObservation memory current = _lastPriceObservation[token];
    if (current.timestamp == 0) return now;
  }

  /**
   * @dev Get the amount of WETH the contract is willing to pay
   * for `amountIn` of `token`.
   *
   * Note: If `amountIn` is greater than the desired amount of
   * `token`, this will calculate the output using the desired
   * amount instead of `amountIn`.
   */
  function getAmountWETHOut(address token, uint256 amountIn)
    external
    view
    returns (uint144 amountOut)
  {
    uint256 desiredAmount = _desiredTokenAmounts[token];
    require(desiredAmount > 0, "ERR_NOT_NEEDED");
    if (amountIn > desiredAmount) {
      amountIn = desiredAmount;
    }
    uint144 fee;
    (amountOut, fee) = _calcMaxPaymentAndFee(token, amountIn);
    amountOut += fee;
  }

/* ---  Internal Price Queries  --- */

  /**
   * @dev Returns the acceptable payment in weth for `tokenAmount` of `token`
   * and the fee that the caller should receive.
   */
  function _calcMaxPaymentAndFee(
    address token,
    uint256 tokenAmount
  )
    internal
    view
    returns (uint144 maxPayment, uint144 fee)
  {
    PriceObservation memory previous = _lastPriceObservation[token];
    uint256 timeElapsed = now - previous.timestamp;
    require(timeElapsed >= MINIMUM_PRICE_AGE, "ERR_MINIMUM_PRICE_AGE");
    PriceObservation memory current = _observePrice(token);

    uint144 averageWethValue = UniV2Oracle.computeAverageAmountOut(
      previous.priceCumulativeLast,
      current.priceCumulativeLast,
      uint32(current.timestamp - previous.timestamp),
      tokenAmount
    );

    FixedPoint.uq112x112 memory premium = FixedPoint.fraction(
      _premiumPercent, 100
    );

    fee = premium.mul(averageWethValue).decode144() / 2;
    maxPayment = averageWethValue + fee;
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