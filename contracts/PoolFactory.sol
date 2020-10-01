// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./Owned.sol";
import { IPool } from "./balancer/IPool.sol";
import {
  DelegateCallProxyManager
} from "./proxies/DelegateCallProxyManager.sol";
import {
  DelegateCallProxyManyToOne
} from "./proxies/DelegateCallProxyManyToOne.sol";
import { SaltyLib as Salty } from "./proxies/SaltyLib.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";


/**
 * @title PoolFactory
 * @author d1ll0n
 */
contract PoolFactory is Owned {
/* ---  Constants  --- */

  // Default pool implementation ID.
  bytes32 internal constant POOL_IMPLEMENTATION_ID = keccak256("IPool.sol");

  // Address of the proxy manager contract.
  DelegateCallProxyManager internal immutable _proxyManager;

/* ---  Events  --- */

  /** @dev Emitted when a pool using the default implementation is deployed. */
  event NewDefaultPool(
    address pool,
    address controller
  );

  /** @dev Emitted when a pool using a non-default implementation is deployed. */
  event NewNonDefaultPool(
    address pool,
    address controller,
    bytes32 implementationID
  );

/* ---  Storage  --- */

  mapping(address => bool) internal _approvedControllers;
  mapping(address => bool) internal _isIPool;

/* ---  Modifiers  --- */

  modifier _approved_ {
    require(_approvedControllers[msg.sender], "ERR_NOT_APPROVED");
    _;
  }

/* ---  Constructor  --- */

  constructor(
    address owner,
    DelegateCallProxyManager proxyManager
  ) public Owned(owner) {
    _proxyManager = proxyManager;
  }

/* ---  Controller Approval  --- */

  /** @dev Approves `controller` to deploy index pools. */
  function approvePoolController(address controller) external _owner_ {
    _approvedControllers[controller] = true;
  }

  /** @dev Removes the ability of `controller` to deploy index pools. */
  function disapprovePoolController(address controller) external _owner_ {
    _approvedControllers[controller] = false;
  }

/* ---  Pool Deployment  --- */

  /**
   * @dev Deploys an index pool and returns the address.
   *
   * Note: Does not initialize the pool, this must be executed
   * by the controller.
   *
   * Note: Must be called by an approved controller.
   *
   * @param controllerSalt Create2 salt provided by the deployer
   * @param name Name of the index token - should indicate the category and size
   * @param symbol Symbol for the index token
   */
  function deployIndexPool(
    bytes32 controllerSalt,
    string calldata name,
    string calldata symbol
  )
    external
    _approved_
    returns (address poolAddress)
  {
    bytes32 suppliedSalt = keccak256(abi.encodePacked(
      msg.sender, controllerSalt
    ));
    poolAddress = _proxyManager.deployProxyManyToOne(
      POOL_IMPLEMENTATION_ID,
      suppliedSalt
    );
    _isIPool[poolAddress] = true;
    IPool(poolAddress).configure(
      msg.sender,
      name,
      symbol
    );
    emit NewDefaultPool(poolAddress, msg.sender);
  }

  /**
   * @dev Deploys an index pool using an implementation ID other than
   * the default (keccak256("IPool.sol")) and returns the address.
   *
   * Note: To support future interfaces, this does not initialize or
   * configure the pool, this must be executed by the controller.
   *
   * Note: Must be called by an approved controller.
   *
   * @param implementationID Implementation ID for the pool
   * @param controllerSalt Create2 salt provided by the deployer
   */
  function deployIndexPool(
    bytes32 implementationID,
    bytes32 controllerSalt
  )
    external
    _approved_
    returns (address poolAddress)
  {
    bytes32 suppliedSalt = keccak256(abi.encodePacked(
      msg.sender, controllerSalt
    ));
    poolAddress = _proxyManager.deployProxyManyToOne(
      implementationID,
      suppliedSalt
    );
    _isIPool[poolAddress] = true;
    emit NewNonDefaultPool(
      poolAddress,
      msg.sender,
      implementationID
    );
  }

/* ---  Queries  --- */

  /**
   * @dev Checks if an address is an ipool.
   */
  function isIPool(address pool) external view returns (bool) {
    return _isIPool[pool];
  }

  /**
   * @dev Compute the create2 address for a pool deployed by an approved
   * indexed controller.
   */
  function computePoolAddress(
    address controller,
    bytes32 controllerSalt
  )
    public
    view
    returns (address poolAddress)
  {
    bytes32 suppliedSalt = keccak256(abi.encodePacked(
      controller, controllerSalt
    ));
    poolAddress = Salty.computeProxyAddressManyToOne(
      address(_proxyManager),
      address(this),
      POOL_IMPLEMENTATION_ID,
      suppliedSalt
    );
  }

/* ---  Internal Utility Functions  --- */

  /**
   * @dev Re-assigns a uint128 array to a uint256 array.
   * This does not affect memory allocation as all Solidity
   * uint arrays take 32 bytes per item.
   */
  function _to256Array(uint128[] memory arr)
    internal
    pure
    returns (uint256[] memory outArr)
  {
    assembly {
      outArr := arr
    }
  }
}

/**
 * @dev Interface of the public pool implementation contract,
 * if the governance dao decides to make one available.
 */
interface PublicPoolImplementation {
  function initialize(
    address controller,
    string calldata name,
    string calldata symbol,
    address[] calldata tokens,
    uint256[] calldata balances,
    uint96[] calldata denorms,
    address tokenProvider
  ) external;
}