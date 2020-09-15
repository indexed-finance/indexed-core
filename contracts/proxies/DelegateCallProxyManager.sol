pragma solidity ^0.6.0;

import "../lib/Create2.sol";
import "./ManyToOneImplementationHolder.sol";
import {
  DelegateCallProxyManyToOne
} from "./DelegateCallProxyManyToOne.sol";
import {
  DelegateCallProxyOneToOne
} from "./DelegateCallProxyOneToOne.sol";

/**
 * @dev Contract that manages deployments and upgrades of delegatecall proxies.
 * 
 */
contract DelegateCallProxyManager {
/* ---  Structs  --- */
  struct ManyToOneImplementation {
    address implementationHolder;
    uint96 proxyIndex;
  }

/* ---  Events  --- */
  event ManyToOne_ImplementationCreated(
    bytes32 implementationID,
    address implementationAddress
  );

  event ManyToOne_ImplementationUpdated(
    bytes32 implementationID,
    address implementationAddress
  );

  event ManyToOne_ProxyDeployed(
    bytes32 implementationID,
    uint96 proxyIndex,
    address proxyAddress
  );

  event OneToOne_ProxyDeployed(
    address proxyAddress,
    address implementationAddress
  );

  event OneToOne_ImplementationUpdated(
    address proxyAddress,
    address implementationAddress
  );

/* ---  Storage  --- */
  address internal _owner;

  // Maps the implementation holder addresses for one-to-many proxies
  // by ID, which is an arbitrary value selected by the controller.
  mapping(bytes32 => ManyToOneImplementation) internal _implementationHolders;

  // These are temporary values used in proxy constructors.
  address internal _implementationAddress;
  address internal _implementationHolder;

/* ---  Modifiers  --- */
  modifier _owner_ {
    require(msg.sender == _owner, "ERR_NOT_OWNER");
    _;
  }

  modifier setsTempImplementation(address implementationAddress) {
    require(
      implementationAddress != address(0),
      "ERR_NULL_ADDRESS"
    );
    _implementationAddress = implementationAddress;
    _;
    _implementationAddress = address(0);
  }

  constructor() public {
    _owner = msg.sender;
  }

/* ---  Controls  --- */
  /**
   * @dev Sets the owner address.
   */
  function setOwner(address owner) external _owner_ {
    _owner = owner;
  }

  /**
   * @dev Creates a many-to-one proxy relationship.
   *
   * Deploys an implementation holder contract which stores the
   * implementation address for many proxies. The implementation
   * address can be updated on the holder to change the runtime
   * code used by all its proxies.
   *
   * @param implementationID ID for the implementation, used to identify the
   * proxies that use it. Also used as the salt in the create2 call when
   * deploying the implementation holder contract.
   * @param implementationAddress Address with the runtime code the proxies
   * should use.
   */
  function createManyToOneProxyRelationship(
    bytes32 implementationID,
    address implementationAddress
  )
    external
    _owner_
    setsTempImplementation(implementationAddress)
  {
    ManyToOneImplementation storage impl = _implementationHolders[implementationID];
    require(
      impl.implementationHolder == address(0),
      "ERR_ID_IN_USE"
    );
    address implementationHolder = Create2.deploy(
      0,
      implementationID,
      type(ManyToOneImplementationHolder).creationCode
    );
    impl.implementationHolder = implementationHolder;
    emit ManyToOne_ImplementationCreated(
      implementationID,
      implementationAddress
    );
  }

  /**
   * @dev Updates the implementation address for a many-to-one
   * proxy relationship.
   *
   * @param implementationID Address of the deployed proxy
   * @param implementationAddress Address with the runtime code for
   * the proxies to use.
   */
  function setImplementationAddressManyToOne(
    bytes32 implementationID,
    address implementationAddress
  ) external _owner_ {
    ManyToOneImplementation storage impl = _implementationHolders[implementationID];
    address implementationHolder = impl.implementationHolder;
    require(
      implementationHolder != address(0),
      "ERR_IMPLEMENTATION_ID"
    );
    ManyToOneImplementationHolder(implementationHolder).setImplementationAddress(
      implementationAddress
    );
    emit ManyToOne_ImplementationUpdated(
      implementationID,
      implementationAddress
    );
  }

  /**
   * @dev Deploy a proxy with a many-to-one relationship with its implemenation.
   *
   * The proxy will call the implementation holder for every transaction to determine
   * the address to use in calls.
   *
   * @param implementationID Identifier for the proxy's implementation.
   */
  function deployProxyManyToOne(bytes32 implementationID)
    external
    _owner_
    returns(address proxyAddress)
  {
    ManyToOneImplementation storage impl = _implementationHolders[implementationID];
    address implementationHolder = impl.implementationHolder;
    require(
      implementationHolder != address(0),
      "ERR_IMPLEMENTATION_ID"
    );

    // The create2 salt is derived from the implementation ID and the proxy index.
    uint96 proxyIndex = impl.proxyIndex++;
    bytes32 salt = keccak256(abi.encodePacked(implementationID, proxyIndex));

    // Set the implementation holder so the proxy constructor can query it.
    _implementationHolder = implementationHolder;
    proxyAddress = Create2.deploy(
      0,
      salt,
      type(DelegateCallProxyManyToOne).creationCode
    );
    // Remove the address from storage.
    _implementationHolder = address(0);

    emit ManyToOne_ProxyDeployed(
      implementationID,
      proxyIndex,
      proxyAddress
    );
  }

  /**
   * @dev Deploy a proxy contract with a one-to-one relationship
   * with its implementation.
   *
   * The proxy will have its own implementation address which can
   * be updated by the proxy manager.
   *
   * @param salt Salt to use for the create2 call
   * @param implementationAddress Address with the runtime code the proxy
   * should use.
   */
  function deployProxyOneToOne(
    bytes32 salt,
    address implementationAddress
  )
    external
    _owner_
    setsTempImplementation(implementationAddress)
  {
    address proxyAddress = Create2.deploy(
      0,
      salt,
      type(DelegateCallProxyOneToOne).creationCode
    );
    emit OneToOne_ProxyDeployed(
      proxyAddress,
      implementationAddress
    );
  }

  /**
   * @dev Updates the implementation address for a one-to-one proxy.
   *
   * Note: This could work for many-to-one as well if the caller
   * provides the implementation holder address in place of the
   * proxy address.
   *
   * @param proxyAddress Address of the deployed proxy
   * @param implementationAddress Address with the runtime code for
   * the proxy to use.
   */
  function setImplementationAddressOneToOne(
    address payable proxyAddress,
    address implementationAddress
  ) external _owner_ {
    DelegateCallProxyOneToOne(proxyAddress).setImplementationAddress(
      implementationAddress
    );
    emit OneToOne_ImplementationUpdated(
      proxyAddress,
      implementationAddress
    );
  }

/* ---  Queries  --- */
  function getImplementationAddress() external view returns (address) {
    return _implementationAddress;
  }

  function getImplementationHolder() external view returns (address) {
    return _implementationHolder;
  }
}