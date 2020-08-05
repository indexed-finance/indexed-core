pragma solidity ^0.6.0;

abstract contract IUniSwap {
  function swap(
    uint amount0Out,
    uint amount1Out,
    address to,
    bytes calldata data
  ) external virtual;
}