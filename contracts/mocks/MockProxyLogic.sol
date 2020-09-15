pragma solidity ^0.6.0;


contract MockProxyLogic {
  uint256 internal _value = 0;

  function incrementValue() external {
    _value += 1;
  }

  function decrementValue() external {
    _value -= 1;
  }

  function getValue() external view returns (uint) {
    return _value;
  }
}