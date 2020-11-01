pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "@indexed-finance/uniswap-v2-oracle/contracts/interfaces/IIndexedUniswapV2Oracle.sol";
import "@indexed-finance/uniswap-v2-oracle/contracts/lib/PriceLibrary.sol";
import "@indexed-finance/uniswap-v2-oracle/contracts/lib/FixedPoint.sol";


/**
 * Proxy contract to reduce the TWAP period on testnets.
*/
contract OracleFallthrough {
  IIndexedUniswapV2Oracle public oracle;
  address internal immutable _owner;

  constructor(address oracle_) public {
    oracle = IIndexedUniswapV2Oracle(oracle_);
    _owner = msg.sender;
  }

  function setOracle(address oracle_) external {
    oracle = IIndexedUniswapV2Oracle(oracle_);
  }

  /* ==========  Price Queries: Singular  ========== */

  function computeTwoWayAveragePrice(
    address token,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (PriceLibrary.TwoWayAveragePrice memory) {
    return oracle.computeTwoWayAveragePrice(token, 1 minutes, 24 hours);
  }

  function computeAverageTokenPrice(
    address token,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (FixedPoint.uq112x112 memory) {
    return oracle.computeAverageTokenPrice(token, 1 minutes, 24 hours);
  }

  function computeAverageEthPrice(
    address token,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (FixedPoint.uq112x112 memory) {
    return oracle.computeAverageEthPrice(token, 1 minutes, 24 hours);
  }

  /* ==========  Price Queries: Multiple  ========== */

  function computeTwoWayAveragePrices(
    address[] calldata tokens,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (PriceLibrary.TwoWayAveragePrice[] memory) {
    return oracle.computeTwoWayAveragePrices(tokens, 1 minutes, 24 hours);
  }

  function computeAverageTokenPrices(
    address[] calldata tokens,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (FixedPoint.uq112x112[] memory) {
    return oracle.computeAverageTokenPrices(tokens, 1 minutes, 24 hours);
  }

  function computeAverageEthPrices(
    address[] calldata tokens,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (FixedPoint.uq112x112[] memory) {
    return oracle.computeAverageEthPrices(tokens, 1 minutes, 24 hours);
  }

/* ==========  Value Queries: Singular  ========== */

  function computeAverageEthForTokens(
    address token,
    uint256 tokenAmount,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (uint144) {
    return oracle.computeAverageEthForTokens(token, tokenAmount, 1 minutes, 24 hours);
  }

  function computeAverageTokensForEth(
    address token,
    uint256 wethAmount,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (uint144) {
    return oracle.computeAverageTokensForEth(token, wethAmount, 1 minutes, 24 hours);
  }

/* ==========  Value Queries: Multiple  ========== */

  function computeAverageEthForTokens(
    address[] calldata tokens,
    uint256[] calldata tokenAmounts,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (uint144[] memory) {
    return oracle.computeAverageEthForTokens(tokens, tokenAmounts, 1 minutes, 24 hours);
  }

  function computeAverageTokensForEth(
    address[] calldata tokens,
    uint256[] calldata wethAmounts,
    uint256 minTimeElapsed,
    uint256 maxTimeElapsed
  ) external view returns (uint144[] memory) {
    return oracle.computeAverageTokensForEth(tokens, wethAmounts, 1 minutes, 24 hours);
  }
}