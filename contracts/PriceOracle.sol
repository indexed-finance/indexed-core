pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { UniswapV2Library as UniV2 } from "./lib/UniswapV2Library.sol";

contract MarketOracle {
  address public constant UNISWAP_FACTORY = address(0);
  uint24 public constant MAX_24_BIT = uint24(2**24 - 1);

  struct TokenData {
    address uniswapMarket;
    uint16 categoryID;
    uint16 index;
  }

  /** Stablecoin for price data */
  address public stablecoin;
  /** Amount of stablecoin equal to 100k USD */
  uint256 public stablecoinUSD100k;
  uint256 internal _tokensCount;
  mapping(address => TokenData) internal _tokens;
  mapping(uint256 => bytes32[]) internal _dailyMarketCaps;

  function whitelistToken(address token, uint16 categoryID) external {
    require(!isWhitelisted(token), "Token already whitelisted.");
    address marketAddress = UniV2.pairFor(UNISWAP_FACTORY, token, stablecoin);
    uint256 index = _tokensCount++;
    _tokens[token] = TokenData(marketAddress, categoryID, uint16(index));
  }

  function getTokenData(address token) public view returns (TokenData memory) {
    return _tokens[token];
  }

  function isWhitelisted(address token) public view returns (bool) {
    TokenData memory data = getTokenData(token);
    return data.uniswapMarket != address(0);
  }

  function _today() internal view returns (uint256) {
    return now / 1 days;
  }

  function _capDivUsd100k(uint256 marketCapInStablecoin) internal view returns (uint24) {
    uint256 capDiv100k = marketCapInStablecoin / stablecoinUSD100k;
    if (capDiv100k <= MAX_24_BIT) return uint24(capDiv100k);
    return MAX_24_BIT;
  }
}

/* 
x = 10
n1 = 49
n2 = 25

proportional sqrt n1 = 7/12
proportional sqrt n2 = 5/12

n1*x = 490
n2*x = 250

proportional sqrt (n1*x) = 22.13
proportional sqrt (n2*x) = 15.8

 */