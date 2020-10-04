// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
import "./FixedPoint.sol";
import {
  UniswapV2OracleLibrary as UniV2Oracle
} from "./UniswapV2OracleLibrary.sol";
import "./UniswapV2Library.sol";


library PriceLibrary {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;

  struct PriceObservation {
    uint32 timestamp;
    uint224 priceCumulativeLast;
    uint224 ethPriceCumulativeLast;
  }

  /**
   * @dev Average prices for a token in terms of weth
   * and weth in terms of the token.
   *
   * Note: The average weth price is not equivalent to the
   * reciprocal of the average token price.
   * See the UniSwap whitepaper for more info.
   */
  struct TwoWayAveragePrice {
    FixedPoint.uq112x112 priceAverage;
    FixedPoint.uq112x112 ethPriceAverage;
  }

  /**
   * @dev Computes the average price of a token in terms of weth
   * and the average price of weth in terms of a token using two
   * price observations.
   */
  function computeTwoWayAveragePrice(
    PriceObservation memory observation1,
    PriceObservation memory observation2
  ) internal pure returns (TwoWayAveragePrice memory) {
    uint32 timeElapsed = uint32(observation2.timestamp - observation1.timestamp);
    FixedPoint.uq112x112 memory priceAverage = UniV2Oracle.computeAveragePrice(
      observation1.priceCumulativeLast,
      observation2.priceCumulativeLast,
      timeElapsed
    );
    FixedPoint.uq112x112 memory ethPriceAverage = UniV2Oracle.computeAveragePrice(
      observation1.ethPriceCumulativeLast,
      observation2.ethPriceCumulativeLast,
      timeElapsed
    );
    return TwoWayAveragePrice({
      priceAverage: priceAverage,
      ethPriceAverage: ethPriceAverage
    });
  }

  /**
   * @dev Computes the average price of the token the price observations
   * are for in terms of weth.
   */
  function computeAverageTokenPrice(
    PriceObservation memory observation1,
    PriceObservation memory observation2
  ) internal pure returns (FixedPoint.uq112x112 memory) {
    return UniV2Oracle.computeAveragePrice(
      observation1.priceCumulativeLast,
      observation2.priceCumulativeLast,
      uint32(observation2.timestamp - observation1.timestamp)
    );
  }

  /**
   * @dev Computes the average price of weth in terms of the token
   * the price observations are for.
   */
  function computeAverageEthPrice(
    PriceObservation memory observation1,
    PriceObservation memory observation2
  ) internal pure returns (FixedPoint.uq112x112 memory) {
    return UniV2Oracle.computeAveragePrice(
      observation1.ethPriceCumulativeLast,
      observation2.ethPriceCumulativeLast,
      uint32(observation2.timestamp - observation1.timestamp)
    );
  }

  /**
   * @dev Compute the average value in weth of `tokenAmount` of the
   * token that the average price values are for.
   */
  function computeAverageEthForTokens(
    TwoWayAveragePrice memory prices,
    uint256 tokenAmount
  ) internal pure returns (uint144) {
    return prices.priceAverage.mul(tokenAmount).decode144();
  }

  /**
   * @dev Compute the average value of `wethAmount` weth in terms of
   * the token that the average price values are for.
   */
  function computeAverageTokensForEth(
    TwoWayAveragePrice memory prices,
    uint256 wethAmount
  ) internal pure returns (uint144) {
    return prices.ethPriceAverage.mul(wethAmount).decode144();
  }

  /**
   * @dev Query the current cumulative price of a token in terms of weth
   * and the current cumulative price of weth in terms of the token.
   */
  function observePrice(
    address uniswapFactory,
    address token,
    address weth
  ) internal view returns (PriceObservation memory) {
    (address token0, address token1) = UniswapV2Library.sortTokens(token, weth);

    address pair = UniswapV2Library.calculatePair(
      uniswapFactory, token0, token1
    );
    // Get the sorted token prices
    (
      uint256 price0Cumulative,
      uint256 price1Cumulative,
      uint32 blockTimestamp
    ) = UniV2Oracle.currentCumulativePrices(pair);
    // Check which token is weth and which is the token,
    // then build the price observation.
    if (token0 == token) {
      return PriceObservation({
        timestamp: blockTimestamp,
        priceCumulativeLast: uint224(price0Cumulative),
        ethPriceCumulativeLast: uint224(price1Cumulative)
      });
    } else {
      return PriceObservation({
        timestamp: blockTimestamp,
        priceCumulativeLast: uint224(price1Cumulative),
        ethPriceCumulativeLast: uint224(price0Cumulative)
      });
    }
  }
}