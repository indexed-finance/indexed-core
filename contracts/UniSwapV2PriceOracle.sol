pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { UniswapV2Library as UniV2 } from "./lib/UniswapV2Library.sol";
import { IUniswapV2Pair as Pair } from "./interfaces/IUniswapV2Pair.sol";
import { UniswapV2OracleLibrary as UniV2Oracle } from "./lib/UniswapV2OracleLibrary.sol";
import "./lib/FixedPoint.sol";
import "./interfaces/IERC20.sol";

contract UniSwapV2PriceOracle {
  // Minimum time elapsed between updates
  uint32 public constant MIN_UPDATE_PERIOD = uint32(1 days);
  // Maximum value of a 24 bit integer
  uint24 public constant MAX_24_BIT = uint24(2**24 - 1);

  // Uniswap factory address
  address public uniswapFactory;

  // Address of the token used to compare prices.
  // Should be a stablecoin such as DAI or USDC.
  address public stableCoin;

  struct PriceObservation {
    uint32 timestamp;
    uint224 priceCumulativeLast;
  }

  mapping(address => PriceObservation) public lastObservedPrices;

  event PriceUpdated(address token, uint224 priceCumulativeLast);

  constructor(address _uniswapFactory, address _stableCoin) public {
    uniswapFactory = _uniswapFactory;
    stableCoin = _stableCoin;
  }

  /**
   * @dev Update the price stored for a token.
   * Note: May only be called once every MIN_UPDATE_PERIOD seconds.
   */
  function updatePrice(address token) public {
    PriceObservation memory observation1 = lastObservedPrices[token];
    PriceObservation memory observation2 = _observePrice(token);
    lastObservedPrices[token] = observation2;
    uint32 timeElapsed = uint32(observation2.timestamp - observation1.timestamp);
    require(timeElapsed >= MIN_UPDATE_PERIOD, "ERR_MIN_UPDATE_PERIOD");
    emit PriceUpdated(token, observation2.priceCumulativeLast);
  }

  /**
   * @dev Update the price for multiple tokens.
   */
  function updatePrices(address[] memory tokens) public {
    for (uint256 i = 0; i < tokens.length; i++) updatePrice(tokens[i]);
  }

  /**
   * @dev Compute the average market cap of a token over the recent period.
   * Queries the current cumulative price and retrieves the last stored
   * cumulative price, then calculates the average price and multiplies it
   * by the token's total supply.
   * Note: Price must have been updated within the last MIN_UPDATE_PERIOD
   * seconds.
   */
  function computeAverageMarketCap(address token)
  public view returns (uint144 marketCap) {
    // Get the stored price observation
    PriceObservation memory observation1 = lastObservedPrices[token];
    // Get the current cumulative price
    PriceObservation memory observation2 = _observePrice(token);
    // Extrapolate the average value of the total supply.
    uint32 timeElapsed = uint32(observation2.timestamp - observation1.timestamp);
    require(timeElapsed <= MIN_UPDATE_PERIOD, "Outdated price info.");
    uint256 totalSupply = IERC20(token).totalSupply();
    return UniV2Oracle.computeAverageAmountOut(
      observation1.priceCumulativeLast, observation2.priceCumulativeLast,
      timeElapsed, totalSupply
    );
  }

  /**
   * @dev Compute the average value in stablecoins of a given amount
   * of a token.
   * Queries the current cumulative price and retrieves the last stored
   * cumulative price, then calculates the average price and multiplies it
   * by the input amount.
   */
  function computeAverageAmountOut(address token, uint256 amountIn)
  public view returns (uint144 amountOut) {
    // Get the stored price observation
    PriceObservation memory observation1 = lastObservedPrices[token];
    // Get the current cumulative price
    PriceObservation memory observation2 = _observePrice(token);
    // Extrapolate the average value of the total supply.
    uint32 timeElapsed = uint32(observation2.timestamp - observation1.timestamp);
    require(timeElapsed <= MIN_UPDATE_PERIOD, "Outdated price info.");
    return UniV2Oracle.computeAverageAmountOut(
      observation1.priceCumulativeLast, observation2.priceCumulativeLast,
      timeElapsed, amountIn
    );
  }

  /**
   * @dev Returns the average market caps for each token.
   */
  function computeAverageMarketCaps(address[] memory tokens)
  public view returns (uint144[] memory marketCaps) {
    uint256 len = tokens.length;
    marketCaps = new uint144[](len);
    for (uint256 i = 0; i < len; i++) {
      marketCaps[i] = computeAverageMarketCap(tokens[i]);
    }
  }

  /**
   * @dev Returns the UQ112x112 struct representing the average price.
   */
  function computeAveragePrice(address token)
  public view returns (FixedPoint.uq112x112 memory priceAverage) {
    // Get the stored price observation
    PriceObservation memory observation1 = lastObservedPrices[token];
    // Get the current cumulative price
    PriceObservation memory observation2 = _observePrice(token);
    // Extrapolate the average value of the total supply.
    uint32 timeElapsed = uint32(observation2.timestamp - observation1.timestamp);
    require(timeElapsed <= MIN_UPDATE_PERIOD, "Outdated price info.");
    return UniV2Oracle.computeAveragePrice(
      observation1.priceCumulativeLast,
      observation2.priceCumulativeLast,
      timeElapsed
    );
  }

  /**
   * @dev Returns the average market caps for each token.
   */
  function computeAveragePrices(address[] memory tokens)
  public view returns (FixedPoint.uq112x112[] memory averagePrices) {
    uint256 len = tokens.length;
    averagePrices = new FixedPoint.uq112x112[](len);
    for (uint256 i = 0; i < len; i++) {
      averagePrices[i] = computeAveragePrice(tokens[i]);
    }
  }

  /**
   * @dev Query the current cumulative price for a token.
   */
  function _observePrice(address token) internal view returns (PriceObservation memory) {
    (uint priceCumulative, uint32 blockTimestamp) = UniV2Oracle.getCurrentCumulativePrice(
      uniswapFactory, token, stableCoin
    );
    return PriceObservation(blockTimestamp, uint224(priceCumulative));
  }
}