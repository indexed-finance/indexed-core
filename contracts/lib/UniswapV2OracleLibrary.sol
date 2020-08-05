pragma solidity ^0.6.0;

import '../interfaces/IUniswapV2Pair.sol';
import "./UniswapV2Library.sol";
import './FixedPoint.sol';

// library with helper methods for oracles that are concerned with computing average prices
library UniswapV2OracleLibrary {
  using FixedPoint for *;

  // helper function that returns the current block timestamp within the range of uint32, i.e. [0, 2**32 - 1]
  function currentBlockTimestamp() internal view returns (uint32) {
    return uint32(block.timestamp % 2 ** 32);
  }

  // produces the cumulative prices using counterfactuals to save gas and avoid a call to sync.
  function currentCumulativePrices(
    address pair
  ) internal view returns (uint price0Cumulative, uint price1Cumulative, uint32 blockTimestamp) {
    blockTimestamp = currentBlockTimestamp();
    price0Cumulative = IUniswapV2Pair(pair).price0CumulativeLast();
    price1Cumulative = IUniswapV2Pair(pair).price1CumulativeLast();

    // if time has elapsed since the last update on the pair, mock the accumulated price values
    (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = IUniswapV2Pair(pair).getReserves();
    if (blockTimestampLast != blockTimestamp) {
      // subtraction overflow is desired
      uint32 timeElapsed = blockTimestamp - blockTimestampLast;
      // addition overflow is desired
      // counterfactual
      price0Cumulative += uint(FixedPoint.fraction(reserve1, reserve0)._x) * timeElapsed;
      // counterfactual
      price1Cumulative += uint(FixedPoint.fraction(reserve0, reserve1)._x) * timeElapsed;
    }
  }

  // produces the cumulative price using counterfactuals to save gas and avoid a call to sync.
  // only gets the first price
  function currentCumulativePrice0(
    address pair
  ) internal view returns (uint price0Cumulative, uint32 blockTimestamp) {
    blockTimestamp = currentBlockTimestamp();
    price0Cumulative = IUniswapV2Pair(pair).price0CumulativeLast();

    // if time has elapsed since the last update on the pair, mock the accumulated price values
    (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = IUniswapV2Pair(pair).getReserves();
    if (blockTimestampLast != blockTimestamp) {
      // subtraction overflow is desired
      uint32 timeElapsed = blockTimestamp - blockTimestampLast;
      // addition overflow is desired
      // counterfactual
      price0Cumulative += uint(FixedPoint.fraction(reserve1, reserve0)._x) * timeElapsed;
    }
  }

  // produces the cumulative price using counterfactuals to save gas and avoid a call to sync.
  // only gets the second price
  function currentCumulativePrice1(
    address pair
  ) internal view returns (uint price1Cumulative, uint32 blockTimestamp) {
    blockTimestamp = currentBlockTimestamp();
    price1Cumulative = IUniswapV2Pair(pair).price1CumulativeLast();

    // if time has elapsed since the last update on the pair, mock the accumulated price values
    (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = IUniswapV2Pair(pair).getReserves();
    if (blockTimestampLast != blockTimestamp) {
      // subtraction overflow is desired
      uint32 timeElapsed = blockTimestamp - blockTimestampLast;
      // addition overflow is desired
      // counterfactual
      price1Cumulative += uint(FixedPoint.fraction(reserve0, reserve1)._x) * timeElapsed;
    }
  }

  function getCurrentCumulativePrice(
    address factory, address tokenIn, address tokenOut
  ) internal view returns (uint priceCumulative, uint32 blockTimestamp) {
    (address token0, address token1) = UniswapV2Library.sortTokens(tokenIn, tokenOut);
    address pair = UniswapV2Library.calculatePair(factory, token0, token1);
    if (tokenIn == token0) return currentCumulativePrice0(pair);
    return currentCumulativePrice1(pair);
  }

  function computeAveragePrice(
    uint224 priceCumulativeStart,
    uint224 priceCumulativeEnd,
    uint32 timeElapsed
  ) internal pure returns (FixedPoint.uq112x112 memory priceAverage) {
    // overflow is desired.
    priceAverage = FixedPoint.uq112x112(
      uint224((priceCumulativeEnd - priceCumulativeStart) / timeElapsed)
    );
  }

  function computeAverageAmountOut(
    uint224 priceCumulativeStart, uint224 priceCumulativeEnd,
    uint32 timeElapsed, uint256 amountIn
  ) internal pure returns (uint144 amountOut) {
    // overflow is desired.
    FixedPoint.uq112x112 memory priceAverage = computeAveragePrice(
      priceCumulativeStart,
      priceCumulativeEnd,
      timeElapsed
    );
    amountOut = priceAverage.mul(amountIn).decode144();
  }
}