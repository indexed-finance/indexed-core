pragma solidity ^0.6.0;


/**
 * @dev Mock contract for testing the unbind token functionality
 * on the index pool.
 */
contract MockUnbindTokenHandler {
  mapping(address => uint256) internal _receivedTokens;
  function handleUnbindToken(address token, uint256 amount) external {
    _receivedTokens[token] += amount;
  }

  function getReceivedTokens(address token) external view returns (uint256) {
    return _receivedTokens[token];
  }
}