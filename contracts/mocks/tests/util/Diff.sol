pragma solidity ^0.6.0;


contract Diff {
  function testDiff(
    uint256 expected,
    uint256 actual,
    string memory errorMsg
  ) internal pure {
    if (expected == actual) return;
    uint256 diff = absDiff(expected, actual);
    // require diff as a fraction is less than 1e-8
    uint256 _diff = (diff * 1e18) / actual;
    require(_diff < 1e10, errorMsg);
  }

  function absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
    return (a == b) ? 0 : a > b ? a - b : b - a;
  }

  function testArrayDeepEq(
    address[] memory expected,
    address[] memory actual,
    string memory errorMsg
  ) internal pure {
    require(expected.length == actual.length, "Error: Array lengths do not match.");
    for (uint256 i = 0; i < actual.length; i++) {
      require(expected[i] == actual[i], errorMsg);
    }
  }

  function testUintArrayDiff(
    uint[] memory expected,
    uint[] memory actual,
    string memory errorMsg
  ) internal pure {
    require(expected.length == actual.length, "Error: Array lengths do not match.");
    for (uint256 i = 0; i < expected.length; i++) {
      testDiff(expected[i], actual[i], errorMsg);
    }
  }
}