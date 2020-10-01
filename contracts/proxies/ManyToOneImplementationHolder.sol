// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;


/**
 * @dev Stores a single implementation address which is used by
 * many proxies.
 *
 * Inspired by the DharmaUpgradeBeacon from 0age
 * dharma-eng/dharma-smart-wallet/contracts/upgradeability/DharmaUpgradeBeacon.sol
 */
contract ManyToOneImplementationHolder {
/* ---  Storage  --- */
  address internal immutable _owner;
  address internal _implementation;

/* ---  Constructor  --- */
  constructor() public {
    _owner = msg.sender;
  }

  /**
   * @dev Fallback function for the contract.
   *
   * Used by proxies to read the implementation address and used
   * by the proxy manager to set the implementation address.
   *
   * If called by the owner, reads the implementation address from
   * calldata (must be abi-encoded) and stores it to the first slot.
   *
   * Otherwise, returns the stored implementation address.
   */
  fallback() external payable {
    if (msg.sender != _owner) {
      assembly {
        mstore(0, sload(0))
        return(0, 32)
      }
    }
    assembly { sstore(0, calldataload(0)) }
  }
}