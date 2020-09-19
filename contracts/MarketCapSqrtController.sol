pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { IPool } from "./balancer/IPool.sol";
import "./balancer/BNum.sol";
import "./interfaces/IERC20.sol";
import "./lib/FixedPoint.sol";
import "./lib/Create2.sol";
import "./lib/Babylonian.sol";
import "./openzeppelin/SafeMath.sol";
import { MCapSqrtLibrary as MCapSqrt } from "./lib/MCapSqrtLibrary.sol";
import { UniSwapV2PriceOracle } from "./UniSwapV2PriceOracle.sol";
import { PoolFactory } from "./PoolFactory.sol";
import {
  DelegateCallProxyManager
} from "./proxies/DelegateCallProxyManager.sol";
import {
  DelegateCallProxyManyToOne
} from "./proxies/DelegateCallProxyManyToOne.sol";
import { PoolInitializer } from "./PoolInitializer.sol";

/**
 * @dev This contract implements the market cap square root index management strategy.
 *
 * Categories are periodically sorted, ranking their tokens in descending order by
 * market cap.
 *
 * Index pools have a defined size which is used to select the top tokens from the pool's
 * category.
 *
 * Every 2 weeks, pools are either re-weighed or re-indexed.
 * They are re-indexed once for every three re-weighs.
 *
 * Re-indexing involves selecting the top tokens from the pool's category and weighing them
 * by the square root of their market caps.
 * Re-weighing involves weighing the tokens which are already indexed by the pool by the
 * square root of their market caps.
 * When a pool is re-weighed, only the tokens with a desired weight above 0 are included.
 */
