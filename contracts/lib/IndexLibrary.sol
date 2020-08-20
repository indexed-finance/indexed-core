pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./FixedPoint.sol";
import "../interfaces/IERC20.sol";
import "./Babylonian.sol";

library IndexLibrary {
  using Babylonian for uint256;
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;

  /**
   * @dev Compute the average market cap of a token by extrapolating the
   * average price to the token's total supply.
   * @param token Address of the ERC20 token
   * @param averagePrice Average price of the token from UniSwap.
   * @return Extrapolated average market cap.
   */
  function computeAverageMarketCap(
    address token,
    FixedPoint.uq112x112 memory averagePrice
  ) internal view returns (uint144) {
    uint256 totalSupply = IERC20(token).totalSupply();
    return averagePrice.mul(totalSupply).decode144();
  }

  /**
   * @dev Calculate the square roots of the market caps of the indexed tokens.
   * @param tokens Array of ERC20 tokens to get the market cap square roots for.
   * @param averagePrices Array of average prices from UniSwap. Must be in the
   * same order as the tokens array.
   * @return sqrts Array of market cap square roots for the provided tokens.
   */
  function computeMarketCapSqrts(
    address[] memory tokens,
    FixedPoint.uq112x112[] memory averagePrices
  ) internal view returns (uint112[] memory sqrts) {
    uint256 len = tokens.length;
    sqrts = new uint112[](len);
    for (uint256 i = 0; i < len; i++) {
      uint256 marketCap = computeAverageMarketCap(tokens[i], averagePrices[i]);
      sqrts[i] = uint112(marketCap.sqrt());
    }
  }

    /**
   * @dev Calculate the weights of the provided tokens.
   * The weight of a token is the square root of its market cap
   * divided by the sum of market cap square roots.
   * @param tokens Array of ERC20 tokens to weigh
   * @param averagePrices Array of average prices from UniSwap for the tokens array.
   * @return weights Array of token weights represented as fractions of the sum of roots.
   */
  function computeTokenWeights(
    address[] memory tokens,
    FixedPoint.uq112x112[] memory averagePrices
  ) internal view returns (FixedPoint.uq112x112[] memory weights) {
    // Get the square roots of token market caps
    uint112[] memory sqrts = computeMarketCapSqrts(tokens, averagePrices);
    uint112 rootSum;
    uint256 len = sqrts.length;
    // Calculate the sum of square roots
    // Will not overflow - would need 72057594037927940 tokens in the index
    // before the sum of sqrts of a uint112 could overflow
    for (uint256 i = 0; i < len; i++) rootSum += sqrts[i];
    // Initialize the array of weights
    weights = new FixedPoint.uq112x112[](len);
    // Calculate the token weights as fractions of the root sum.
    for (uint256 i = 0; i < len; i++) {
      weights[i] = FixedPoint.fraction(sqrts[i], rootSum);
    }
  }

  /**
   * @dev Computes the weighted balance of a token relative to the
   * total value of the index. Multiplies the total value by the weight,
   * then multiplies by the reciprocal of the price (equivalent to dividing
   * by price, but without rounding the price).
   * @param totalValue Total value of the index in the stablecoin
   * @param weight Fraction of the total value that should be held in the token.
   * @param averagePrice Average price of the token on UniSwap.
   * @return weightedBalance Desired balance of the token based on the weighted value.
   */
  function computeWeightedBalance(
    uint144 totalValue,
    FixedPoint.uq112x112 memory weight,
    FixedPoint.uq112x112 memory averagePrice
  ) internal pure returns (uint144 weightedBalance) {
    uint144 desiredValue = weight.mul(totalValue).decode144();
    // Multiply by reciprocal to avoid rounding in intermediary steps.
    return averagePrice.reciprocal().mul(desiredValue).decode144();
  }

  function computePoolValue(
    address poolAddress,
    address[] memory tokens,
    FixedPoint.uq112x112[] memory averagePrices
  ) internal view returns (uint256 totalValue) {
    for (uint256 i = 0; i < tokens.length; i++) {
      IERC20 token = IERC20(tokens[i]);
      FixedPoint.uq112x112 memory averagePrice = averagePrices[i];
      uint256 balance = token.balanceOf(poolAddress);
      totalValue += averagePrice.mul(balance).decode144();
    }
  }
}
