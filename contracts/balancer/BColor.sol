// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.0;

abstract contract BColor {
  function getColor() external virtual view returns (bytes32);
}

contract BBronze is BColor {
  function getColor() external override view returns (bytes32) {
    return bytes32("BRONZE");
  }
}
