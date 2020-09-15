pragma solidity ^0.6.0;


interface ProxyDeployer {
  function getImplementationAddress() external view returns (address);
}


/**
 * @dev Stores a single implementation address which is used by
 * many individual proxies.
 */
contract ManyToOneImplementationHolder {
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
    _owner = msg.sender;
  }

/* ---  Queries  --- */

  /**
   * @dev Gets the implementation address.
   */
  function getImplementationAddress() external view returns (address) {
    return _implementationAddress;
  }

/* ---  Controls  --- */
  /**
   * @dev Sets the implementation address.
   */
  function setImplementationAddress(address implementationAddress)
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