pragma solidity ^0.6.0;
import "./UniSwapV2PriceOracle.sol";

contract MarketOracle is UniSwapV2PriceOracle {
  // 100k stablecoin units (100,000 * 10**decimals)
  uint256 public stablecoinUSD100k;
  // Array of tokens for each category.
  mapping(uint256 => address[]) internal _categoryTokens;
  // Category ID for each token.
  mapping(address => uint256) internal _tokenCategories;
  // IPFS hash for metadata about token categories.
  mapping(uint256 => bytes32) internal _categoryMetadata;

  // /**
  //  * @dev Verify that a given token has a higher market cap than the lowest
  //  * value token in the provided array.
  //  * @param currentTokens Tokens to compare to
  //  * @param token Token to check for expected inclusion
  //  */
  // function tokenShouldBeIncluded(
  //   address[] memory currentTokens, address token
  // ) public {
  //   uint144[] memory marketCaps = computeAverageMarketCaps(currentTokens);
  //   uint144 marketCap = computeAverageMarketCap(token);
  //   bool lowerThanMinimum;
  //   for (uint256 i = 0; i < marketCaps.length; i++) {
  //   }
  // }

  struct TokenValue {
    address token;
    uint144 marketCap;
  }

  function assignMarketCaps(address[] memory tokens)
  internal view returns (TokenValue[] memory output) {
    output = new TokenValue[](tokens.length);
    uint144[] memory marketCaps = computeAverageMarketCaps(tokens);
    for (uint256 i = 0; i < marketCaps.length; i++) {
      output[i] = TokenValue(tokens[i], marketCaps[i]);
    }
  }

  /**
   * @dev Verifies that an array of tokens is sorted by market cap in descending order.
   */
  function verifySortedByMarketCap(address[] memory tokens)
  public view returns (bool) {
    uint144[] memory marketCaps = computeAverageMarketCaps(tokens);
    for (uint256 i = 1; i < marketCaps.length; i++) {
      require(tokens[i] != tokens[i-1], "Duplicate token address.");
      require(marketCaps[i] <= marketCaps[i-1], "Tokens out of order");
    }
  }
}