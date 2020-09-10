pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { BPool } from "./balancer/BPool.sol";
import "./balancer/BNum.sol";
import "./interfaces/IERC20.sol";
import "./lib/FixedPoint.sol";
import "./lib/ProxyLib.sol";
import { IndexLibrary as Index } from "./lib/IndexLibrary.sol";
import { MarketOracle } from "./MarketOracle.sol";


contract PoolController is BNum {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;

  uint256 internal constant WEIGHT_MULTIPLIER = BONE * 25;
  // Seconds between reweigh/reindex calls.
  uint256 internal constant POOL_REWEIGH_DELAY = 14 days;
  // The number of reweighs which occur before a pool is re-indexed.
  uint256 internal constant REWEIGHS_BEFORE_REINDEX = 3;

  struct PoolUpdateRecord {
    uint128 index;
    uint128 timestamp;
  }

  event LOG_NEW_POOL(
    address indexed caller,
    address indexed pool,
    uint256 categoryID,
    uint256 indexSize
  );

  event LOG_MANAGER(address manager);

  address internal _manager;
  address internal _poolContract;
  mapping(address => bool) internal _isBPool;
  mapping(address => PoolUpdateRecord) internal _poolUpdateRecords;
  MarketOracle public oracle;

  modifier onlyManager {
    require(msg.sender == _manager, "ERR_ONLY_MANAGER");
    _;
  }

  constructor(address _oracle, address poolContract) public {
    _manager = msg.sender;
    oracle = MarketOracle(_oracle);
    _poolContract = poolContract;
    emit LOG_MANAGER(msg.sender);
  }

  function setManager(address newManager) external onlyManager {
    require(newManager != address(0), "ERR_NULL_ADDRESS");
    _manager = newManager;
    emit LOG_MANAGER(newManager);
  }

/* ---  Pool Actions  --- */

  /**
   * @dev Deploy a new indexed pool with the category ID and index size.
   *
   * TODO: Currently this just assumes that the pool controller already owns the tokens.
   * This should probably be updated to gradually purchase tokens from UniSwap.
   *
   * @param categoryID Identifier for the indexed category
   * @param indexSize Number of tokens to hold in the index fund
   * @param name Name of the index token - should indicate the category and size
   * @param symbol Symbol for the index token
   * @param initialStablecoinValue Total initial value of the pool
   */
  function deployIndexPool(
    uint256 categoryID,
    uint256 indexSize,
    string calldata name,
    string calldata symbol,
    uint256 initialStablecoinValue
  ) external onlyManager {
    require(indexSize >= MIN_BOUND_TOKENS, "Less than minimum index size.");
    require(indexSize <= MAX_BOUND_TOKENS, "Exceeds maximum index size");
    require(oracle.hasCategory(categoryID), "Category does not exist");
    bytes32 salt = keccak256(abi.encodePacked(categoryID, indexSize));
    address bpoolAddress = ProxyLib.deployProxy(_poolContract, salt);
    _isBPool[bpoolAddress] = true;
    emit LOG_NEW_POOL(msg.sender, bpoolAddress, categoryID, indexSize);
    BPool bpool = BPool(bpoolAddress);
    (
      address[] memory tokens,
      uint96[] memory denormalizedWeights,
      uint256[] memory balances
    ) = getInitialTokenWeightsAndBalances(
      categoryID,
      indexSize,
      initialStablecoinValue
    );
    for (uint256 i = 0; i < indexSize; i++) {
      IERC20(tokens[i]).approve(bpoolAddress, balances[i]);
    }
    bpool.initialize(
      address(this),
      name,
      symbol,
      tokens,
      balances,
      denormalizedWeights
    );
  }

  /**
   * @dev Re-index a pool by setting the underlying assets to the top
   * tokens in its category by market cap.
   */
  function reindexPool(uint256 categoryID, uint256 indexSize) external {
    address poolAddress = computePoolAddress(categoryID, indexSize);
    require(_isBPool[poolAddress], "ERR_NOT_POOL");
    PoolUpdateRecord memory record = _poolUpdateRecords[poolAddress];
    require(
      (record.index++ % (REWEIGHS_BEFORE_REINDEX + 1)) == REWEIGHS_BEFORE_REINDEX,
      "ERR_REWEIGH_INDEX"
    );
    require(
      now - record.timestamp >= POOL_REWEIGH_DELAY,
      "ERR_POOL_REWEIGH_DELAY"
    );
    address[] memory tokens = oracle.getTopCategoryTokens(categoryID, indexSize);
    FixedPoint.uq112x112[] memory prices = oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
    uint256[] memory minimumBalances = new uint256[](indexSize);
    uint96[] memory denormalizedWeights = new uint96[](indexSize);
    uint144 totalValue = estimatePoolValue(BPool(poolAddress));
    for (uint256 i = 0; i < indexSize; i++) {
      // The minimum balance is the number of tokens worth
      // the minimum weight of the pool. The minimum weight
      // is 1/25, so we divide the total value by 25.
      minimumBalances[i] = prices[i].reciprocal().mul(
        totalValue / 25
      ).decode144();
      denormalizedWeights[i] = denormalizeFractionalWeight(weights[i]);
    }
    BPool(poolAddress).reindexTokens(tokens, denormalizedWeights, minimumBalances);
    record.timestamp = uint128(now);
    _poolUpdateRecords[poolAddress] = record;
  }

  /**
   * @dev Reweighs the assets in a pool by market cap and sets the
   * desired new weights, which will be adjusted over time.
   */
  function reweighPool(address poolAddress) external {
    require(_isBPool[poolAddress], "ERR_NOT_POOL");
    PoolUpdateRecord memory record = _poolUpdateRecords[poolAddress];
    require(
      (record.index++ % (REWEIGHS_BEFORE_REINDEX + 1)) != REWEIGHS_BEFORE_REINDEX,
      "ERR_REWEIGH_INDEX"
    );
    require(
      now - record.timestamp >= POOL_REWEIGH_DELAY,
      "ERR_POOL_REWEIGH_DELAY"
    );
    address[] memory tokens = BPool(poolAddress).getCurrentDesiredTokens();
    FixedPoint.uq112x112[] memory prices = oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
    uint96[] memory denormalizedWeights = new uint96[](tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      denormalizedWeights[i] = denormalizeFractionalWeight(weights[i]);
    }
    BPool(poolAddress).reweighTokens(tokens, denormalizedWeights);
    record.timestamp = uint128(now);
    _poolUpdateRecords[poolAddress] = record;
  }

/* ---  Queries  --- */
  function getManager() external view returns (address) {
    return _manager;
  }

  function isBPool(address b) external view returns (bool) {
    return _isBPool[b];
  }

  function computePoolAddress(uint256 categoryID, uint256 indexSize)
    public
    view
    returns (address)
  {
    bytes32 salt = keccak256(abi.encodePacked(categoryID, indexSize));
    return ProxyLib.computeProxyAddress(
      _poolContract,
      salt
    );
  }

  function getPoolUpdateRecord(address poolAddress)
    external
    view
    returns (PoolUpdateRecord memory)
  {
    return _poolUpdateRecords[poolAddress];
  }

  /**
   * @dev Queries the top n tokens in a category from the market oracle,
   * computes their relative weights by market cap square root and determines
   * the weighted balance of each token to meet a specified total value.
   */
  function getInitialTokenWeightsAndBalances(
    uint256 categoryID,
    uint256 indexSize,
    uint256 stablecoinValue
  )
    public
    view
    returns (
      address[] memory tokens,
      uint96[] memory denormalizedWeights,
      uint256[] memory balances
    )
  {
    tokens = oracle.getTopCategoryTokens(categoryID, indexSize);
    FixedPoint.uq112x112[] memory prices = oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
    balances = new uint256[](indexSize);
    denormalizedWeights = new uint96[](indexSize);
    for (uint256 i = 0; i < indexSize; i++) {
      uint144 weightedValue = weights[i].mul(stablecoinValue).decode144();
      balances[i] = uint256(prices[i].reciprocal().mul(weightedValue).decode144());
      denormalizedWeights[i] = denormalizeFractionalWeight(weights[i]);
    }
  }

  /**
   * @dev Converts a fixed point fraction to a denormalized weight.
   * Multiply the fraction by the max weight and decode to an unsigned integer.
   */
  function denormalizeFractionalWeight(FixedPoint.uq112x112 memory fraction)
    internal
    pure
    returns (uint96)
  {
    return uint96(fraction.mul(WEIGHT_MULTIPLIER).decode144());
  }

  /**
   * @dev Estimate the total value of a pool by taking its first token's
   * "virtual balance" (balance * (totalWeight/weight)) and multiplying
   * by that token's average ether price from UniSwap.
   */
  function estimatePoolValue(BPool pool) internal view returns (uint144) {
    (address token, uint256 value) = pool.getPoolValueByTokenIndex(0);
    FixedPoint.uq112x112 memory price = oracle.computeAveragePrice(token);
    return price.mul(value).decode144();
  }
}