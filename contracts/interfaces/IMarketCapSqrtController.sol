// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;

import "@indexed-finance/uniswap-v2-oracle/contracts/interfaces/IIndexedUniswapV2Oracle.sol";


interface IMarketCapSqrtController {
/* ========== Events ========== */

  event CategoryAdded(uint256 categoryID, bytes32 metadataHash);

  event CategorySorted(uint256 categoryID);

  event TokenAdded(address token, uint256 categoryID);

  event PoolInitialized(
    address pool,
    address unboundTokenSeller,
    uint256 categoryID,
    uint256 indexSize
  );

  event NewPoolInitializer(
    address pool,
    address initializer,
    uint256 categoryID,
    uint256 indexSize
  );

/* ========== Mutative ========== */

  function updateCategoryPrices(uint256 categoryID) external;

  function createCategory(bytes32 metadataHash) external;

  function addToken(uint256 categoryID, address token) external;

  function addTokens(uint256 categoryID, address[] calldata tokens) external;

  function removeToken(uint256 categoryID, address token) external;

  function orderCategoryTokensByMarketCap(uint256 categoryID) external;

/* ========== Views ========== */

  function categoryIndex() external view returns (uint256);

  function oracle() external view returns (IIndexedUniswapV2Oracle);

  function computeAverageMarketCap(address token) external view returns (uint144);

  function computeAverageMarketCaps(address[] calldata tokens) external view returns (uint144[] memory);

  function hasCategory(uint256 categoryID) external view returns (bool);

  function getLastCategoryUpdate(uint256 categoryID) external view returns (uint256);

  function isTokenInCategory(uint256 categoryID, address token) external view returns (bool);

  function getCategoryTokens(uint256 categoryID) external view returns (address[] memory);

  function getCategoryMarketCaps(uint256 categoryID) external view returns (uint144[] memory);

  function getTopCategoryTokens(uint256 categoryID, uint256 num) external view returns (address[] memory);
}