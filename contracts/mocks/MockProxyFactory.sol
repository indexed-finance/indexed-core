pragma solidity ^0.6.0;

import "./MockProxyLogic.sol";
import "../lib/ProxyLib.sol";


contract MockProxyFactory {
  address logicAddress;

  event ProxyDeployed(address proxyAddress);

  constructor() public {
    logicAddress = address(new MockProxyLogic());
  }

  function getProxyAddress(bytes32 salt) external view returns (address) {
    return ProxyLib.computeProxyAddress(logicAddress, salt);
  }

  function compareCodeHash(bytes32 salt) external view returns (bool) {
    address proxyAddress = ProxyLib.computeProxyAddress(logicAddress, salt);
    bytes32 _codehash;
    assembly { _codehash := extcodehash(proxyAddress) }
    return _codehash == keccak256(getProxyRuntimeCode());
  }

  function deployProxy(bytes32 salt) public {
    address proxyAddress = ProxyLib.deployProxy(logicAddress, salt);
    emit ProxyDeployed(proxyAddress);
  }

  function getProxyRuntimeCode() internal view returns (bytes memory) {
    address runtimeCodeAddress = logicAddress;
    bytes memory deploymentCode = new bytes(46);
    assembly {
      let ptr := add(deploymentCode, 32)
      mstore(ptr,          0x5959365936595937730000000000000000000000000000000000000000000000)
      mstore(add(ptr, 9), shl(96, runtimeCodeAddress))
      mstore(add(ptr, 29), 0x5af460003d3d82803e9161002c57fd5bf3000000000000000000000000000000)
    }
    return deploymentCode;
  }
}