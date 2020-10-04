// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;

import "./ManyToOneImplementationHolder.sol";
import {
  DelegateCallProxyManyToOne
} from "./DelegateCallProxyManyToOne.sol";
import {
  DelegateCallProxyOneToOne
} from "./DelegateCallProxyOneToOne.sol";
import { SaltyLib as Salty } from "./SaltyLib.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import "../Owned.sol";


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
contract DelegateCallProxyManager is Owned {
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
  // Addresses allowed to deploy many-to-one proxies.
  mapping(address => bool) internal _approvedDeployers;

  // Maps implementation holders to their implementation IDs.
  mapping(bytes32 => address) internal _implementationHolders;

  // Temporary value used in the many-to-one proxy constructor.
  // The many-to-one proxy contract is deployed with create2 and
  // uses static initialization code for simple address derivation,
  // so it calls the proxy manager in the constructor to get this
  // address in order to save it as an immutable in the bytecode.
  address internal _implementationHolder;

/* ---  Modifiers  --- */

  modifier _admin_ {
    require(
      msg.sender == _owner || _approvedDeployers[msg.sender],
      "ERR_NOT_APPROVED"
    );
    _;
  }

/* ---  Constructor  --- */

  constructor() public Owned(msg.sender) {}

/* ---  Controls  --- */

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
   * @param implementation Address with the runtime code the proxies
   * should use.
   */
  function createManyToOneProxyRelationship(
    bytes32 implementationID,
    address implementation
  )
    external
    _owner_
  {
    // Deploy the implementation holder contract with the implementation
    // ID as the create2 salt.
    address implementationHolder = Create2.deploy(
      0,
      implementationID,
      type(ManyToOneImplementationHolder).creationCode
    );

    // Store the implementation holder address
    _implementationHolders[implementationID] = implementationHolder;

    // Sets the implementation address.
    _setImplementation(implementationHolder, implementation);

    emit ManyToOne_ImplementationCreated(
      implementationID,
      implementation
    );
  }

  /**
   * @dev Updates the implementation address for a many-to-one
   * proxy relationship.
   *
   * @param implementationID Identifier for the implementation.
   * @param implementation Address with the runtime code the proxies
   * should use.
   */
  function setImplementationAddressManyToOne(
    bytes32 implementationID,
    address implementation
  )
    external
    _owner_
  {
    // Read the implementation holder address from storage.
    address implementationHolder = _implementationHolders[implementationID];

    // Verify that the implementation exists.
    require(implementationHolder != address(0), "ERR_IMPLEMENTATION_ID");

    // Set the implementation address
    _setImplementation(implementationHolder, implementation);

    emit ManyToOne_ImplementationUpdated(
      implementationID,
      implementation
    );
  }

  /**
   * @dev Updates the implementation address for a one-to-one proxy.
   *
   * Note: This could work for many-to-one as well if the caller
   * provides the implementation holder address in place of the
   * proxy address, as they use the same access control and update
   * mechanism.
   *
   * @param proxyAddress Address of the deployed proxy
   * @param implementation Address with the runtime code for
   * the proxy to use.
   */
  function setImplementationAddressOneToOne(
    address proxyAddress,
    address implementation
  )
    external
    _owner_
  {
    // Set the implementation address
    _setImplementation(proxyAddress, implementation);

    emit OneToOne_ImplementationUpdated(proxyAddress, implementation);
  }

/* ---  Proxy Deployment  --- */

  /**
   * @dev Deploy a proxy contract with a one-to-one relationship
   * with its implementation.
   *
   * The proxy will have its own implementation address which can
   * be updated by the proxy manager.
   *
   * @param suppliedSalt Salt provided by the account requesting deployment.
   * @param implementation Address of the contract with the runtime
   * code that the proxy should use.
   */
  function deployProxyOneToOne(
    bytes32 suppliedSalt,
    address implementation
  )
    external
    _owner_
    returns(address proxyAddress)
  {
    // Derive the create2 salt from the deployment requester's address
    // and the requester-supplied salt.
    bytes32 salt = Salty.deriveOneToOneSalt(msg.sender, suppliedSalt);

    // Deploy the proxy
    proxyAddress = Create2.deploy(
      0,
      salt,
      type(DelegateCallProxyOneToOne).creationCode
    );

    // Set the implementation address on the new proxy.
    _setImplementation(proxyAddress, implementation);

    emit OneToOne_ProxyDeployed(proxyAddress, implementation);
  }

  /**
   * @dev Deploy a proxy with a many-to-one relationship with its implemenation.
   *
   * The proxy will call the implementation holder for every transaction to
   * determine the address to use in calls.
   *
   * @param implementationID Identifier for the proxy's implementation.
   * @param suppliedSalt Salt provided by the account requesting deployment.
   */
  function deployProxyManyToOne(bytes32 implementationID, bytes32 suppliedSalt)
    external
    _admin_
    returns(address proxyAddress)
  {
    // Read the implementation holder address from storage.
    address implementationHolder = _implementationHolders[implementationID];

    // Verify that the implementation exists.
    require(implementationHolder != address(0), "ERR_IMPLEMENTATION_ID");

    // Derive the create2 salt from the deployment requester's address, the
    // implementation ID and the requester-supplied salt.
    bytes32 salt = Salty.deriveManyToOneSalt(
      msg.sender,
      implementationID,
      suppliedSalt
    );

    // Set the implementation holder address in storage so the proxy
    // constructor can query it.
    _implementationHolder = implementationHolder;

    // Deploy the proxy, which will query the implementation holder address
    // and save it as an immutable in the contract bytecode.
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

  function isApprovedDeployer(address deployer) external view returns (bool) {
    return _approvedDeployers[deployer];
  }

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
   * @dev Computes the create2 address for a one-to-one proxy requested
   * by `originator` using `suppliedSalt`.
   *
   * @param originator Address of the account requesting deployment.
   * @param suppliedSalt Salt provided by the account requesting deployment.
   */
  function computeProxyAddressOneToOne(
    address originator,
    bytes32 suppliedSalt
  )
    external
    view
    returns (address)
  {
    bytes32 salt = Salty.deriveOneToOneSalt(originator, suppliedSalt);
    return Create2.computeAddress(salt, ONE_TO_ONE_CODEHASH);
  }

  /**
   * @dev Computes the create2 address for a many-to-one proxy for the
   * implementation `implementationID` requested by `originator` using
   * `suppliedSalt`.
   *
   * @param originator Address of the account requesting deployment.
   * @param implementationID The identifier for the contract implementation.
   * @param suppliedSalt Salt provided by the account requesting deployment.
  */
  function computeProxyAddressManyToOne(
    address originator,
    bytes32 implementationID,
    bytes32 suppliedSalt
  )
    external
    view
    returns (address)
  {

    bytes32 salt = Salty.deriveManyToOneSalt(
      originator,
      implementationID,
      suppliedSalt
    );
    return Create2.computeAddress(salt, MANY_TO_ONE_CODEHASH);
  }

  /**
   * @dev Computes the create2 address of the implementation holder
   * for `implementationID`.
   *
   * @param implementationID The identifier for the contract implementation.
  */
  function computeHolderAddressManyToOne(bytes32 implementationID)
    public
    view
    returns (address)
  {
    return Create2.computeAddress(
      implementationID,
      IMPLEMENTATION_HOLDER_CODEHASH
    );
  }

/* ---  Internal Functions  --- */

  /**
   * @dev Sets the implementation address for a one-to-one proxy or
   * many-to-one implementation holder. Both use the same access
   * control and update mechanism, which is the receipt of a call
   * from the proxy manager with the abi-encoded implementation address
   * as the only calldata.
   *
   * Note: Verifies that the implementation address is a contract.
   *
   * @param proxyOrHolder Address of the one-to-one proxy or
   * many-to-one implementation holder contract.
   * @param implementation Address of the contract with the runtime
   * code that the proxy or proxies should use.
   */
  function _setImplementation(
    address proxyOrHolder,
    address implementation
  ) internal {
    // Verify that the implementation address is a contract.
    require(Address.isContract(implementation), "ERR_NOT_CONTRACT");
    // Set the implementation address on the contract.

    // solium-disable-next-line security/no-low-level-calls
    (bool success,) = proxyOrHolder.call(abi.encode(implementation));
    require(success, "ERR_SET_ADDRESS_REVERT");
  }
}