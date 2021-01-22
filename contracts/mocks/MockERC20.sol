// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";


contract MockERC20 is ERC20 {
  mapping(address => address) public delegateeByAddress;

  constructor(string memory name, string memory symbol) public ERC20(name, symbol) {}

  // Mocks WETH deposit fn
  function deposit() external payable {
    _mint(msg.sender, msg.value);
  }

  function getFreeTokens(address to, uint256 amount) public {
    _mint(to, amount);
  }

  function delegate(address delegatee) external {
    delegateeByAddress[msg.sender] = delegatee;
  }
}