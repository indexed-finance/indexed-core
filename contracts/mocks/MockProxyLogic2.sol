pragma solidity ^0.6.0;


contract MockProxyLogic2 {
  uint256 internal _value = 0;

  function incrementValue() external {
    _value += 2;
  }

  function decrementValue() external {
    _value -= 2;
  }

  function getValue() external view returns (uint) {
    return _value;
  }
}