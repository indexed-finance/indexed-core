pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./UniSwapV2PriceOracle.sol";

contract MarketOracle is UniSwapV2PriceOracle {
  // 100k stablecoin units (100,000 * 10**decimals)
  // uint256 public stablecoinUSD100k;

  // Address that can update the categories.
  address public manager;
  // Number of categories in the oracle.
  uint256 public categoryIndex = 1;

  // Array of tokens for each category.
  mapping(uint256 => address[]) internal _categoryTokens;
  // Category ID for each token.
  mapping(address => uint256) internal _tokenCategories;
  // IPFS hash for metadata about token categories.
  mapping(uint256 => bytes32) public categoryMetadata;

  /**
   * @dev Data structure for adding many new tokens to a category.
   */
  struct NewCategoryTokens {
    uint256 categoryID;
    address[] tokens;
  }

  event CategoryAdded(uint256 categoryID, bytes32 metadataHash);
  event TokenAdded(address token, uint256 categoryID);

  constructor(
    address _uniswapFactory,
    address _stableCoin,
    address _manager
  ) public UniSwapV2PriceOracle(_uniswapFactory, _stableCoin) {
    manager = _manager;
  }

  modifier onlyManager {
    require(msg.sender == manager, "Only the manager can call this.");
    _;
  }

  /* <-- CATEGORY QUERIES --> */
  /**
   * @dev Return the array of tokens for a category.
   */
  function getCategoryTokens(uint256 categoryID)
  external view returns (address[] memory tokens) {
    address[] storage _tokens = _categoryTokens[categoryID];
    tokens = new address[](_tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      tokens[i] = _tokens[i];
    }
  }

  /**
   * @dev Returns the market capitalization rates for the tokens
   * in a category.
   */
  function getCategoryMarketCaps(uint256 categoryID)
  external view returns (uint144[] memory marketCaps) {
    return computeAverageMarketCaps(_categoryTokens[categoryID]);
  }

  /* <-- ORACLE MANAGEMENT ACTIONS --> */
  /**
   * @dev Create a new token category.
   * @param metadataHash Hash of metadata about the token category,
   * which can be distributed on IPFS.
   */
  function createCategory(bytes32 metadataHash) external onlyManager {
    uint256 categoryID = categoryIndex++;
    categoryMetadata[categoryID] = metadataHash;
    emit CategoryAdded(categoryID, metadataHash);
  }

  /**
   * @dev Adds a new token to a category.
   */
  function addToken(address token, uint256 categoryID) public onlyManager {
    require(categoryID < categoryIndex, "Category does not exist.");
    require(_tokenCategories[token] == 0, "Token already listed.");
    _tokenCategories[token] = categoryID;
    _categoryTokens[categoryID].push(token);
    updatePrice(token);
    emit TokenAdded(token, categoryID);
  }

  /**
   * @dev Add tokens to categories in a bundle.
   * @param updates Array of `NewCategoryTokens` structs with the tokens to add
   * for each category.
   */
  function addTokens(NewCategoryTokens[] memory updates) public onlyManager {
    for (uint256 u = 0; u < updates.length; u++) {
      NewCategoryTokens memory update = updates[u];
      for (uint256 t = 0; t < update.tokens.length; t++) {
        addToken(update.tokens[t], update.categoryID);
      }
    }
  }

  /* <-- TOKEN SORTING ACTIONS --> */
  /**
   * @dev Update the order of tokens in a category by descending market cap.
   * @param categoryID Category to sort
   * @param orderedTokens Pre-sorted array of tokens
   */
  function orderCategoryTokensByMarketCap(uint256 categoryID, address[] memory orderedTokens)
  public {
    address[] storage categoryTokens = _categoryTokens[categoryID];
    require(orderedTokens.length == categoryTokens.length, "Incorrect number of tokens.");
    uint144[] memory marketCaps = computeAverageMarketCaps(orderedTokens);
    categoryTokens[0] = orderedTokens[0];
    for (uint256 i = 1; i < marketCaps.length; i++) {
      address token = orderedTokens[i];
      require(_tokenCategories[token] == categoryID, "Token not in category.");
      require(token != orderedTokens[i-1], "Duplicate token address.");
      require(marketCaps[i] <= marketCaps[i-1], "Tokens out of order");
      categoryTokens[i] = token;
    }
  }
}