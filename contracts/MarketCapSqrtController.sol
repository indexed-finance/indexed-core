// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { IPool } from "./balancer/IPool.sol";
import { PriceLibrary as Prices } from "./lib/PriceLibrary.sol";
import "./lib/FixedPoint.sol";
import "./lib/Babylonian.sol";
import { MCapSqrtLibrary as MCapSqrt } from "./lib/MCapSqrtLibrary.sol";
import { PoolFactory } from "./PoolFactory.sol";
import { PoolInitializer } from "./PoolInitializer.sol";
import { UnboundTokenSeller } from "./UnboundTokenSeller.sol";
import { DelegateCallProxyManager } from "./proxies/DelegateCallProxyManager.sol";
import { SaltyLib as Salty } from "./proxies/SaltyLib.sol";
import {
  MarketCapSortedTokenCategories,
  UniSwapV2PriceOracle
} from "./MarketCapSortedTokenCategories.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";


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
 * Every 2 weeks, pools are either re-weighed or re-indexed.
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
  using Babylonian for uint144;
  using SafeMath for uint256;
  using Prices for Prices.TwoWayAveragePrice;

/* ---  Constants  --- */
  // Minimum number of tokens in an index.
  uint256 internal constant MIN_INDEX_SIZE = 2;

  // Maximum number of tokens in an index.
  uint256 internal constant MAX_INDEX_SIZE = 8;

  // Identifier for the pool initializer implementation on the proxy manager.
  bytes32 internal constant INITIALIZER_IMPLEMENTATION_ID = keccak256("PoolInitializer.sol");

  // Identifier for the unbound token seller implementation on the proxy manager.
  bytes32 internal constant SELLER_IMPLEMENTATION_ID = keccak256("UnboundTokenSeller.sol");

  // Identifier for the index pool implementation on the proxy manager.
  bytes32 internal constant POOL_IMPLEMENTATION_ID = keccak256("IPool.sol");

  // Default total weight for a pool.
  uint256 internal constant WEIGHT_MULTIPLIER = 25e18;

  // Time between reweigh/reindex calls.
  uint256 internal constant POOL_REWEIGH_DELAY = 2 weeks;

  // The number of reweighs which occur before a pool is re-indexed.
  uint256 internal constant REWEIGHS_BEFORE_REINDEX = 3;

  // Pool factory contract
  PoolFactory internal immutable _factory;

  // Proxy manager & factory
  DelegateCallProxyManager internal immutable _proxyManager;

