// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.0;


/**
 * @dev Proxy contract which uses an implementation address shared with many
 * other proxies.
 *
 * An implementation holder contract stores the upgradeable logic address, and
 * the proxy contract calls the implementation holder to execute each delegated
 * transaction.
 */
contract DelegateCallProxyManyToOne {
/* ---  Constants  --- */

  // Address that stores the implementation address.
  ImplementationHolder internal immutable _implementationHolder;

/* ---  Constructor  --- */

  constructor() public {
    // Calls the sender rather than receiving the address in the constructor
    // arguments so that the address is computable using create2.
    _implementationHolder = ProxyDeployer(msg.sender).getImplementationHolder();
  }

/* ---  Fallbacks  --- */

  receive() external payable {
    return;
  }

  fallback() external payable {
    address implementationAddress = _implementationHolder.getImplementationAddress();
    // Don't check impl for null address - this is checked in the holder contract.
    (
      bool success,
      bytes memory data
    ) = implementationAddress.delegatecall(msg.data);
    if (success) {
      assembly { return(add(data, 32), mload(data)) }
    } else {
      assembly { revert(add(data, 32), mload(data)) }
    }
  }
}


interface ImplementationHolder {
  function getImplementationAddress() external view returns (address);
}


interface ProxyDeployer {
  function getImplementationHolder() external view returns (ImplementationHolder);
}