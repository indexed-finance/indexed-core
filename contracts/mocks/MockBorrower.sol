pragma solidity ^0.6.0;

import {MockERC20} from "./MockERC20.sol";
import "../interfaces/IIndexPool.sol";


contract MockBorrower {
  function receiveFlashLoan(
    address tokenBorrowed,
    uint256 amountBorrowed,
    uint256 amountDue,
    bytes calldata data
  ) external {
    (uint256 testScenario) = abi.decode((data), (uint8));
    MockERC20 token = MockERC20(tokenBorrowed);

    if (testScenario == 0) {
      // Repay with fee
      token.getFreeTokens(msg.sender, amountDue);
    } else if (testScenario == 1) {
      // Repay amount borrowed
      token.getFreeTokens(msg.sender, amountBorrowed);
    } else if (testScenario == 2) {
      // Attempt reentry
      IIndexPool(msg.sender).gulp(tokenBorrowed);
    }
  }
}