/* ---  Events  --- */

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

  /** @dev Emitted when a pool using the default implementation is deployed. */
  event NewDefaultPool(
    address pool,
    address controller
  );

  /** @dev Emitted when a pool using a non-default implementation is deployed. */
  event NewNonDefaultPool(
    address pool,
    address controller,
    bytes32 implementationID
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

/* ---  Storage  --- */

  // Default slippage rate for token seller contracts.
  uint8 public defaultSellerPremium = 2;
  // Metadata about index pools
  mapping(address => IndexPoolMeta) internal _poolMeta;
  // Records of pool update statuses.
  mapping(address => PoolUpdateRecord) internal _poolUpdateRecords;

/* ---  Constructor  --- */

  /**
   * @dev Deploy the controller and configure the addresses
   * of the related contracts.
   */
  constructor(
    UniSwapV2PriceOracle oracle,
    address owner,
    PoolFactory factory,
    DelegateCallProxyManager proxyManager
  )
    public
    MarketCapSortedTokenCategories(oracle, owner)
  {
    _factory = factory;
    _proxyManager = proxyManager;
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
    _owner_
    returns (address poolAddress, address initializerAddress)
  {
    require(indexSize >= MIN_INDEX_SIZE, "ERR_MIN_INDEX_SIZE");
    require(indexSize <= MAX_INDEX_SIZE, "ERR_MAX_INDEX_SIZE");
    require(initialWethValue < uint144(-1), "ERR_MAX_UINT144");

    poolAddress = _factory.deployIndexPool(
      keccak256(abi.encodePacked(categoryID, indexSize)),
      name,
      symbol
    );

    _poolMeta[poolAddress] = IndexPoolMeta({
      categoryID: uint8(categoryID),
      indexSize: uint8(indexSize),
      initialized: false
    });

    initializerAddress = _proxyManager.deployProxyManyToOne(
      INITIALIZER_IMPLEMENTATION_ID,
      keccak256(abi.encodePacked(poolAddress))
    );

    PoolInitializer initializer = PoolInitializer(initializerAddress);

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
    uint144[] memory ethValues = oracle.computeAverageAmountsOut(
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
    address sellerAddress = _proxyManager.deployProxyManyToOne(
      SELLER_IMPLEMENTATION_ID,
      keccak256(abi.encodePacked(poolAddress))
    );
    IPool(poolAddress).initialize(
      tokens,
      balances,
      denormalizedWeights,
      msg.sender,
      sellerAddress
    );
    _poolMeta[poolAddress].initialized = true;
    emit PoolInitialized(
      poolAddress,
      sellerAddress,
      meta.categoryID,
      meta.indexSize
    );
    UnboundTokenSeller(sellerAddress).initialize(
      IPool(poolAddress),
      defaultSellerPremium
    );
  }

/* ---  Pool Management  --- */

  /**
   * @dev Sets the default premium rate for token seller contracts.
   */
  function setDefaultSellerPremium(
    uint8 _defaultSellerPremium
  ) external _owner_ {
    require(
      _defaultSellerPremium > 0 && _defaultSellerPremium < 20,
      "ERR_PREMIUM"
    );
    defaultSellerPremium = _defaultSellerPremium;
  }

  /**
   * @dev Update the premium rate on `sellerAddress` with the current
   * default rate.
   */
  function updateSellerPremiumToDefault(
    address sellerAddress
  ) external {
    UnboundTokenSeller(sellerAddress).setPremiumPercent(defaultSellerPremium);
  }

  /**
   * @dev Update the premium rate on each unbound token seller in
   * `sellerAddresses` with the current default rate.
   */
  function updateSellerPremiumToDefault(
    address[] calldata sellerAddresses
  ) external {
    for (uint256 i = 0; i < sellerAddresses.length; i++) {
      UnboundTokenSeller(
        sellerAddresses[i]
      ).setPremiumPercent(defaultSellerPremium);
    }
  }

  /**
   * @dev Sets the maximum number of pool tokens that can be minted
   * for a particular pool.
   *
   * This value will be used in the alpha to limit the maximum damage
   * that can be caused by a catastrophic error. It can be gradually
   * increased as the pool continues to not be exploited.
   *
   * If it is set to 0, the limit will be removed.
   *
   * @param poolAddress Address of the pool to set the limit on.
   * @param maxPoolTokens Maximum LP tokens the pool can mint.
   */
  function setMaxPoolTokens(
    address poolAddress,
    uint256 maxPoolTokens
  ) external _owner_ {
    IPool(poolAddress).setMaxPoolTokens(maxPoolTokens);
  }

  /**
   * @dev Sets the swap fee on an index pool.
   */
  function setSwapFee(address poolAddress, uint256 swapFee) external _owner_ {
    require(_havePool(poolAddress), "ERR_POOL_NOT_FOUND");
    IPool(poolAddress).setSwapFee(swapFee);
  }

  /**
   * @dev Updates the minimum balance of an uninitialized token, which is
   * useful when the token's price on the pool is too low relative to
   * external prices for people to trade it in.
   */
  function updateMinimumBalance(IPool pool, address tokenAddress) external {
    require(_havePool(address(pool)), "ERR_POOL_NOT_FOUND");
    IPool.Record memory record = pool.getTokenRecord(tokenAddress);
    require(!record.ready, "ERR_TOKEN_READY");
    uint256 poolValue = _estimatePoolValue(pool);
    Prices.TwoWayAveragePrice memory price = oracle.computeTwoWayAveragePrice(tokenAddress);
    uint256 minimumBalance = price.computeAverageTokensForEth(poolValue) / 100;
    pool.setMinimumBalance(tokenAddress, minimumBalance);
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
  
    Prices.TwoWayAveragePrice[] memory prices = oracle.computeTwoWayAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = MCapSqrt.computeTokenWeights(tokens, prices);

    uint256[] memory minimumBalances = new uint256[](size);
    uint96[] memory denormalizedWeights = new uint96[](size);
    uint144 totalValue = _estimatePoolValue(IPool(poolAddress));

    for (uint256 i = 0; i < size; i++) {
      // The minimum balance is the number of tokens worth the minimum weight
      // of the pool. The minimum weight is 1/100, so we divide the total value
      // by 100 to get the desired weth value, then multiply by the price of eth
      // in terms of that token to get the minimum balance.
      minimumBalances[i] = prices[i].computeAverageTokensForEth(totalValue) / 100;
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
    Prices.TwoWayAveragePrice[] memory prices = oracle.computeTwoWayAveragePrices(tokens);
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
    initializerAddress = Salty.computeProxyAddressManyToOne(
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
    sellerAddress = Salty.computeProxyAddressManyToOne(
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
    poolAddress = Salty.computeProxyAddressManyToOne(
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
    Prices.TwoWayAveragePrice[] memory prices = oracle.computeTwoWayAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = MCapSqrt.computeTokenWeights(tokens, prices);
    balances = new uint256[](indexSize);
    for (uint256 i = 0; i < indexSize; i++) {
      balances[i] = MCapSqrt.computeWeightedBalance(wethValue, weights[i], prices[i]);
    }
  }

/* ---  Internal Pool Utility Functions  --- */

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
    FixedPoint.uq112x112 memory price = oracle.computeAverageTokenPrice(token);
    return price.mul(value).decode144();
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