pragma solidity ^0.6.0;


/**
 * @dev Upgradeable delegatecall proxy for a single contract.
 * This proxy stores an implementation address which can be
 * upgraded by the proxy manager.
 */
contract DelegateCallProxyOneToOne {
/* ---  Constants  --- */
  bytes32 internal constant IMPLEMENTATION_ADDRESS_SLOT = keccak256(
    "IMPLEMENTATION_ADDRESS"
  );

  bytes32 internal constant OWNER_SLOT = keccak256(
    "OWNER"
  );

/* ---  Modifiers  --- */
  modifier _owner_ {
    address owner;
    bytes32 slot = OWNER_SLOT;
    assembly { owner := sload(slot) }
    require(msg.sender == owner, "ERR_NOT_OWNER");
    _;
  }

/* ---  Constructor  --- */
  constructor() public {
    address owner = msg.sender;
    bytes32 slot = OWNER_SLOT;
    assembly {
      sstore(slot, owner)
    }
  }

/* ---  Fallbacks  --- */
  fallback() external payable {
    bytes32 slot = IMPLEMENTATION_ADDRESS_SLOT;
    address implementationAddress;
    assembly {
      implementationAddress := sload(slot)
    }
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

/* ---  Controls  --- */
  /**
   * @dev Sets the implementation address the proxy should use.
   */
  function setImplementationAddress(
    address implementationAddress
  )
    external
    _owner_
  {
    require(
      implementationAddress != address(0),
      "ERR_NULL_ADDRESS"
    );
    bytes32 slot = IMPLEMENTATION_ADDRESS_SLOT;
    assembly { sstore(slot, implementationAddress) }
  }

  /**
   * @dev Sets the owner address.
   */
  function setOwnerAddress(address owner) external _owner_ {
    require(owner != address(0), "ERR_NULL_ADDRESS");
    
    bytes32 slot = OWNER_SLOT;

    assembly { sstore(slot, owner) }
  }
}


interface ProxyDeployer {
  function getImplementationAddress() external view returns (address);
}