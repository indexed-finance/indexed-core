// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

/* ========== External Interfaces ========== */
import "@indexed-finance/uniswap-v2-oracle/contracts/interfaces/IIndexedUniswapV2Oracle.sol";
import "@indexed-finance/proxies/contracts/interfaces/IDelegateCallProxyManager.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/* ========== External Libraries ========== */
import "@indexed-finance/uniswap-v2-oracle/contracts/lib/PriceLibrary.sol";
import "@indexed-finance/uniswap-v2-oracle/contracts/lib/FixedPoint.sol";
import "@indexed-finance/proxies/contracts/SaltyLib.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

/* ========== Internal Interfaces ========== */
import "./interfaces/IIndexPool.sol";
import "./interfaces/IPoolFactory.sol";
import "./interfaces/IPoolInitializer.sol";
import "./interfaces/IUnboundTokenSeller.sol";

/* ========== Internal Libraries ========== */
import "./lib/MCapSqrtLibrary.sol";

/* ========== Internal Inheritance ========== */
import "./MarketCapSortedTokenCategories.sol";


/**
 * @title MarketCapSqrtController
 * @author d1ll0n
 * @dev This contract implements the market cap square root index management strategy.
 *
 * Index pools have a defined size which is used to select the top tokens from the pool's
 * category.
 *
 * REBALANCING
 * ===============
 * Every 1 weeks, pools are either re-weighed or re-indexed.
 * They are re-indexed once for every three re-weighs.
 *
 * Re-indexing involves selecting the top tokens from the pool's category and weighing them
 * by the square root of their market caps.
 * Re-weighing involves weighing the tokens which are already indexed by the pool by the
 * square root of their market caps.
 * When a pool is re-weighed, only the tokens with a desired weight above 0 are included.
 * ===============
 */
