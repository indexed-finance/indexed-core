// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;


contract Owned {
  event OwnerSet(address newOwner);

  address internal _owner;

  modifier _owner_ {
    require(msg.sender == _owner, "ERR_NOT_OWNER");
    _;
  }

  constructor(address owner) public {
    _owner = owner;
  }

  function getOwner() external view returns (address) {
    return _owner;
  }

  function setOwner(address owner) external _owner_ {
    require(owner != address(0), "ERR_NULL_ADDRESS");
    _owner = owner;
    emit OwnerSet(owner);
  }
}