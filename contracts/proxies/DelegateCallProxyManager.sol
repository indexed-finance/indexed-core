// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.0;

import "./ManyToOneImplementationHolder.sol";
import {
  DelegateCallProxyManyToOne
} from "./DelegateCallProxyManyToOne.sol";
import {
  DelegateCallProxyOneToOne
} from "./DelegateCallProxyOneToOne.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";


/**
 * @dev Contract that manages deployment and upgrades of delegatecall proxies.
 *
 * An implementation identifier can be created on the proxy manager which is
 * used to specify the logic address for a particular contract type, and to
 * upgrade the implementation as needed.
 *
 * A one-to-one proxy is a single proxy contract with an upgradeable implementation
 * address.
 *
 * A many-to-one proxy is a single upgradeable implementation address that may be
 * used by many proxy contracts.
 */
contract DelegateCallProxyManager {
/* ---  Constants  --- */
  bytes32 internal constant ONE_TO_ONE_CODEHASH
  = keccak256(type(DelegateCallProxyOneToOne).creationCode);

  bytes32 internal constant MANY_TO_ONE_CODEHASH
  = keccak256(type(DelegateCallProxyManyToOne).creationCode);

  bytes32 internal constant IMPLEMENTATION_HOLDER_CODEHASH
  = keccak256(type(ManyToOneImplementationHolder).creationCode);

/* ---  Events  --- */

  event DeploymentApprovalGranted(address deployer);
  event DeploymentApprovalRevoked(address deployer);

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
  mapping(bytes32 => address) internal _implementationHolders;

  // Addresses allowed to deploy many-to-one proxies.
  mapping(address => bool) internal _approvedDeployers;

  // Temporary value used for create2 constructor.
  address internal _implementationHolder;

/* ---  Modifiers  --- */
  modifier _owner_ {
    require(msg.sender == _owner, "ERR_NOT_OWNER");
    _;
  }

  modifier _admin_ {
    require(
      msg.sender == _owner || _approvedDeployers[msg.sender],
      "ERR_NOT_APPROVED"
    );
    _;
  }

/* ---  Constructor  --- */
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
   * @dev Allows `deployer` to deploy many-to-one proxies.
   */
  function approveDeployer(address deployer) external _owner_ {
    _approvedDeployers[deployer] = true;
    emit DeploymentApprovalGranted(deployer);
  }

  /**
   * @dev Prevents `deployer` from deploying many-to-one proxies.
   */
  function revokeDeployerApproval(address deployer) external _owner_ {
    _approvedDeployers[deployer] = false;
    emit DeploymentApprovalRevoked(deployer);
  }

/* ---  Implementation Management  --- */

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
  {
    require(
      _implementationHolders[implementationID] == address(0),
      "ERR_ID_IN_USE"
    );
    address implementationHolder = Create2.deploy(
      0,
      implementationID,
      type(ManyToOneImplementationHolder).creationCode
    );
    ManyToOneImplementationHolder(implementationHolder).setImplementationAddress(
      implementationAddress
    );
    _implementationHolders[implementationID] = implementationHolder;
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
    address implementationHolder = _implementationHolders[implementationID];
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

/* Proxy Deployment */

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
  {
    address proxyAddress = Create2.deploy(
      0,
      salt,
      type(DelegateCallProxyOneToOne).creationCode
    );
    DelegateCallProxyOneToOne(payable(proxyAddress)).setImplementationAddress(
      implementationAddress
    );
    emit OneToOne_ProxyDeployed(
      proxyAddress,
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
   * @param salt Create2 salt to deploy the pool with.
   */
  function deployProxyManyToOne(bytes32 implementationID, bytes32 salt)
    external
    _admin_
    returns(address proxyAddress)
  {
    address implementationHolder = _implementationHolders[implementationID];
    require(
      implementationHolder != address(0),
      "ERR_IMPLEMENTATION_ID"
    );

    // Set the implementation holder so the proxy constructor can query it.
    _implementationHolder = implementationHolder;
    proxyAddress = Create2.deploy(
      0,
      salt,
      type(DelegateCallProxyManyToOne).creationCode
    );
    // Remove the address from temporary storage.
    _implementationHolder = address(0);

    emit ManyToOne_ProxyDeployed(
      implementationID,
      proxyAddress
    );
  }

/* ---  Queries  --- */
  /**
   * @dev Queries the temporary storage value `_implementationHolder`.
   * This is used in the constructor of the many-to-one proxy contract
   * so that the create2 address is static (adding constructor arguments
   * would change the codehash) and the implementation holder can be
   * stored as a constant.
   */
  function getImplementationHolder()
    external
    view
    returns (address)
  {
    return _implementationHolder;
  }

  /**
   * @dev Returns the address of the implementation holder contract
   * for `implementationID`.
   */
  function getImplementationHolder(
    bytes32 implementationID
  )
    external
    view
    returns (address)
  {
    return _implementationHolders[implementationID];
  }

  /**
   * @dev Computes the create2 address for a one-to-one proxy deployed
   * with `salt` as the create2 address.
   */
  function computeProxyAddressOneToOne(bytes32 salt)
    external
    view
    returns (address)
  {
    return Create2.computeAddress(salt, ONE_TO_ONE_CODEHASH);
  }

  /**
   * @dev Computes the create2 address for a many-to-one proxy deployed
   * with `salt` as the create2 salt.
  */
  function computeProxyAddressManyToOne(bytes32 salt)
    external
    view
    returns (address)
  {
    return Create2.computeAddress(salt, MANY_TO_ONE_CODEHASH);
  }

  /**
   * @dev Computes the create2 address of the implementation holder
   * for `implementationID`.
  */
  function computeHolderAddressManyToOne(bytes32 implementationID)
    external
    view
    returns (address)
  {
    return Create2.computeAddress(
      implementationID,
      IMPLEMENTATION_HOLDER_CODEHASH
    );
  }
}