contract MarketCapSqrtController is BNum {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;
  using Babylonian for uint144;
  using SafeMath for uint256;

/* ---  Constants  --- */

  // Bytecode hash of the many-to-one proxy contract.
  bytes32 internal constant PROXY_CODEHASH
    = keccak256(type(DelegateCallProxyManyToOne).creationCode);

  // Identifier for the pool initializer implementation on the proxy manager.
  bytes32 internal constant INITIALIZER_IMPLEMENTATION_ID
    = keccak256("PoolInitializer.sol");

  // Identifier for the index pool implementation on the proxy manager.
  bytes32 internal constant POOL_IMPLEMENTATION_ID
    = keccak256("IPool.sol");

  // Default total weight for a pool.
  uint256 internal constant WEIGHT_MULTIPLIER = BONE * 25;

  // Time between reweigh/reindex calls.
  uint256 internal constant POOL_REWEIGH_DELAY = 14 days;

  // The number of reweighs which occur before a pool is re-indexed.
  uint256 internal constant REWEIGHS_BEFORE_REINDEX = 3;

  // Maximum time between a category being sorted and a query for the top n tokens
  uint256 internal constant MAX_SORT_DELAY = 1 days;

  // Maximum number of tokens in a category
  uint256 internal constant MAX_CATEGORY_TOKENS = 15;

  // UniSwap price oracle
  UniSwapV2PriceOracle internal immutable _oracle;

  PoolFactory internal immutable _factory;

  DelegateCallProxyManager internal immutable _proxyManager;

/* ---  Events  --- */

  /** @dev Emitted when a new category is created. */
  event CategoryAdded(uint256 categoryID, bytes32 metadataHash);

  /** @dev Emitted when a category is sorted. */
  event CategorySorted(uint256 categoryID);

  /** @dev Emitted when a token is added to a category. */
  event TokenAdded(address token, uint256 categoryID);

  /** @dev Emitted when a pool is initialized and made public. */
  event LOG_POOL_INITIALIZED(
    address indexed pool,
    uint256 categoryID,
    uint256 indexSize
  );

  /** @dev Emitted when a pool and its initializer are deployed. */
  event LOG_NEW_POOL_INITIALIZER(
    address poolAddress,
    address preDeploymentPool,
    uint256 categoryID,
    uint256 indexSize
  );

/* ---  Structs  --- */

  struct IndexPoolMeta {
    uint16 categoryID;
    uint8 indexSize;
    bool initialized;
  }

  /**
   * @dev Data structure with the number of times a pool has been
   * either reweighed or re-indexed, as well as the timestamp of
   * the last such action.
   *
   * If `++index % REWEIGHS_BEFORE_REINDEX + 1` is 0, the pool will
   * re-index, otherwise it will reweigh.
   *
   * @param index Number of times the pool has either re-weighed or
   * re-indexed.
   * @param timestamp Timestamp of last pool re-weigh or re-index.
   */
  struct PoolUpdateRecord {
    uint128 index;
    uint128 timestamp;
  }

  struct CategoryTokenRecord {
    bool bound;
    uint8 index;
  }

/* ---  Storage  --- */

  // Address of the NDX governance contract
  address internal _ndx;
  // Number of categories in the oracle.
  uint256 public categoryIndex;
  // Array of tokens for each category.
  mapping(uint256 => address[]) internal _categoryTokens;
  // Category ID for each token.
  mapping(address => uint256) internal _tokenCategories;
  mapping(
    uint256 => mapping(address => CategoryTokenRecord)
  ) internal _categoryTokenRecords;
  // Last time a category was sorted
  mapping(uint256 => uint256) internal _lastCategoryUpdate;
  // Metadata about index pools
  mapping(address => IndexPoolMeta) internal _poolMeta;
  // Records of pool update statuses.
  mapping(address => PoolUpdateRecord) internal _poolUpdateRecords;

/* ---  Modifiers  --- */

  modifier _ndx_ {
    require(msg.sender == _ndx, "ERR_NOT_NDX");
    _;
  }

/* ---  Constructor  --- */

  /**
   * @dev Deploy the controller and configure the addresses
   * of the related contracts.
   */
  constructor(
    UniSwapV2PriceOracle oracle,
    address ndx,
    PoolFactory factory,
    DelegateCallProxyManager proxyManager
  ) public {
    _oracle = oracle;
    _ndx = ndx;
    _factory = factory;
    _proxyManager = proxyManager;
  }

  /**
   * @dev Set the address of the ndx contract.
   * After deployment this will likely never change, but it is useful
   * to have some small window during which things can be initialized
   * before governance is fully in place.
   */
  function setOwner(address owner) external _ndx_ {
    _ndx = owner;
  }

/* ---  Pool Deployment  --- */

  /**
   * @dev Deploys an index pool and a pool initializer.
   * The initializer contract is a pool with specific token
   * balance targets which gives pool tokens in the finished
   * pool to users who provide the underlying tokens needed
   * to initialize it.
   */
  function prepareIndexPool(
    uint256 categoryID,
    uint256 indexSize,
    uint256 initialWethValue,
    string calldata name,
    string calldata symbol
  )
    external
    _ndx_
  {
    require(indexSize >= MIN_BOUND_TOKENS, "ERR_MIN_BOUND_TOKENS");
    require(indexSize <= MAX_BOUND_TOKENS, "ERR_MAX_BOUND_TOKENS");

    address poolAddress = _factory.deployIndexPool(
      _poolSalt(categoryID, indexSize),
      name,
      symbol
    );
    // computePoolAddress(categoryID, indexSize);
    _poolMeta[poolAddress] = IndexPoolMeta({
      categoryID: uint8(categoryID),
      indexSize: uint8(indexSize),
      initialized: false
    });
    PoolInitializer initializer = PoolInitializer(
      _proxyManager.deployProxyManyToOne(
        INITIALIZER_IMPLEMENTATION_ID,
        _initializerSalt(poolAddress)
      )
    );
    (address[] memory tokens, uint256[] memory balances)
      = getInitialTokensAndBalances(
        categoryID, indexSize, initialWethValue
      );
    initializer.initialize(
      address(this),
      poolAddress,
      tokens,
      balances
    );
    emit LOG_NEW_POOL_INITIALIZER(
      poolAddress,
      address(initializer),
      categoryID,
      indexSize
    );
  }

  /**
   * @dev Initializes a pool which has been deployed but not initialized
   * and transfers the underlying tokens from the initialization pool to
   * the actual pool.
   */
  function finishPreparedIndexPool(
    address poolAddress,
    address[] calldata tokens,
    uint256[] calldata balances
  ) external {
    require(
      msg.sender == computeInitializerAddress(poolAddress),
      "ERR_NOT_PRE_DEPLOY_POOL"
    );
    uint256 len = tokens.length;
    require(balances.length == len, "ERR_ARR_LEN");
    IndexPoolMeta memory meta = _poolMeta[poolAddress];
    require(!meta.initialized, "ERR_INITIALIZED");
    uint96[] memory denormalizedWeights = new uint96[](len);
    uint256 valueSum;
    uint144[] memory ethValues = _oracle.computeAverageAmountsOut(
      tokens, balances
    );
    for (uint256 i = 0; i < len; i++) {
      valueSum = valueSum.add(ethValues[i]);
    }
    for (uint256 i = 0; i < len; i++) {
      denormalizedWeights[i] = _denormalizeFractionalWeight(
        FixedPoint.fraction(uint112(ethValues[i]), uint112(valueSum))
      );
    }
    IPool(poolAddress).initialize(
      tokens,
      balances,
      denormalizedWeights,
      msg.sender
    );
    _poolMeta[poolAddress].initialized = true;
    emit LOG_POOL_INITIALIZED(
      poolAddress,
      meta.categoryID,
      meta.indexSize
    );
  }

/* ---  Pool Management  --- */

  /**
   * @dev Sets the swap fee on an index pool.
   */
  function setSwapFee(address poolAddress, uint256 swapFee) external _ndx_ {
    require(_havePool(poolAddress), "ERR_POOL_NOT_FOUND");
    IPool(poolAddress).setSwapFee(swapFee);
  }

  /**
   * @dev Freezes public trading and liquidity providing on an index pool.
   */
  function pausePublicTrading(address poolAddress) external _ndx_ {
    require(_havePool(poolAddress), "ERR_POOL_NOT_FOUND");
    IPool(poolAddress).setPublicSwap(false);
  }

  /**
   * @dev Resumes public trading and liquidity providing on an index pool.
   */
  function resumePublicTrading(address poolAddress) external _ndx_ {
    require(_havePool(poolAddress), "ERR_POOL_NOT_FOUND");
    IPool(poolAddress).setPublicSwap(true);
  }

  /**
   * @dev Forcibly removes a token from a pool.
   * This should only be used as a last resort if a token is experiencing
   * a sudden crash or major vulnerability. Otherwise, tokens should only
   * be removed gradually through re-indexing events.
   */
  function removeTokenFromPool(address poolAddress, address tokenAddress) external _ndx_ {
    require(_havePool(poolAddress), "ERR_POOL_NOT_FOUND");
    IPool(poolAddress).unbind(tokenAddress);
  }

  /**
   * @dev Updates the minimum balance of an uninitialized token, which is
   * useful when the token's price on the pool is too low relative to
   * external prices for people to trade it in.
   */
  function setMinimumBalance(IPool pool, address tokenAddress) external {
    require(_havePool(address(pool)), "ERR_POOL_NOT_FOUND");
    IPool.Record memory record = pool.getTokenRecord(tokenAddress);
    require(!record.ready, "ERR_TOKEN_READY");
    uint256 poolValue = _estimatePoolValue(pool);
    FixedPoint.uq112x112 memory price = _oracle.computeAveragePrice(tokenAddress);
    pool.setMinimumBalance(
      tokenAddress,
      price.reciprocal().mul(poolValue).decode144() / 100
    );
  }

/* ---  Category Management  --- */

  /**
   * @dev Create a new token category.
   * @param metadataHash Hash of metadata about the token category
   * which can be distributed on IPFS.
   */
  function createCategory(bytes32 metadataHash) external _ndx_ {
    uint256 categoryID = ++categoryIndex;
    emit CategoryAdded(categoryID, metadataHash);
  }

  /**
   * @dev Adds a new token to a category.
   * Note: A token can only be assigned to one category at a time.
   */
  function addToken(address token, uint256 categoryID) external _ndx_ {
    require(
      categoryID <= categoryIndex && categoryID > 0,
      "ERR_CATEGORY_ID"
    );
    require(
      _categoryTokens[categoryID].length < MAX_CATEGORY_TOKENS,
      "ERR_MAX_CATEGORY_TOKENS"
    );
    _addToken(token, categoryID);
    _oracle.updatePrice(token);
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
    _ndx_
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
    _oracle.updatePrices(tokens);
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
    uint256[] memory usedIndices = new uint256[](len);
    for (uint256 i = 0; i < len; i++) {
      CategoryTokenRecord memory record = _categoryTokenRecords[categoryID][orderedTokens[i]];
      require(record.bound, "ERR_NOT_IN_CATEGORY");
      require(usedIndices[record.index] == 0, "ERR_DUPLICATE_ADDRESS");
      usedIndices[record.index] = 1;
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

/* ---  Pool Rebalance Actions  --- */

  /**
   * @dev Re-indexes a pool by setting the underlying assets to the top
   * tokens in its category by market cap.
   */
  function reindexPool(address poolAddress) external {
    IndexPoolMeta memory meta = _poolMeta[poolAddress];
    require(meta.initialized, "ERR_POOL_NOT_FOUND");
    PoolUpdateRecord memory record = _poolUpdateRecords[poolAddress];
    require(
      now - record.timestamp >= POOL_REWEIGH_DELAY,
      "ERR_POOL_REWEIGH_DELAY"
    );
    require(
      (++record.index % (REWEIGHS_BEFORE_REINDEX + 1)) == 0,
      "ERR_REWEIGH_INDEX"
    );
    uint256 size = meta.indexSize;
    address[] memory tokens = getTopCategoryTokens(meta.categoryID, size);
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = MCapSqrt.computeTokenWeights(tokens, prices);
    uint256[] memory minimumBalances = new uint256[](size);
    uint96[] memory denormalizedWeights = new uint96[](size);
    uint144 totalValue = _estimatePoolValue(IPool(poolAddress));
    for (uint256 i = 0; i < size; i++) {
      // The minimum balance is the number of tokens worth
      // the minimum weight of the pool. The minimum weight
      // is 1/100, so we divide the total value by 100.
      minimumBalances[i] = prices[i].reciprocal().mul(
        totalValue
      ).decode144() / 100;
      denormalizedWeights[i] = _denormalizeFractionalWeight(weights[i]);
    }
    IPool(poolAddress).reindexTokens(
      tokens,
      denormalizedWeights,
      minimumBalances
    );
    record.timestamp = uint128(now);
    _poolUpdateRecords[poolAddress] = record;
  }

  /**
   * @dev Reweighs the assets in a pool by market cap and sets the
   * desired new weights, which will be adjusted over time.
   */
  function reweighPool(address poolAddress) external {
    require(_havePool(poolAddress), "ERR_POOL_NOT_FOUND");
    PoolUpdateRecord memory record = _poolUpdateRecords[poolAddress];
    require(
      now - record.timestamp >= POOL_REWEIGH_DELAY,
      "ERR_POOL_REWEIGH_DELAY"
    );
    require(
      (++record.index % (REWEIGHS_BEFORE_REINDEX + 1)) != 0,
      "ERR_REWEIGH_INDEX"
    );
    address[] memory tokens = IPool(poolAddress).getCurrentDesiredTokens();
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = MCapSqrt.computeTokenWeights(tokens, prices);
    uint96[] memory denormalizedWeights = new uint96[](tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      denormalizedWeights[i] = _denormalizeFractionalWeight(weights[i]);
    }
    IPool(poolAddress).reweighTokens(tokens, denormalizedWeights);
    record.timestamp = uint128(now);
    _poolUpdateRecords[poolAddress] = record;
  }

/* ---  Pool Queries  --- */

  /**
   * @dev Compute the create2 address for a pool initializer.
   */
  function computeInitializerAddress(address poolAddress)
    public
    view
    returns (address initializerAddress)
  {
    bytes32 salt = _initializerSalt(poolAddress);
    initializerAddress = Create2.computeAddress(
      salt, PROXY_CODEHASH, address(_proxyManager)
    );
  }

  /**
   * @dev Compute the create2 address for a pool.
   */
  function computePoolAddress(uint256 categoryID, uint256 indexSize)
    public
    view
    returns (address poolAddress)
  {
    bytes32 suppliedSalt = _poolSalt(categoryID, indexSize);
    bytes32 salt = keccak256(abi.encodePacked(
      address(this), suppliedSalt
    ));
    poolAddress = Create2.computeAddress(
      salt, PROXY_CODEHASH, address(_proxyManager)
    );
  }

  /**
   * @dev Queries the top `indexSize` tokens in a category from the market _oracle,
   * computes their relative weights by market cap square root and determines
   * the weighted balance of each token to meet a specified total value.
   */
  function getInitialTokenWeightsAndBalances(
    uint256 categoryID,
    uint256 indexSize,
    uint256 wethValue
  )
    public
    view
    returns (
      address[] memory tokens,
      uint96[] memory denormalizedWeights,
      uint256[] memory balances
    )
  {
    tokens = getTopCategoryTokens(categoryID, indexSize);
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = MCapSqrt.computeTokenWeights(tokens, prices);
    balances = new uint256[](indexSize);
    denormalizedWeights = new uint96[](indexSize);
    for (uint256 i = 0; i < indexSize; i++) {
      uint144 weightedValue = weights[i].mul(wethValue).decode144();
      balances[i] = uint256(prices[i].reciprocal().mul(weightedValue).decode144());
      denormalizedWeights[i] = _denormalizeFractionalWeight(weights[i]);
    }
  }

  /**
   * @dev Queries the top `indexSize` tokens in a category from the market _oracle,
   * computes their relative weights by market cap square root and determines
   * the weighted balance of each token to meet a specified total value.
   */
  function getInitialTokensAndBalances(
    uint256 categoryID,
    uint256 indexSize,
    uint256 wethValue
  )
    public
    view
    returns (
      address[] memory tokens,
      uint256[] memory balances
    )
  {
    tokens = getTopCategoryTokens(categoryID, indexSize);
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = MCapSqrt.computeTokenWeights(tokens, prices);
    balances = new uint256[](indexSize);
    for (uint256 i = 0; i < indexSize; i++) {
      uint144 weightedValue = weights[i].mul(wethValue).decode144();
      balances[i] = uint256(prices[i].reciprocal().mul(weightedValue).decode144());
    }
  }

/* ---  Market Cap Queries  --- */

  /**
   * @dev Compute the average market cap of a token in WETH.
   * Queries the average amount of ether that the total supply is worth
   * using the recent moving average.
   */
  function computeAverageMarketCap(address token)
    public
    view
    returns (uint144 marketCap)
  {
    uint256 totalSupply = IERC20(token).totalSupply();
    return _oracle.computeAverageAmountOut(token, totalSupply);
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
    marketCaps = _oracle.computeAverageAmountsOut(
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
   * @dev Returns the market capitalization rates for the tokens
   * in a category.
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
    require(_tokenCategories[token] == 0, "ERR_TOKEN_EXISTS");
    CategoryTokenRecord storage record = _categoryTokenRecords[categoryID][token];
    require(!record.bound, "ERR_TOKEN_BOUND");
    record.bound = true;
    record.index = uint8(_categoryTokens[categoryID].length);
    _categoryTokens[categoryID].push(token);
    emit TokenAdded(token, categoryID);
  }

/* ---  Pool Utility Functions  --- */

  function _havePool(address pool) internal view returns (bool) {
    return _poolMeta[pool].initialized;
  }

  /**
   * @dev Estimate the total value of a pool by taking its first token's
   * "virtual balance" (balance * (totalWeight/weight)) and multiplying
   * by that token's average ether price from UniSwap.
   */
  function _estimatePoolValue(IPool pool) internal view returns (uint144) {
    (address token, uint256 value) = pool.extrapolatePoolValueFromToken();
    FixedPoint.uq112x112 memory price = _oracle.computeAveragePrice(token);
    return price.mul(value).decode144();
  }

  function _initializerSalt(address poolAddress)
    internal
    view
    returns (bytes32 salt)
  {
    return keccak256(abi.encodePacked(
      address(this),
      INITIALIZER_IMPLEMENTATION_ID,
      poolAddress
    ));
  }

  function _poolSalt(uint256 categoryID, uint256 indexSize)
    internal
    view
    returns (bytes32 salt)
  {
    return keccak256(abi.encodePacked(
      POOL_IMPLEMENTATION_ID,
      categoryID,
      indexSize
    ));
  }

/* ---  General Utility Functions  --- */

  /**
   * @dev Converts a fixed point fraction to a denormalized weight.
   * Multiply the fraction by the max weight and decode to an unsigned integer.
   */
  function _denormalizeFractionalWeight(FixedPoint.uq112x112 memory fraction)
    internal
    pure
    returns (uint96)
  {
    return uint96(fraction.mul(WEIGHT_MULTIPLIER).decode144());
  }
  
  /**
   * @dev Re-assigns a uint128 array to a uint256 array.
   * This does not affect memory allocation as all Solidity
   * uint arrays take 32 bytes per item.
   */
  function _to256Array(uint128[] memory arr)
    internal
    pure
    returns (uint256[] memory outArr)
  {
    assembly { outArr := arr }
  }
}