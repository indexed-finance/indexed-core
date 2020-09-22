// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;

import "./BaseERC20.sol";


contract MockERC20 is BaseERC20 {
  constructor(
    string memory name,
    string memory symbol
  ) public BaseERC20(name, symbol) {}

  // Mocks WETH deposit fn
  function deposit() external payable {
    _mint(msg.sender, msg.value);
  }

  function getFreeTokens(address to, uint256 amount) public {
    _mint(to, amount);
  }

  /**
   * @dev Creates `amount` tokens and assigns them to `account`, increasing
   * the total supply.
   * Emits a {Transfer} event with `from` set to the zero address.
   *
   * Requirements:
   * - `to` cannot be the zero address.
   */
  function _mint(address account, uint256 amount) internal virtual {
    require(account != address(0), "ERC20: mint to the zero address");
    _totalSupply = _totalSupply.add(amount);
    _balances[account] = _balances[account].add(amount);
    emit Transfer(address(0), account, amount);
  }
}