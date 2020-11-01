// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;

interface IFlashLoanRecipient {
  function receiveFlashLoan(
    address tokenBorrowed,
    uint256 amountBorrowed,
    uint256 amountDue,
    bytes calldata data
  ) external;
}