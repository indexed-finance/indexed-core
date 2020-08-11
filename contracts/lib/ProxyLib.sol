pragma solidity ^0.6.0;

import "./Create2.sol";


library ProxyLib {
  /**
  -- DELEGATECALL PROXY --
  OPCODE           STACK
  --------------------------
  msize           | 0
  msize           | 0, 0
  calldatasize    | size, 0, 0
  msize           | 0, size, 0, 0
  calldatasize    | size, 0, size, 0, 0
  msize           | 0, size, 0, size, 0, 0
  msize           | 0, 0, size, 0, size, 0, 0
  calldatacopy    | 0, size, 0, 0
  push20 address  | address, 0, size, 0, 0
  gas             | gas, address, 0, size, 0, 0
  delegatecall    | success
  0x00            | 0, success
  returndatasize  | rsize, 0, success
  returndatasize  | rsize, rsize, 0, success
  dup3            | 0, rsize, rsize, 0, success
  dup1            | 0, 0, rsize, rsize, 0, success
  returndatacopy  | rsize, 0, success
  swap2           | success, 0, rsize
  jump_success    | jump_success, success, 0, rsize
  jumpi           | 0, rsize
  revert          |
  jump_success:   | 0, rsize
  return          |

  BYTECODE (with null address)
  59593659365959377300000000000000000000000000000000000000005af460003d3d82803e9161002c57fd5bf3

  -- DEPLOYER SCRIPT --
  OPCODE            STACK
  --------------------------
  push1 <size>     | codesize
  msize            | 0, codesize
  dup2             | codesize, 0, codesize
  push1 <ptr>      | ptr, codesize, 0, codesize
  dup3             | 0, ptr, codesize, 0, codesize
  codecopy         | 0, codesize
  return           |

  BYTECODE (before concatenated with proxy bytecode)
  602e598160098239f3
  */


  function getProxyDeploymentCode(address runtimeCodeAddress) internal pure returns (bytes memory) {
    bytes memory deploymentCode = new bytes(55);
    assembly {
      let ptr := add(deploymentCode, 32)
      mstore(ptr, 0x602e598160098239f35959365936595937730000000000000000000000000000)
      mstore(add(ptr, 18), shl(96, runtimeCodeAddress))
      mstore(add(ptr, 38), 0x5af460003d3d82803e9161002c57fd5bf3000000000000000000000000000000)
    }
    return deploymentCode;
  }

  function deployProxy(address runtimeCodeAddress, bytes32 salt) internal returns (address) {
    return Create2.deploy(0, salt, getProxyDeploymentCode(runtimeCodeAddress));
  }

  function computeProxyAddress(address runtimeCodeAddress, bytes32 salt) internal view returns (address) {
    return Create2.computeAddress(salt, keccak256(getProxyDeploymentCode(runtimeCodeAddress)));
  }
}