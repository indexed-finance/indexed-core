// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

/* ========== External Interfaces ========== */
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/* ========== External Libraries ========== */
import "@indexed-finance/uniswap-v2-oracle/contracts/lib/PriceLibrary.sol";
import "@indexed-finance/uniswap-v2-oracle/contracts/lib/FixedPoint.sol";

/* ========== Internal Libraries ========== */
import "./Babylonian.sol";


library MCapSqrtLibrary {
  using Babylonian for uint256;
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;
  using PriceLibrary for PriceLibrary.TwoWayAveragePrice;

  /**
   * @dev Compute the average market cap of a token by extrapolating the
   * average price to the token's total supply.
   * @param token Address of the ERC20 token
   * @param averagePrice Two-way average price of the token (token-weth & weth-token).
   * @return Extrapolated average market cap.
   */
  function computeAverageMarketCap(
    address token,
    PriceLibrary.TwoWayAveragePrice memory averagePrice
  ) internal view returns (uint144) {
    uint256 totalSupply = IERC20(token).totalSupply();
    return averagePrice.computeAverageEthForTokens(totalSupply);
  }

  /**
   * @dev Calculate the square roots of the market caps of the indexed tokens.
   * @param tokens Array of ERC20 tokens to get the market cap square roots for.
   * @param averagePrices Array of two-way average prices of each token.
   *  - Must be in the same order as the tokens array.
   * @return sqrts Array of market cap square roots for the provided tokens.
   */
  function computeMarketCapSqrts(
    address[] memory tokens,
    PriceLibrary.TwoWayAveragePrice[] memory averagePrices
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
    PriceLibrary.TwoWayAveragePrice[] memory averagePrices
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
   * @param averagePrice Two-way average price of the token.
   * @return weightedBalance Desired balance of the token based on the weighted value.
   */
  function computeWeightedBalance(
    uint144 totalValue,
    FixedPoint.uq112x112 memory weight,
    PriceLibrary.TwoWayAveragePrice memory averagePrice
  ) internal pure returns (uint144 weightedBalance) {
    uint144 desiredWethValue = weight.mul(totalValue).decode144();
    // Multiply by reciprocal to avoid rounding in intermediary steps.
    return averagePrice.computeAverageTokensForEth(desiredWethValue);
  }
}
