// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;


interface IPoolInitializer {
/* ========== Events ========== */

  event TokensContributed(
    address from,
    address token,
    uint256 amount,
    uint256 credit
  );

/* ========== Mutative ========== */

  function initialize(
    address poolAddress,
    address[] calldata tokens,
    uint256[] calldata amounts
  ) external;

  function finish() external;

  function claimTokens() external;

  function claimTokens(address account) external;

  function claimTokens(address[] calldata accounts) external;

  function contributeTokens(
    address token,
    uint256 amountIn,
    uint256 minimumCredit
  ) external returns (uint256);

  function contributeTokens(
    address[] calldata tokens,
    uint256[] calldata amountsIn,
    uint256 minimumCredit
  ) external returns (uint256);

  function updatePrices() external;

/* ========== Views ========== */

  function isFinished() external view returns (bool);

  function getTotalCredit() external view returns (uint256);

  function getCreditOf(address account) external view returns (uint256);

  function getDesiredTokens() external view returns (address[] memory);

  function getDesiredAmount(address token) external view returns (uint256);

  function getDesiredAmounts(address[] calldata tokens) external view returns (uint256[] memory);

  function getCreditForTokens(address token, uint256 amountIn) external view returns (uint144);
}