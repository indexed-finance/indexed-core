pragma solidity ^0.6.0;

import "../../MockERC20.sol";
import "../../../lib/Babylonian.sol";
import "../../../lib/FixedPoint.sol";

contract TestTokens {
  using Babylonian for uint;
  using FixedPoint for uint112;
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;

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

  function denormsOrderedByPrice()
    internal
    view
    returns (uint256[] memory denorms)
  {
    denorms = new uint256[](5);
    uint256[] memory marketCaps = marketCapsOrderedByPrice();
    uint256 mcapSqrtSum = 0;
    for (uint256 i = 0; i < 5; i++) {
      uint256 mcapSqrt = marketCaps[i].sqrt();
      mcapSqrtSum += mcapSqrt;
    }
    for (uint256 i = 0; i < 5; i++) {
      uint256 mcapSqrt = marketCaps[i].sqrt();
      denorms[i] = (mcapSqrt * 25e18) / mcapSqrtSum;
    }
    
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

  function marketCapsOrderedByPrice()
    internal
    view
    returns (uint256[] memory marketCaps)
  {
    marketCaps = new uint256[](5);
    marketCaps[0] = price5 * token5.totalSupply();
    marketCaps[1] = price1 * token1.totalSupply();
    marketCaps[2] = price3 * token3.totalSupply();
    marketCaps[3] = price2 * token2.totalSupply();
    marketCaps[4] = price4 * token4.totalSupply();
  }
}