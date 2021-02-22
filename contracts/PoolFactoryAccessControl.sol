// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;

/* ========== External Inheritance ========== */
import "@openzeppelin/contracts/access/Ownable.sol";

/* ========== Internal Interfaces ========== */
import "./interfaces/IPoolFactoryAccessControl.sol";


contract PoolFactoryAccessControl is IPoolFactoryAccessControl, Ownable {
/* ==========  Constants  ========== */

  address public immutable override poolFactory;

/* ==========  Storage  ========== */

  mapping(address => bool) public override hasAdminAccess;

/* ==========  Modifiers  ========== */

  modifier onlyAdminOrOwner {
    require(
      hasAdminAccess[msg.sender] || msg.sender == owner(),
      "ERR_NOT_ADMIN_OR_OWNER"
    );
    _;
  }

/* ==========  Constructor  ========== */

  constructor(address poolFactory_) public Ownable() {
    poolFactory = poolFactory_;
  }

/* ==========  Owner Controls  ========== */

  /**
   * @dev Transfer ownership of the pool factory to another account.
   */
  function transferPoolFactoryOwnership(address newOwner) external override onlyOwner {
    Ownable(poolFactory).transferOwnership(newOwner);
  }

  /**
   * @dev Grants admin access to `admin`.
   */
  function grantAdminAccess(address admin) external override onlyOwner {
    hasAdminAccess[admin] = true;
    emit AdminAccessGranted(admin);
  }

  /**
   * @dev Revokes admin access from `admin`.
   */
  function revokeAdminAccess(address admin) external override onlyOwner {
    hasAdminAccess[admin] = false;
    emit AdminAccessRevoked(admin);
  }

  /** @dev Removes the ability of `controller` to deploy pools. */
  function disapprovePoolController(address controller) external override onlyOwner {
    IPoolFactory(poolFactory).disapprovePoolController(controller);
  }

/* ==========  Admin Controls  ========== */

  /** @dev Approves `controller` to deploy pools. */
  function approvePoolController(address controller) external override onlyAdminOrOwner {
    IPoolFactory(poolFactory).approvePoolController(controller);
  }
}


interface IPoolFactory {
  function approvePoolController(address controller) external;

  function disapprovePoolController(address controller) external;
}