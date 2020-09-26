pragma solidity ^0.6.0;

import {
  DelegateCallProxyManager
} from "../proxies/DelegateCallProxyManager.sol";


contract MockProxyApprovedDeployer {
  DelegateCallProxyManager internal _proxyManager;

  constructor(DelegateCallProxyManager proxyManager) public {
    _proxyManager = proxyManager;
  }

  function testDeploy_NotApproved(
    bytes32 implementationID,
    bytes32 salt
  ) external {
    try _proxyManager.deployProxyManyToOne(
      implementationID,
      salt
    ) returns (address) {
      revert("ERR_ERROR_EXPECTED");
    } catch Error(string memory reason) {
      require(
        keccak256(bytes(reason)) == keccak256("ERR_NOT_APPROVED"),
        "INVALID_ERROR_MESSAGE"
      );
      return;
    }
  }

  function testDeploy_Approved(
    bytes32 implementationID,
    bytes32 salt
  ) external {
    address deployed = _proxyManager.deployProxyManyToOne(
      implementationID,
      salt
    );
    address expected = _proxyManager.computeProxyAddressManyToOne(
      address(this),
      implementationID,
      salt
    );
    require(deployed == expected, "ERR_INVALID_ADDRESS");
  }
}