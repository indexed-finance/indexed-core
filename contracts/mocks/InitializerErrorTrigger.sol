// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;
import "./MockERC20.sol";


interface Controller {
  function finishPreparedIndexPool(
    address poolAddress,
    address[] calldata tokens,
    uint256[] calldata balances
  ) external;
}


contract InitializerErrorTrigger {
  Controller internal _controller;
  address internal _pool;
  address[] internal _tokens;
  uint256[] internal _balances;

  function initialize(address pool, address[] calldata tokens, uint256[] calldata balances) external {
    _tokens = tokens;
    _balances = balances;
    _pool = pool;
    _controller = Controller(msg.sender);
  }

  function triggerArrLenError() external {
    uint256[] memory balances = new uint256[](_balances.length - 1);
    _controller.finishPreparedIndexPool(_pool, _tokens, balances);
  }

  function triggerDuplicateInit() external {
    address[] memory tokens = _tokens;
    uint256[] memory balances = _balances;
    address pool = _pool;
    for (uint256 i = 0; i < tokens.length; i++) {
      MockERC20(tokens[i]).getFreeTokens(address(this), balances[i]);
      MockERC20(tokens[i]).approve(pool, balances[i]);
    }
    _controller.finishPreparedIndexPool(pool, tokens, balances);
    _controller.finishPreparedIndexPool(pool, tokens, balances);
  }
}