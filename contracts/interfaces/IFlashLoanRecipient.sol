pragma solidity ^0.6.0;

interface IFlashLoanRecipient {
  function receiveFlashLoan(bytes calldata data) external;
}