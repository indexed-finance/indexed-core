// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.4.0;


/************************************************************************************************
Originally from https://github.com/Uniswap/uniswap-lib/blob/master/contracts/libraries/Babylonian.sol

This source code has been modified from the original, which was copied from the github repository
at commit hash 9642a0705fdaf36b477354a4167a8cd765250860.

Subject to the GPL-3.0 license
*************************************************************************************************/


// computes square roots using the babylonian method
// https://en.wikipedia.org/wiki/Methods_of_computing_square_roots#Babylonian_method
library Babylonian {
  function sqrt(uint y) internal pure returns (uint z) {
    if (y > 3) {
      z = y;
      uint x = (y + 1) / 2;
      while (x < z) {
        z = x;
        x = (y / x + x) / 2;
      }
    } else if (y != 0) {
      z = 1;
    }
    // else z = 0
  }
}
