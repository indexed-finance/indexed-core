pragma solidity ^0.6.0;


contract TestOrder {
  uint256 internal _testStep;
  uint256 internal _timestampLast;

  modifier testIndex(uint256 i) {
    require(_testStep++ == i, "Error: Wrong test order.");
    _;
  }

  modifier markTime {
    _timestampLast = block.timestamp;
    _;
  }

  modifier forceDelay(uint256 delay) {
    require(block.timestamp - _timestampLast >= delay, "Error: test requires time delay");
    _timestampLast = block.timestamp;
    _;
  }
}