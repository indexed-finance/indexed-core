// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;

import "../OwnableProxy.sol";


contract OwnableProxyMock is OwnableProxy {
  bool public didSetValue;

  constructor() public OwnableProxy() {}

  function initialize() external {
    _initializeOwnership();
  }

  function testOwnership() external onlyOwner {
    didSetValue = !didSetValue;
  }
}