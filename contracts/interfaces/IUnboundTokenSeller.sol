// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;


interface IUnboundTokenSeller {
/* ========== Events ========== */

  event PremiumPercentSet(uint8 premium);

  event NewTokensToSell(address indexed token, uint256 amountReceived);

  event SwappedTokens(
    address indexed tokenSold,
    address indexed tokenBought,
    uint256 soldAmount,
    uint256 boughtAmount
  );

/* ========== Mutative ========== */

  function initialize(address pool, uint8 premiumPercent) external;

  function handleUnbindToken(address token, uint256 amount) external;

  function setPremiumPercent(uint8 premiumPercent) external;

  function executeSwapTokensForExactTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountOut,
    address[] calldata path
  ) external returns (uint256);

  function executeSwapExactTokensForTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    address[] calldata path
  ) external returns (uint256);

  function swapExactTokensForTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minAmountOut
  ) external returns (uint256);

  function swapTokensForExactTokens(
    address tokenIn,
    address tokenOut,
    uint256 amountOut,
    uint256 maxAmountIn
  ) external returns (uint256);

/* ========== Views ========== */

  function getPremiumPercent() external view returns (uint8);

  function calcInGivenOut(
    address tokenIn,
    address tokenOut,
    uint256 amountOut
  ) external view returns (uint256);

  function calcOutGivenIn(
    address tokenIn,
    address tokenOut,
    uint256 amountIn
  ) external view returns (uint256);
}