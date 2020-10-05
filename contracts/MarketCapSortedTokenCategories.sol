// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./Owned.sol";
import { UniSwapV2PriceOracle } from "./UniSwapV2PriceOracle.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MarketCapSortedCategories
 * @author d1ll0n
 *
 * @dev This contract stores token categories created by the contract owner.
 * Token categories are sorted by their fully diluted market caps, which is
 * extrapolated by multiplying each token's total supply by its moving
 * average weth price on UniSwap.
 *
 * Categories are periodically sorted, ranking their tokens in descending order by
 * market cap.
 *
 * CRITERIA
 * ===============
 * To be added to a category, a token should meet the following requirements in addition
 * to any other criteria for the particular category:
 *
 * 1. The token is at least a week old.
 * 2. The token complies with the ERC20 standard (boolean return values not required)
 * 3. No major vulnerabilities have been discovered in the token contract.
 * 4. The token does not have a deflationary supply model.
 * 5. The token's supply can not be arbitrarily inflated or deflated maliciously.
 * 5.a. The control model should be considered if the supply can be modified arbitrarily.
 * ===============
 */
contract MarketCapSortedTokenCategories is Owned {
/* ---  Constants  --- */

  // Maximum time between a category being sorted and a query for the top n tokens
  uint256 internal constant MAX_SORT_DELAY = 1 days;

  // Maximum number of tokens in a category
  uint256 internal constant MAX_CATEGORY_TOKENS = 15;

  // Long term price oracle
  UniSwapV2PriceOracle public immutable oracle;

/* ---  Events  --- */

  /** @dev Emitted when a new category is created. */
  event CategoryAdded(uint256 categoryID, bytes32 metadataHash);

  /** @dev Emitted when a category is sorted. */
  event CategorySorted(uint256 categoryID);

  /** @dev Emitted when a token is added to a category. */
  event TokenAdded(address token, uint256 categoryID);

/* ---  Structs  --- */

  struct CategoryTokenRecord {
    bool bound;
    uint8 index;
  }

/* ---  Storage  --- */

  // Number of categories that exist.
  uint256 public categoryIndex;
  // Array of tokens for each category.
  mapping(uint256 => address[]) internal _categoryTokens;
  mapping(
    uint256 => mapping(address => CategoryTokenRecord)
  ) internal _categoryTokenRecords;
  // Last time a category was sorted
  mapping(uint256 => uint256) internal _lastCategoryUpdate;

/* ---  Constructor  --- */

  /**
   * @dev Deploy the controller and configure the addresses
   * of the related contracts.
   */
  constructor(UniSwapV2PriceOracle _oracle, address owner)
    public
    Owned(owner)
  {
    oracle = _oracle;
  }


/* ---  Category Management  --- */

  /**
   * @dev Updates the prices on the oracle for all the tokens in a category.
   */
  function updateCategoryPrices(uint256 categoryID) external {
    address[] memory tokens = _categoryTokens[categoryID];
    oracle.updatePrices(tokens);
  }

  /**
   * @dev Creates a new token category.
   * @param metadataHash Hash of metadata about the token category
   * which can be distributed on IPFS.
   */
  function createCategory(bytes32 metadataHash) external _owner_ {
    uint256 categoryID = ++categoryIndex;
    emit CategoryAdded(categoryID, metadataHash);
  }

  /**
   * @dev Adds a new token to a category.
   * Note: A token can only be assigned to one category at a time.
   */
  function addToken(address token, uint256 categoryID) external _owner_ {
    require(
      categoryID <= categoryIndex && categoryID > 0,
      "ERR_CATEGORY_ID"
    );
    require(
      _categoryTokens[categoryID].length < MAX_CATEGORY_TOKENS,
      "ERR_MAX_CATEGORY_TOKENS"
    );
    _addToken(token, categoryID);
    oracle.updatePrice(token);
    // Decrement the timestamp for the last category update to ensure
    // that the new token is sorted before the category's top tokens
    // can be queried.
    _lastCategoryUpdate[categoryID] -= MAX_SORT_DELAY;
  }

  /**
   * @dev Add tokens to a category.
   * @param categoryID Category identifier.
   * @param tokens Array of tokens to add to the category.
   */
  function addTokens(
    uint256 categoryID,
    address[] calldata tokens
  )
    external
    _owner_
  {
    require(
      categoryID <= categoryIndex && categoryID > 0,
      "ERR_CATEGORY_ID"
    );
    require(
      _categoryTokens[categoryID].length + tokens.length <= MAX_CATEGORY_TOKENS,
      "ERR_MAX_CATEGORY_TOKENS"
    );
    for (uint256 i = 0; i < tokens.length; i++) {
      _addToken(tokens[i], categoryID);
    }
    oracle.updatePrices(tokens);
    // Decrement the timestamp for the last category update to ensure
    // that the new tokens are sorted before the category's top tokens
    // can be queried.
    _lastCategoryUpdate[categoryID] -= MAX_SORT_DELAY;
  }

  /**
   * @dev Sorts a category's tokens in descending order by market cap.
   *
   * Verifies the order of the provided array by querying the market caps.
   *
   * @param categoryID Category to sort
   * @param orderedTokens Array of category tokens ordered by market cap
   */
  function orderCategoryTokensByMarketCap(
    uint256 categoryID,
    address[] calldata orderedTokens
  ) external {
    address[] storage categoryTokens = _categoryTokens[categoryID];
    uint256 len = orderedTokens.length;
    require(categoryTokens.length == len, "ERR_ARR_LEN");

    // Verify there are no duplicate addresses and that all tokens are bound.
    bool[] memory usedIndices = new bool[](len);
    for (uint256 i = 0; i < len; i++) {
      CategoryTokenRecord memory record = _categoryTokenRecords[categoryID][orderedTokens[i]];
      require(record.bound, "ERR_NOT_IN_CATEGORY");
      require(!usedIndices[record.index], "ERR_DUPLICATE_ADDRESS");
      usedIndices[record.index] = true;
    }

    uint144[] memory marketCaps = computeAverageMarketCaps(orderedTokens);
    // Verify that the tokens are ordered correctly and update their positions
    // in the category.
    for (uint256 i = 0; i < len; i++) {
      address token = orderedTokens[i];
      if (i != 0) {
        require(marketCaps[i] <= marketCaps[i-1], "ERR_TOKEN_ORDER");
      }
      _categoryTokenRecords[categoryID][token].index = uint8(i);
      categoryTokens[i] = token;
    }
    _lastCategoryUpdate[categoryID] = now;
    emit CategorySorted(categoryID);
  }

/* ---  Market Cap Queries  --- */

  /**
   * @dev Compute the average market cap of a token in weth.
   * Queries the average amount of ether that the total supply is worth
   * using the recent moving average price.
   */
  function computeAverageMarketCap(address token)
    public
    view
    returns (uint144 marketCap)
  {
    uint256 totalSupply = IERC20(token).totalSupply();
    return oracle.computeAverageAmountOut(token, totalSupply);
  }

  /**
   * @dev Returns the average market cap for each token.
   */
  function computeAverageMarketCaps(address[] memory tokens)
    public
    view
    returns (uint144[] memory marketCaps)
  {
    uint256 len = tokens.length;
    uint256[] memory totalSupplies = new uint256[](len);
    for (uint256 i = 0; i < len; i++) {
      totalSupplies[i] = IERC20(tokens[i]).totalSupply();
    }
    marketCaps = oracle.computeAverageAmountsOut(
      tokens, totalSupplies
    );
  }

/* ---  Category Queries  --- */

  /**
   * @dev Returns a boolean stating whether a category exists.
   */
  function hasCategory(uint256 categoryID) external view returns (bool) {
    return categoryID <= categoryIndex && categoryID > 0;
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
      categoryID <= categoryIndex && categoryID > 0,
      "ERR_CATEGORY_ID"
    );
    address[] storage _tokens = _categoryTokens[categoryID];
    tokens = new address[](_tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      tokens[i] = _tokens[i];
    }
  }

  /**
   * @dev Returns the fully diluted market caps for the tokens in a category.
   */
  function getCategoryMarketCaps(uint256 categoryID)
    external
    view
    returns (uint144[] memory marketCaps)
  {
    return computeAverageMarketCaps(_categoryTokens[categoryID]);
  }

  /**
   * @dev Get the top `num` tokens in a category.
   *
   * Note: The category must have been sorted by market cap
   * in the last `MAX_SORT_DELAY` seconds.
   */
  function getTopCategoryTokens(uint256 categoryID, uint256 num)
    public
    view
    returns (address[] memory tokens)
  {
    require(
      categoryID <= categoryIndex && categoryID > 0,
      "ERR_CATEGORY_ID"
    );
    address[] storage categoryTokens = _categoryTokens[categoryID];
    require(
      num <= categoryTokens.length,
      "ERR_CATEGORY_SIZE"
    );
    require(
      now - _lastCategoryUpdate[categoryID] <= MAX_SORT_DELAY,
      "ERR_CATEGORY_NOT_READY"
    );
    tokens = new address[](num);
    for (uint256 i = 0; i < num; i++) tokens[i] = categoryTokens[i];
  }

/* ---  Category Utility Functions  --- */

  /**
   * @dev Adds a new token to a category.
   */
  function _addToken(address token, uint256 categoryID) internal {
    CategoryTokenRecord storage record = _categoryTokenRecords[categoryID][token];
    require(!record.bound, "ERR_TOKEN_BOUND");
    record.bound = true;
    record.index = uint8(_categoryTokens[categoryID].length);
    _categoryTokens[categoryID].push(token);
    emit TokenAdded(token, categoryID);
  }
}