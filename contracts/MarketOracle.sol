pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./UniSwapV2PriceOracle.sol";


contract MarketOracle is UniSwapV2PriceOracle {
/* ---  Constants  --- */

  // Max time between a category being sorted and a query for the top n tokens.
  uint256 internal constant MAX_SORT_DELAY = 1 days;
  // Maximum number of tokens in a category.
  uint256 internal constant MAX_CATEGORY_TOKENS = 15;

/* ---  Events  --- */

  event CategoryAdded(uint256 categoryID, bytes32 metadataHash);
  event TokenAdded(address token, uint256 categoryID);
  event CategorySorted(uint256 categoryID);

/* ---  Storage  --- */

  // Array of tokens for each category.
  mapping(uint256 => address[]) internal _categoryTokens;
  // Category ID for each token.
  mapping(address => uint256) internal _tokenCategories;
  // IPFS hash for metadata about token categories.
  mapping(uint256 => bytes32) public categoryMetadata;
  // Last time a category was sorted
  mapping(uint256 => uint256) public lastCategoryUpdate;
  // Address that can update the categories.
  address public manager;
  // Number of categories in the oracle.
  uint256 public categoryIndex = 1;

  constructor(
    address _uniswapFactory,
    address _weth,
    address _manager
  ) public UniSwapV2PriceOracle(_uniswapFactory, _weth) {
    manager = _manager;
  }

/* ---  Modifiers  --- */

  modifier onlyManager {
    require(msg.sender == manager, "Only the manager can call this.");
    _;
  }

/* ---  Category Queries  --- */

  /**
   * @dev Returns a boolean stating whether a category exists.
   */
  function hasCategory(uint256 categoryID) external view returns (bool) {
    return categoryID < categoryIndex && categoryID > 0;
  }

  /**
   * @dev Returns the array of tokens in a category.
   */
  function getCategoryTokens(uint256 categoryID)
    external
    view
    returns (address[] memory tokens)
  {
    require(
      categoryID < categoryIndex && categoryID > 0,
      "ERR_CATEGORY_ID"
    );
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

  /**
   * @dev Get the top `num` tokens in a category.
   *
   * Note: The category must have been sorted by market cap
   * in the last `MAX_SORT_DELAY` seconds.
   */
  function getTopCategoryTokens(uint256 categoryID, uint256 num)
    external
    view
    returns (address[] memory tokens)
  {
    require(
      categoryID < categoryIndex && categoryID > 0,
      "ERR_CATEGORY_ID"
    );
    address[] storage categoryTokens = _categoryTokens[categoryID];
    require(
      num <= categoryTokens.length,
      "ERR_CATEGORY_SIZE"
    );
    require(
      now - lastCategoryUpdate[categoryID] <= MAX_SORT_DELAY,
      "ERR_CATEGORY_NOT_READY"
    );
    tokens = new address[](num);
    for (uint256 i = 0; i < num; i++) tokens[i] = categoryTokens[i];
  }

/* ---  Category Management Actions  --- */

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
   * Note: A token can only be assigned to one category at a time.
   */
  function addToken(address token, uint256 categoryID) public onlyManager {
    require(categoryID < categoryIndex, "ERR_CATEGORY_ID");
    require(
      _categoryTokens[categoryID].length < MAX_CATEGORY_TOKENS,
      "ERR_MAX_CATEGORY_TOKENS"
    );
    _addToken(token, categoryID);
    // Decrement the timestamp for the last category sort to ensure
    // the new token is sorted before the top n tokens can be queried.
    lastCategoryUpdate[categoryID] -= MAX_SORT_DELAY;
  }

  /**
   * @dev Add tokens to categories in a bundle.
   * @param categoryID Category identifier.
   * @param tokens Array of tokens to add to the category.
   */
  function addTokens(
    uint256 categoryID,
    address[] calldata tokens
  ) external onlyManager {
    require(
      categoryID < categoryIndex && categoryID > 0,
      "ERR_CATEGORY_ID"
    );
    require(
      _categoryTokens[categoryID].length + tokens.length <= MAX_CATEGORY_TOKENS,
      "ERR_MAX_CATEGORY_TOKENS"
    );
    for (uint256 i = 0; i < tokens.length; i++) {
      _addToken(tokens[i], categoryID);
    }
    // Decrement the timestamp for the last category sort to ensure
    // the new token is sorted before the top n tokens can be queried.
    lastCategoryUpdate[categoryID] -= MAX_SORT_DELAY;
  }

  /**
   * @dev Update the order of tokens in a category by descending market cap.
   * @param categoryID Category to sort
   * @param orderedTokens Pre-sorted array of tokens
   */
  function orderCategoryTokensByMarketCap(
    uint256 categoryID,
    address[] memory orderedTokens
  ) public {
    address[] storage categoryTokens = _categoryTokens[categoryID];
    require(
      orderedTokens.length == categoryTokens.length,
      "Incorrect number of tokens."
    );
    uint144[] memory marketCaps = computeAverageMarketCaps(orderedTokens);
    categoryTokens[0] = orderedTokens[0];
    for (uint256 i = 1; i < marketCaps.length; i++) {
      address token = orderedTokens[i];
      require(_tokenCategories[token] == categoryID, "Token not in category.");
      // This check could technically be bypassed if three tokens had the exact
      // same market cap, but it is incredibly unlikely.
      require(marketCaps[i] <= marketCaps[i-1], "ERR_ORDER_INCORRECT");
      require(token != orderedTokens[i-1], "ERR_DUPLICATE_ADDRESS");
      // Duplicates can bypass the previous assertion if there are 2 tokens
      // with the exact same market cap, even though it is incredibly unlikely.
      // If two tokens in the list have the same market cap, the loop will work
      // backwards through the tokens with the same market cap to make sure
      // there are no duplicates.
      if (marketCaps[i] == marketCaps[i-1]) {
        for (
          uint256 dI = i - 1;
          dI > 0 && marketCaps[dI] == marketCaps[dI - 1];
          dI -= 1
        ) {
          require(token != orderedTokens[dI], "ERR_DUPLICATE_ADDRESS");
        }
      }
      categoryTokens[i] = token;
    }
    lastCategoryUpdate[categoryID] = now;
    emit CategorySorted(categoryID);
  }

/* ---  Internal Category Management Functions  --- */

  /**
   * @dev Adds a new token to a category.
   */
  function _addToken(address token, uint256 categoryID) internal {
    require(_tokenCategories[token] == 0, "ERR_TOKEN_EXISTS");
    _tokenCategories[token] = categoryID;
    _categoryTokens[categoryID].push(token);
    updatePrice(token);
    emit TokenAdded(token, categoryID);
  }
}