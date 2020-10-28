// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

/* --- External Inheritance --- */
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/* --- External Interfaces --- */
import { IIndexedUniswapV2Oracle } from "@indexed-finance/uniswap-v2-oracle/contracts/interfaces/IIndexedUniswapV2Oracle.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/* --- External Libraries --- */
import { PriceLibrary as Prices } from "@indexed-finance/uniswap-v2-oracle/contracts/lib/PriceLibrary.sol";


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
contract MarketCapSortedTokenCategories is Ownable {
/* ---  Constants  --- */

  // Maximum time between a category being sorted and a query for the top n tokens
  uint256 internal constant MAX_SORT_DELAY = 1 days;

  // Maximum number of tokens in a category
  uint256 internal constant MAX_CATEGORY_TOKENS = 15;

  // Long term price oracle
  IIndexedUniswapV2Oracle public immutable oracle;

/* ---  Events  --- */

  /** @dev Emitted when a new category is created. */
  event CategoryAdded(uint256 categoryID, bytes32 metadataHash);

  /** @dev Emitted when a category is sorted. */
  event CategorySorted(uint256 categoryID);

  /** @dev Emitted when a token is added to a category. */
  event TokenAdded(address token, uint256 categoryID);

/* ---  Storage  --- */

  // Number of categories that exist.
  uint256 public categoryIndex;
  // Array of tokens for each category.
  mapping(uint256 => address[]) internal _categoryTokens;
  mapping(uint256 => mapping(address => bool)) internal _isCategoryToken;
  // Last time a category was sorted
  mapping(uint256 => uint256) internal _lastCategoryUpdate;

/* --- Modifiers --- */

  modifier validCategory(uint256 categoryID) {
    require(categoryID <= categoryIndex && categoryID > 0, "ERR_CATEGORY_ID");
    _;
  }

/* ---  Constructor  --- */

  /**
   * @dev Deploy the controller and configure the addresses
   * of the related contracts.
   */
  constructor(IIndexedUniswapV2Oracle _oracle) public Ownable() {
    oracle = _oracle;
  }

/* ---  Category Management  --- */

  /**
   * @dev Updates the prices on the oracle for all the tokens in a category.
   */
  function updateCategoryPrices(uint256 categoryID) external validCategory(categoryID) {
    address[] memory tokens = _categoryTokens[categoryID];
    oracle.updatePrices(tokens);
  }

  /**
   * @dev Creates a new token category.
   * @param metadataHash Hash of metadata about the token category
   * which can be distributed on IPFS.
   */
  function createCategory(bytes32 metadataHash) external onlyOwner {
    uint256 categoryID = ++categoryIndex;
    emit CategoryAdded(categoryID, metadataHash);
  }

  /**
   * @dev Adds a new token to a category.
   * Note: A token can only be assigned to one category at a time.
   */
  function addToken(address token, uint256 categoryID) external onlyOwner validCategory(categoryID) {
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
  function addTokens(uint256 categoryID, address[] calldata tokens)
    external
    onlyOwner
    validCategory(categoryID)
  {
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
   * Note: Uses in-memory insertion sort.
   *
   * @param categoryID Category to sort
   */
  function orderCategoryTokensByMarketCap(uint256 categoryID) external validCategory(categoryID) {
    address[] memory categoryTokens = _categoryTokens[categoryID];
    uint256 len = categoryTokens.length;
    uint144[] memory marketCaps = computeAverageMarketCaps(categoryTokens);
    for (uint256 i = 1; i < len; i++) {
      uint144 cap = marketCaps[i];
      address token = categoryTokens[i];
      uint256 j = i - 1;
      while (int(j) >= 0 && marketCaps[j] < cap) {
        marketCaps[j + 1] = marketCaps[j];
        categoryTokens[j + 1] = categoryTokens[j];
        j--;
      }
      marketCaps[j + 1] = cap;
      categoryTokens[j + 1] = token;
    }
    _categoryTokens[categoryID] = categoryTokens;
    
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
    returns (uint144)
  {
    uint256 totalSupply = IERC20(token).totalSupply();
    return oracle.computeAverageEthForTokens(
      token,
      totalSupply,
      1.75 days,
      1 weeks
    );
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
    marketCaps = oracle.computeAverageEthForTokens(
      tokens,
      totalSupplies,
      1.75 days,
      1 weeks
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
   * @dev Returns the timestamp of the last time the category was sorted.
   */
  function getLastCategoryUpdate(uint256 categoryID)
    external
    view
    validCategory(categoryID)
    returns (uint256)
  {
    return _lastCategoryUpdate[categoryID];
  }

  /**
   * @dev Returns boolean stating whether `token` is a member of the category `categoryID`.
   */
  function isTokenInCategory(uint256 categoryID, address token)
    external
    view
    validCategory(categoryID)
    returns (bool)
  {
    return _isCategoryToken[categoryID][token];
  }

  /**
   * @dev Returns the array of tokens in a category.
   */
  function getCategoryTokens(uint256 categoryID)
    external
    view
    validCategory(categoryID)
    returns (address[] memory tokens)
  {
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
    validCategory(categoryID)
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
    validCategory(categoryID)
    returns (address[] memory tokens)
  {
    address[] storage categoryTokens = _categoryTokens[categoryID];
    require(num <= categoryTokens.length, "ERR_CATEGORY_SIZE");
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
    require(!_isCategoryToken[categoryID][token], "ERR_TOKEN_BOUND");
    _isCategoryToken[categoryID][token] = true;
    _categoryTokens[categoryID].push(token);
    emit TokenAdded(token, categoryID);
  }
}