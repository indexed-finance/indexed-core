// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IDelegateCallProxyManager } from "@indexed-finance/proxies/contracts/interfaces/IDelegateCallProxyManager.sol";
import { SaltyLib as Salty } from "@indexed-finance/proxies/contracts/SaltyLib.sol";


/**
 * @title PoolFactory
 * @author d1ll0n
 */
contract PoolFactory is Ownable {
/* ---  Constants  --- */

  // Address of the proxy manager contract.
  IDelegateCallProxyManager public immutable proxyManager;

/* ---  Events  --- */

  /** @dev Emitted when a pool is deployed. */
  event NewPool(address pool, address controller, bytes32 implementationID);

/* ---  Storage  --- */

  mapping(address => bool) public isApprovedController;
  mapping(address => bytes32) public getPoolImplementationID;

/* ---  Modifiers  --- */

  modifier onlyApproved {
    require(isApprovedController[msg.sender], "ERR_NOT_APPROVED");
    _;
  }

/* ---  Constructor  --- */

  constructor(IDelegateCallProxyManager proxyManager_) public Ownable() {
    proxyManager = proxyManager_;
  }

/* ---  Controller Approval  --- */

  /** @dev Approves `controller` to deploy index pools. */
  function approvePoolController(address controller) external onlyOwner {
    isApprovedController[controller] = true;
  }

  /** @dev Removes the ability of `controller` to deploy index pools. */
  function disapprovePoolController(address controller) external onlyOwner {
    isApprovedController[controller] = false;
  }

/* ---  Pool Deployment  --- */

  /**
   * @dev Deploys a pool using an implementation ID provided by the controller.
   *
   * Note: To support future interfaces, this does not initialize or
   * configure the pool, this must be executed by the controller.
   *
   * Note: Must be called by an approved controller.
   *
   * @param implementationID Implementation ID for the pool
   * @param controllerSalt Create2 salt provided by the deployer
   */
  function deployPool(bytes32 implementationID, bytes32 controllerSalt)
    external
    onlyApproved
    returns (address poolAddress)
  {
    bytes32 suppliedSalt = keccak256(abi.encodePacked(msg.sender, controllerSalt));
    poolAddress = proxyManager.deployProxyManyToOne(implementationID, suppliedSalt);
    getPoolImplementationID[poolAddress] = implementationID;
    emit NewPool(poolAddress, msg.sender, implementationID);
  }

/* ---  Queries  --- */

  /**
   * @dev Checks if an address is a pool that was deployed by the factory.
   */
  function isRecognizedPool(address pool) external view returns (bool) {
    return getPoolImplementationID[pool] != bytes32(0);
  }

  /**
   * @dev Compute the create2 address for a pool deployed by an approved
   * indexed controller.
   */
  function computePoolAddress(bytes32 implementationID, address controller, bytes32 controllerSalt)
    public
    view
    returns (address)
  {
    bytes32 suppliedSalt = keccak256(abi.encodePacked(controller, controllerSalt));
    return Salty.computeProxyAddressManyToOne(
      address(proxyManager),
      address(this),
      implementationID,
      suppliedSalt
    );
  }
}