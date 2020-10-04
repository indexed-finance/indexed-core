pragma solidity ^0.6.0;

import "../../MockERC20.sol";


contract TestTokens {
  MockERC20 public token1;
  MockERC20 public token2;
  MockERC20 public token3;
  MockERC20 public token4;
  MockERC20 public token5;

  uint256 public price1 = 5;
  uint256 public price2 = 3;
  uint256 public price3 = 4;
  uint256 public price4 = 2;
  uint256 public price5 = 6;

  modifier tokensReady {
    require(address(token1) != address(0), "Error: Tester not initialized");
    _;
  }

  function _deployTokens() internal {
    require(address(token1) == address(0), "Error: tokens already deployed.");
    token1 = new MockERC20("Token 1", "TK1");
    token2 = new MockERC20("Token 2", "TK2");
    token3 = new MockERC20("Token 3", "TK3");
    token4 = new MockERC20("Token 4", "TK4");
    token5 = new MockERC20("Token 5", "TK5");
  }

  function tokensOrderedByPrice()
    internal
    view
    returns (address[] memory tokens)
  {
    tokens = new address[](5);
    tokens[0] = address(token5);
    tokens[1] = address(token1);
    tokens[2] = address(token3);
    tokens[3] = address(token2);
    tokens[4] = address(token4);
  }

  function orderedPrices()
    internal
    view
    returns (uint256[] memory prices)
  {
    prices = new uint256[](5);
    prices[0] = price5;
    prices[1] = price1;
    prices[2] = price3;
    prices[3] = price2;
    prices[4] = price4;
  }

  function marketCapsOrderedByPrice(uint256 liquidityPer)
    internal
    view
    returns (uint256[] memory marketCaps)
  {
    marketCaps = new uint256[](5);
    marketCaps[0] = price5 * liquidityPer;
    marketCaps[1] = price1 * liquidityPer;
    marketCaps[2] = price3 * liquidityPer;
    marketCaps[3] = price2 * liquidityPer;
    marketCaps[4] = price4 * liquidityPer;
  }
}