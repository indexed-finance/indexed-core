pragma solidity ^0.6.0;


contract MockUnboundTokenSeller {
  mapping(address => uint256) internal _receivedTokens;
  function handleUnbindToken(address token, uint256 amount) external {
    _receivedTokens[token] += amount;
  }

  function getReceivedTokens(address token) external view returns (uint256) {
    return _receivedTokens[token];
  }
}