contract MarketCapSqrtController is MarketCapSortedTokenCategories {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;
  using SafeMath for uint256;
  using PriceLibrary for PriceLibrary.TwoWayAveragePrice;

/* ==========  Constants  ========== */
  // Minimum number of tokens in an index.
  uint256 internal constant MIN_INDEX_SIZE = 2;

  // Maximum number of tokens in an index.
  uint256 internal constant MAX_INDEX_SIZE = 10;

  // Minimum balance for a token (only applied at initialization)
  uint256 internal constant MIN_BALANCE = 1e6;

  // Identifier for the pool initializer implementation on the proxy manager.
  bytes32 internal constant INITIALIZER_IMPLEMENTATION_ID = keccak256("PoolInitializer.sol");

  // Identifier for the unbound token seller implementation on the proxy manager.
  bytes32 internal constant SELLER_IMPLEMENTATION_ID = keccak256("UnboundTokenSeller.sol");

  // Identifier for the index pool implementation on the proxy manager.
  bytes32 internal constant POOL_IMPLEMENTATION_ID = keccak256("IndexPool.sol");

  // Default total weight for a pool.
  uint256 internal constant WEIGHT_MULTIPLIER = 25e18;

  // Time between reweigh/reindex calls.
  uint256 internal constant POOL_REWEIGH_DELAY = 1 weeks;

  // The number of reweighs which occur before a pool is re-indexed.
  uint256 internal constant REWEIGHS_BEFORE_REINDEX = 3;

  // Pool factory contract
  IPoolFactory internal immutable _factory;

  // Proxy manager & factory
  IDelegateCallProxyManager internal immutable _proxyManager;

/* ==========  Events  ========== */

  /** @dev Emitted when a pool is initialized and made public. */
  event PoolInitialized(
    address pool,
    address unboundTokenSeller,
    uint256 categoryID,
    uint256 indexSize
  );

  /** @dev Emitted when a pool and its initializer are deployed. */
  event NewPoolInitializer(
    address pool,
    address initializer,
    uint256 categoryID,
    uint256 indexSize
  );

  /** @dev Emitted when a pool is reweighed. */
  event PoolReweighed(address pool);

  /** @dev Emitted when a pool is reindexed. */
  event PoolReindexed(address pool);

/* ==========  Structs  ========== */

  /**
   * @dev Data structure with metadata about an index pool.
   *
   * Includes the number of times a pool has been either reweighed
   * or re-indexed, as well as the timestamp of the last such action.
   *
   * To reweigh or re-index, the last update must have occurred at
   * least `POOL_REWEIGH_DELAY` seconds ago.
   *
   * If `++index % REWEIGHS_BEFORE_REINDEX + 1` is 0, the pool will
   * re-index, otherwise it will reweigh.
   *
   * The struct fields are assigned their respective integer sizes so
   * that solc can pack the entire struct into a single storage slot.
   * `reweighIndex` is intended to overflow, `categoryID` will never
   * reach 2**16, `indexSize` is capped at 10 and it is unlikely that
   * this protocol will be in use in the year 292277026596 (unix time
   * for 2**64 - 1).
   *
   * @param initialized Whether the pool has been initialized with the
   * starting balances.
   * @param categoryID Category identifier for the pool.
   * @param indexSize Number of tokens the pool should hold.
   * @param reweighIndex Number of times the pool has either re-weighed
   * or re-indexed.
   * @param lastReweigh Timestamp of last pool re-weigh or re-index.
   */
  struct IndexPoolMeta {
    bool initialized;
    uint16 categoryID;
    uint8 indexSize;
    uint8 reweighIndex;
    uint64 lastReweigh;
  }

/* ==========  Storage  ========== */

  // Default slippage rate for token seller contracts.
  uint8 public defaultSellerPremium;

  // Metadata about index pools
  mapping(address => IndexPoolMeta) internal _poolMeta;

  address public defaultExitFeeRecipient;

/* ========== Modifiers ========== */

  modifier _havePool(address pool) {
    require(_poolMeta[pool].initialized, "ERR_POOL_NOT_FOUND");
    _;
  }

/* ==========  Constructor  ========== */

  /**
   * @dev Deploy the controller and configure the addresses
   * of the related contracts.
   */
  constructor(
    IIndexedUniswapV2Oracle oracle,
    IPoolFactory factory,
    IDelegateCallProxyManager proxyManager
  )
    public
    MarketCapSortedTokenCategories(oracle)
  {
    _factory = factory;
    _proxyManager = proxyManager;
  }

/* ==========  Initializer  ========== */

  /**
   * @dev Initialize the controller with the owner address and default seller premium.
   * This sets up the controller which is deployed as a singleton proxy.
   */
  function initialize() public override {
    defaultSellerPremium = 2;
    super.initialize();
  }

/* ==========  Pool Deployment  ========== */

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
    onlyOwner
    returns (address poolAddress, address initializerAddress)
  {
    require(indexSize >= MIN_INDEX_SIZE, "ERR_MIN_INDEX_SIZE");
    require(indexSize <= MAX_INDEX_SIZE, "ERR_MAX_INDEX_SIZE");
    require(initialWethValue < uint144(-1), "ERR_MAX_UINT144");

    poolAddress = _factory.deployPool(
      POOL_IMPLEMENTATION_ID,
      keccak256(abi.encodePacked(categoryID, indexSize))
    );
    IIndexPool(poolAddress).configure(address(this), name, symbol, defaultExitFeeRecipient);

    _poolMeta[poolAddress] = IndexPoolMeta({
      initialized: false,
      categoryID: uint16(categoryID),
      indexSize: uint8(indexSize),
      lastReweigh: 0,
      reweighIndex: 0
    });

    initializerAddress = _proxyManager.deployProxyManyToOne(
      INITIALIZER_IMPLEMENTATION_ID,
      keccak256(abi.encodePacked(poolAddress))
    );

    IPoolInitializer initializer = IPoolInitializer(initializerAddress);

    // Get the initial tokens and balances for the pool.
    (
      address[] memory tokens,
      uint256[] memory balances
    ) = getInitialTokensAndBalances(categoryID, indexSize, uint144(initialWethValue));

    initializer.initialize(poolAddress, tokens, balances);

    emit NewPoolInitializer(
      poolAddress,
      initializerAddress,
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
    uint144[] memory ethValues = oracle.computeAverageEthForTokens(
      tokens,
      balances,
      SHORT_TWAP_MIN_TIME_ELAPSED,
      SHORT_TWAP_MAX_TIME_ELAPSED
    );
    for (uint256 i = 0; i < len; i++) {
      valueSum = valueSum.add(ethValues[i]);
    }
    for (uint256 i = 0; i < len; i++) {
      denormalizedWeights[i] = _denormalizeFractionalWeight(
        FixedPoint.fraction(uint112(ethValues[i]), uint112(valueSum))
      );
    }

    address sellerAddress = _proxyManager.deployProxyManyToOne(
      SELLER_IMPLEMENTATION_ID,
      keccak256(abi.encodePacked(poolAddress))
    );

    IIndexPool(poolAddress).initialize(
      tokens,
      balances,
      denormalizedWeights,
      msg.sender,
      sellerAddress
    );

    IUnboundTokenSeller(sellerAddress).initialize(
      poolAddress,
      defaultSellerPremium
    );

    meta.lastReweigh = uint64(now);
    meta.initialized = true;
    _poolMeta[poolAddress] = meta;

    emit PoolInitialized(
      poolAddress,
      sellerAddress,
      meta.categoryID,
      meta.indexSize
    );
  }

/* ==========  Pool Management  ========== */

  /**
   * @dev Sets the default premium rate for token seller contracts.
   */
  function setDefaultSellerPremium(
    uint8 _defaultSellerPremium
  ) external onlyOwner {
    require(_defaultSellerPremium > 0 && _defaultSellerPremium < 20, "ERR_PREMIUM");
    defaultSellerPremium = _defaultSellerPremium;
  }

  /**
   * @dev Set the premium rate on `sellerAddress` to the given rate.
   */
  function updateSellerPremium(address tokenSeller, uint8 premiumPercent) external onlyOwner {
    require(premiumPercent > 0 && premiumPercent < 20, "ERR_PREMIUM");
    IUnboundTokenSeller(tokenSeller).setPremiumPercent(premiumPercent);
  }

  /**
   * @dev Sets the default exit fee recipient for new pools.
   */
  function setDefaultExitFeeRecipient(address defaultExitFeeRecipient_) external onlyOwner {
    require(defaultExitFeeRecipient_ != address(0), "ERR_NULL_ADDRESS");
    defaultExitFeeRecipient = defaultExitFeeRecipient_;
  }

  /**
   * @dev Sets the exit fee recipient on an existing pool.
   */
  function setExitFeeRecipient(address poolAddress, address exitFeeRecipient) external onlyOwner _havePool(poolAddress) {
    // No not-null requirement - already in pool function.
    IIndexPool(poolAddress).setExitFeeRecipient(exitFeeRecipient);
  }

  /**
   * @dev Sets the exit fee recipient on multiple existing pools.
   */
  function setExitFeeRecipient(address[] calldata poolAddresses, address exitFeeRecipient) external onlyOwner {
    for (uint256 i = 0; i < poolAddresses.length; i++) {
      address poolAddress = poolAddresses[i];
      require(_poolMeta[poolAddress].initialized, "ERR_POOL_NOT_FOUND");
      // No not-null requirement - already in pool function.
      IIndexPool(poolAddress).setExitFeeRecipient(exitFeeRecipient);
    }
  }

  /**
   * @dev Sets the swap fee on multiple index pools.
   */
  function setSwapFee(address poolAddress, uint256 swapFee) external onlyOwner _havePool(poolAddress) {
    IIndexPool(poolAddress).setSwapFee(swapFee);
  }

  /**
   * @dev Sets the swap fee on an index pool.
   */
  function setSwapFee(address[] calldata poolAddresses, uint256 swapFee) external onlyOwner {
    for (uint256 i = 0; i < poolAddresses.length; i++) {
      address poolAddress = poolAddresses[i];
      require(_poolMeta[poolAddress].initialized, "ERR_POOL_NOT_FOUND");
      // No not-null requirement - already in pool function.
      IIndexPool(poolAddress).setSwapFee(swapFee);
    }
  }

  /**
   * @dev Sets the controller on an index pool.
   */
  function setController(address poolAddress, address controller) external onlyOwner _havePool(poolAddress) {
    IIndexPool(poolAddress).setController(controller);
  }

  /**
   * @dev Updates the minimum balance of an uninitialized token, which is
   * useful when the token's price on the pool is too low relative to
   * external prices for people to trade it in.
   */
  function updateMinimumBalance(IIndexPool pool, address tokenAddress) external _havePool(address(pool)) {
    IIndexPool.Record memory record = pool.getTokenRecord(tokenAddress);
    require(!record.ready, "ERR_TOKEN_READY");
    uint256 poolValue = _estimatePoolValue(pool);
    PriceLibrary.TwoWayAveragePrice memory price = oracle.computeTwoWayAveragePrice(
      tokenAddress,
      SHORT_TWAP_MIN_TIME_ELAPSED,
      SHORT_TWAP_MAX_TIME_ELAPSED
    );
    uint256 minimumBalance = price.computeAverageTokensForEth(poolValue) / 100;
    pool.setMinimumBalance(tokenAddress, minimumBalance);
  }

  /**
   * @dev Delegates a comp-like governance token from an index pool
   * to a provided address.
   */
  function delegateCompLikeTokenFromPool(
    address pool,
    address token,
    address delegatee
  )
    external
    onlyOwner
    _havePool(pool)
  {
    IIndexPool(pool).delegateCompLikeToken(token, delegatee);
  }

/* ==========  Pool Rebalance Actions  ========== */

  /**
   * @dev Re-indexes a pool by setting the underlying assets to the top
   * tokens in its category by market cap.
   */
  function reindexPool(address poolAddress) external {
    IndexPoolMeta memory meta = _poolMeta[poolAddress];
    require(meta.initialized, "ERR_POOL_NOT_FOUND");
    require(
      now - meta.lastReweigh >= POOL_REWEIGH_DELAY,
      "ERR_POOL_REWEIGH_DELAY"
    );
    require(
      (++meta.reweighIndex % (REWEIGHS_BEFORE_REINDEX + 1)) == 0,
      "ERR_REWEIGH_INDEX"
    );
    uint256 size = meta.indexSize;
    address[] memory tokens = getTopCategoryTokens(meta.categoryID, size);
  
    PriceLibrary.TwoWayAveragePrice[] memory prices = oracle.computeTwoWayAveragePrices(
      tokens,
      LONG_TWAP_MIN_TIME_ELAPSED,
      LONG_TWAP_MAX_TIME_ELAPSED
    );
    FixedPoint.uq112x112[] memory weights = MCapSqrtLibrary.computeTokenWeights(tokens, prices);

    uint256[] memory minimumBalances = new uint256[](size);
    uint96[] memory denormalizedWeights = new uint96[](size);
    uint256 totalValue = _estimatePoolValue(IIndexPool(poolAddress));

    for (uint256 i = 0; i < size; i++) {
      // The minimum balance is the number of tokens worth the minimum weight
      // of the pool. The minimum weight is 1/100, so we divide the total value
      // by 100 to get the desired weth value, then multiply by the price of eth
      // in terms of that token to get the minimum balance.
      minimumBalances[i] = prices[i].computeAverageTokensForEth(totalValue) / 100;
      denormalizedWeights[i] = _denormalizeFractionalWeight(weights[i]);
    }

    meta.lastReweigh = uint64(now);
    _poolMeta[poolAddress] = meta;

    IIndexPool(poolAddress).reindexTokens(
      tokens,
      denormalizedWeights,
      minimumBalances
    );
    emit PoolReindexed(poolAddress);
  }

  /**
   * @dev Reweighs the assets in a pool by market cap and sets the
   * desired new weights, which will be adjusted over time.
   */
  function reweighPool(address poolAddress) external {
    IndexPoolMeta memory meta = _poolMeta[poolAddress];
    require(meta.initialized, "ERR_POOL_NOT_FOUND");

    require(
      now - meta.lastReweigh >= POOL_REWEIGH_DELAY,
      "ERR_POOL_REWEIGH_DELAY"
    );

    require(
      (++meta.reweighIndex % (REWEIGHS_BEFORE_REINDEX + 1)) != 0,
      "ERR_REWEIGH_INDEX"
    );

    address[] memory tokens = IIndexPool(poolAddress).getCurrentDesiredTokens();
    PriceLibrary.TwoWayAveragePrice[] memory prices = oracle.computeTwoWayAveragePrices(
      tokens,
      LONG_TWAP_MIN_TIME_ELAPSED,
      LONG_TWAP_MAX_TIME_ELAPSED
    );
    FixedPoint.uq112x112[] memory weights = MCapSqrtLibrary.computeTokenWeights(tokens, prices);
    uint96[] memory denormalizedWeights = new uint96[](tokens.length);

    for (uint256 i = 0; i < tokens.length; i++) {
      denormalizedWeights[i] = _denormalizeFractionalWeight(weights[i]);
    }

    meta.lastReweigh = uint64(now);
    _poolMeta[poolAddress] = meta;
    IIndexPool(poolAddress).reweighTokens(tokens, denormalizedWeights);
    emit PoolReweighed(poolAddress);
  }

/* ==========  Pool Queries  ========== */

  /**
   * @dev Compute the create2 address for a pool initializer.
   */
  function computeInitializerAddress(address poolAddress)
    public
    view
    returns (address initializerAddress)
  {
    initializerAddress = SaltyLib.computeProxyAddressManyToOne(
      address(_proxyManager),
      address(this),
      INITIALIZER_IMPLEMENTATION_ID,
      keccak256(abi.encodePacked(poolAddress))
    );
  }

  /**
   * @dev Compute the create2 address for a pool's unbound token seller.
   */
  function computeSellerAddress(address poolAddress)
    public
    view
    returns (address sellerAddress)
  {
    sellerAddress = SaltyLib.computeProxyAddressManyToOne(
      address(_proxyManager),
      address(this),
      SELLER_IMPLEMENTATION_ID,
      keccak256(abi.encodePacked(poolAddress))
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
    poolAddress = SaltyLib.computeProxyAddressManyToOne(
      address(_proxyManager),
      address(_factory),
      POOL_IMPLEMENTATION_ID,
      keccak256(abi.encodePacked(
        address(this),
        keccak256(abi.encodePacked(categoryID, indexSize))
      ))
    );
  }

  /**
   * @dev Returns the IndexPoolMeta struct for `poolAddress`.
   */
  function getPoolMeta(address poolAddress) external view returns (IndexPoolMeta memory meta) {
    meta = _poolMeta[poolAddress];
    require(meta.indexSize > 0, "ERR_POOL_NOT_FOUND");
  }

  /**
   * @dev Queries the top `indexSize` tokens in a category from the market oracle,
   * computes their relative weights by market cap square root and determines
   * the weighted balance of each token to meet a specified total value.
   */
  function getInitialTokensAndBalances(
    uint256 categoryID,
    uint256 indexSize,
    uint144 wethValue
  )
    public
    view
    returns (
      address[] memory tokens,
      uint256[] memory balances
    )
  {
    tokens = getTopCategoryTokens(categoryID, indexSize);
    PriceLibrary.TwoWayAveragePrice[] memory prices = oracle.computeTwoWayAveragePrices(
      tokens,
      LONG_TWAP_MIN_TIME_ELAPSED,
      LONG_TWAP_MAX_TIME_ELAPSED
    );
    FixedPoint.uq112x112[] memory weights = MCapSqrtLibrary.computeTokenWeights(tokens, prices);
    balances = new uint256[](indexSize);
    for (uint256 i = 0; i < indexSize; i++) {
      uint256 targetBalance = MCapSqrtLibrary.computeWeightedBalance(wethValue, weights[i], prices[i]);
      require(targetBalance >= MIN_BALANCE, "ERR_MIN_BALANCE");
      balances[i] = targetBalance;
    }
  }

/* ==========  Internal Pool Utility Functions  ========== */

  /**
   * @dev Estimate the total value of a pool by taking the sum of
   * TWAP values of the pool's balance in each token it has bound.
   */
  function _estimatePoolValue(IIndexPool pool) internal view returns (uint256 totalValue) {
    address[] memory tokens = pool.getCurrentTokens();
    uint256 len = tokens.length;
    uint256[] memory balances = new uint256[](len);
    for (uint256 i; i < len; i++) balances[i] = IERC20(tokens[i]).balanceOf(address(pool));
    uint144[] memory ethValues = oracle.computeAverageEthForTokens(
      tokens,
      balances,
      SHORT_TWAP_MIN_TIME_ELAPSED,
      SHORT_TWAP_MAX_TIME_ELAPSED
    );
    // Safe math is not needed because we are taking the sum of an array of uint144s as a uint256.
    for (uint256 i; i < len; i++) totalValue += ethValues[i];
  }

/* ==========  General Utility Functions  ========== */

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
}