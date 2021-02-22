// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;


interface IPoolFactoryAccessControl {
/* ==========  Events  ========== */

  event AdminAccessGranted(address newAdmin);
  event AdminAccessRevoked(address newAdmin);

/* ==========  Queries  ========== */

  function poolFactory() external view returns (address);

  function hasAdminAccess(address) external view returns (bool);

/* ==========  Owner Controls  ========== */

  function grantAdminAccess(address admin) external;

  function revokeAdminAccess(address admin) external;

  function transferPoolFactoryOwnership(address) external;

  function disapprovePoolController(address) external;

/* ==========  Admin Controls  ========== */

  function approvePoolController(address) external;
}