pragma solidity ^0.6.0;


interface ProxyDeployer {
  function getImplementationAddress() external view returns (address);
}

/**
 * @dev Upgradeable delegatecall proxy for a single contract.
 */
contract DelegateCallProxyOneToOne {
/* ---  Storage  --- */
  address internal _implementationAddress;
  address internal _owner;

/* ---  Modifiers  --- */
  modifier _owner_ {
    require(msg.sender == _owner, "ERR_NOT_OWNER");
    _;
  }

/* ---  Constructor  --- */
  constructor() public {
    // Calls the sender rather than receiving the address in the constructor
    // arguments so that the address is computable using create2.
    _implementationAddress = ProxyDeployer(msg.sender).getImplementationAddress();
    _owner = msg.sender;
  }

/* ---  Fallbacks  --- */
  receive() external payable {
    return;
  }

  fallback() external payable {
    (
      bool success,
      bytes memory data
    ) = _implementationAddress.delegatecall(msg.data);
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
    _implementationAddress = implementationAddress;
  }

  /**
   * @dev Sets the owner address.
   */
  function setOwnerAddress(address owner) external _owner_ {
    require(owner != address(0), "ERR_NULL_ADDRESS");
    _owner = owner;
  }
}
