pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { BPool } from "./balancer/BPool.sol";
import "./balancer/BNum.sol";
import "./interfaces/IERC20.sol";
import "./lib/FixedPoint.sol";
import "./lib/Create2.sol";
import { IndexLibrary as Index } from "./lib/IndexLibrary.sol";
import { MarketOracle } from "./MarketOracle.sol";
import { RestrictedTokenBuyer } from "./RestrictedTokenBuyer.sol";
import "./openzeppelin/SafeERC20.sol";
import {
  DelegateCallProxyManager
} from "./proxies/DelegateCallProxyManager.sol";
import {
  DelegateCallProxyManyToOne
} from "./proxies/DelegateCallProxyManyToOne.sol";


contract PoolController is BNum {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;
  using SafeERC20 for IERC20;

/* ---  Constants  --- */
  bytes32 internal constant PROXY_CODEHASH = keccak256(
    type(DelegateCallProxyManyToOne).creationCode
  );
  bytes32 internal constant POOL_IMPLEMENTATION_ID = keccak256(
    "BPool.sol"
  );
  uint256 internal constant WEIGHT_MULTIPLIER = BONE * 25;
  // Seconds between reweigh/reindex calls.
  uint256 internal constant POOL_REWEIGH_DELAY = 14 days;
  // The number of reweighs which occur before a pool is re-indexed.
  uint256 internal constant REWEIGHS_BEFORE_REINDEX = 3;
  uint128 internal constant MAX_UINT_128 = 2**128 - 1;

  address internal immutable _owner;
  address internal immutable _weth;
  MarketOracle internal immutable _oracle;
  RestrictedTokenBuyer internal immutable _tokenBuyer;
  DelegateCallProxyManager internal immutable _proxyManager;

/* ---  Structs  --- */

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

  /**
   * @dev Data structure with the tokens & balances for a pool
   * which has not yet been deployed.
   */
  struct PendingPool {
    address[] tokens;
    uint128[] balances;
  }

/* ---  Events  --- */

  event LOG_NEW_POOL(
    address indexed pool,
    uint256 categoryID,
    uint256 indexSize
  );

  event LOG_POOL_PREPARATION(
    address indexed pool,
    uint256 categoryID,
    uint256 indexSize
  );

/* ---  Storage  --- */

  address internal _poolContract;
  mapping(address => bool) internal _isBPool;
  mapping(address => PoolUpdateRecord) internal _poolUpdateRecords;
  mapping(address => PendingPool) internal _pendingPools;

/* ---  Modifiers  --- */

  modifier _owner_ {
    require(msg.sender == _owner, "ERR_ONLY_OWNER");
    _;
  }

  constructor(
    address owner,
    MarketOracle oracle,
    DelegateCallProxyManager proxyManager,
    address weth,
    RestrictedTokenBuyer tokenBuyer
  ) public {
    _owner = owner;
    _oracle = oracle;
    _proxyManager = proxyManager;
    _weth = weth;
    _tokenBuyer = tokenBuyer;
  }

/* ---  Pool Deployment Actions  --- */

  /**
   * @dev Prepare an index pool for deployment.
   * Calculates the initial desired weights and balances for the pool,
   * then sends `initialWethValue` to the token buyer contract to purchase
   * the necessary tokens over time from UniSwap.
   */
  function prepareIndexPool(
    uint256 categoryID,
    uint256 indexSize,
    uint256 initialWethValue
  ) external _owner_ {
    require(indexSize >= MIN_BOUND_TOKENS, "ERR_MIN_BOUND_TOKENS");
    require(indexSize <= MAX_BOUND_TOKENS, "ERR_MAX_BOUND_TOKENS");
    address poolAddress = computePoolAddress(categoryID, indexSize);
    require(!_isBPool[poolAddress], "ERR_POOL_EXISTS");
    (
      address[] memory tokens,
      uint256[] memory balances
    ) = getInitialTokensAndBalances(
      categoryID,
      indexSize,
      initialWethValue
    );
    IERC20(_weth).transfer(
      address(_tokenBuyer),
      initialWethValue
    );
    _tokenBuyer.addDesiredTokens(tokens, balances);
    uint128[] memory smolBalances = new uint128[](indexSize);
    for (uint256 i = 0; i < indexSize; i++) {
      uint256 bal = balances[i];
      require(bal <= MAX_UINT_128, "ERR_MAX_UINT_128");
      smolBalances[i] = uint128(bal);
    }
    _pendingPools[poolAddress] = PendingPool(tokens, smolBalances);
    emit LOG_POOL_PREPARATION(
      poolAddress,
      categoryID,
      indexSize
    );
  }

  /**
   * @dev Deploy an index pool which has already been prepared with `prepareIndexPool`.
   * Withdraws the requisite balances from the token buyer contract and calculates
   * the weights based on the actual values of each token balance.
   *
   * @param categoryID Identifier for the indexed category
   * @param indexSize Number of tokens to hold in the index fund
   * @param name Name of the index token - should indicate the category and size
   * @param symbol Symbol for the index token
   */
  function deployPreparedIndexPool(
    uint256 categoryID,
    uint256 indexSize,
    string calldata name,
    string calldata symbol
  ) external {
    address poolAddress = computePoolAddress(categoryID, indexSize);
    PendingPool memory poolData = _pendingPools[poolAddress];
    require(poolData.tokens.length == indexSize, "ERR_POOL_DATA");
    uint256[] memory balances = _to256Array(poolData.balances);
    _tokenBuyer.withdraw(poolData.tokens, balances);
    uint96[] memory denormalizedWeights = new uint96[](indexSize);
    uint256[] memory ethValues = new uint256[](indexSize);
    uint256 valueSum;
    for (uint256 i = 0; i < indexSize; i++) {
      address token = poolData.tokens[i];
      uint256 balance = poolData.balances[i];
      uint256 value = _oracle.computeAverageAmountOut(
        token,
        balance
      );
      valueSum += value;
      ethValues[i] = value;
      IERC20(token).safeTransferFrom(msg.sender, address(this), balance);
      IERC20(token).safeApprove(poolAddress, balance);
    }
    for (uint256 i = 0; i < indexSize; i++) {
      denormalizedWeights[i] = _denormalizeFractionalWeight(
        FixedPoint.fraction(uint112(ethValues[i]), uint112(valueSum))
      );
    }
    _deployPool(categoryID, indexSize);
    _isBPool[poolAddress] = true;
    emit LOG_NEW_POOL(poolAddress, categoryID, indexSize);
    BPool(poolAddress).initialize(
      address(this),
      name,
      symbol,
      poolData.tokens,
      balances,
      denormalizedWeights
    );
  }

    /**
   * @dev Deploy a new index pool using tokens transferred from the caller.
   *
   * Note: The caller must have approved the pool controller to transfer
   * the underlying tokens. The tokens and balances can be queried with
   * `getInitialTokenWeightsAndBalances`, but the exact token amounts
   * may change slightly between the query and the call to this function.
   * The caller should either query those amounts and call this function
   * in the same transaction or increase the queried values by a few percent.
   *
   * @param categoryID Identifier for the indexed category
   * @param indexSize Number of tokens to hold in the index fund
   * @param name Name of the index token - should indicate the category and size
   * @param symbol Symbol for the index token
   * @param initialWethValue Total initial value of the pool
   */
  function deployIndexPool(
    uint256 categoryID,
    uint256 indexSize,
    string calldata name,
    string calldata symbol,
    uint256 initialWethValue
  ) external _owner_ {
    require(indexSize >= MIN_BOUND_TOKENS, "ERR_MIN_BOUND_TOKENS");
    require(indexSize <= MAX_BOUND_TOKENS, "ERR_MAX_BOUND_TOKENS");
    address bpoolAddress = _deployPool(categoryID, indexSize);
    _isBPool[bpoolAddress] = true;
    emit LOG_NEW_POOL(bpoolAddress, categoryID, indexSize);
    BPool bpool = BPool(bpoolAddress);
    (
      address[] memory tokens,
      uint96[] memory denormalizedWeights,
      uint256[] memory balances
    ) = getInitialTokenWeightsAndBalances(
      categoryID,
      indexSize,
      initialWethValue
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

/* ---  Pool Rebalance Actions  --- */

  /**
   * @dev Re-indexes a pool by setting the underlying assets to the top
   * tokens in its category by market cap.
   */
  function reindexPool(uint256 categoryID, uint256 indexSize) external {
    address poolAddress = computePoolAddress(categoryID, indexSize);
    require(_isBPool[poolAddress], "ERR_NOT_POOL");
    PoolUpdateRecord memory record = _poolUpdateRecords[poolAddress];
    require(
      now - record.timestamp >= POOL_REWEIGH_DELAY,
      "ERR_POOL_REWEIGH_DELAY"
    );
    require(
      (++record.index % (REWEIGHS_BEFORE_REINDEX + 1)) == 0,
      "ERR_REWEIGH_INDEX"
    );
    address[] memory tokens = _oracle.getTopCategoryTokens(categoryID, indexSize);
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
    uint256[] memory minimumBalances = new uint256[](indexSize);
    uint96[] memory denormalizedWeights = new uint96[](indexSize);
    uint144 totalValue = _estimatePoolValue(BPool(poolAddress));
    for (uint256 i = 0; i < indexSize; i++) {
      // The minimum balance is the number of tokens worth
      // the minimum weight of the pool. The minimum weight
      // is 1/25, so we divide the total value by 25.
      minimumBalances[i] = prices[i].reciprocal().mul(
        totalValue
      ).decode144() / 25;
      denormalizedWeights[i] = _denormalizeFractionalWeight(weights[i]);
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
      now - record.timestamp >= POOL_REWEIGH_DELAY,
      "ERR_POOL_REWEIGH_DELAY"
    );
    require(
      (++record.index % (REWEIGHS_BEFORE_REINDEX + 1)) != 0,
      "ERR_REWEIGH_INDEX"
    );
    address[] memory tokens = BPool(poolAddress).getCurrentDesiredTokens();
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
    uint96[] memory denormalizedWeights = new uint96[](tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      denormalizedWeights[i] = _denormalizeFractionalWeight(weights[i]);
    }
    BPool(poolAddress).reweighTokens(tokens, denormalizedWeights);
    record.timestamp = uint128(now);
    _poolUpdateRecords[poolAddress] = record;
  }

/* ---  Token Buyer Controls  --- */

  function setPremiumRate(uint8 premiumPercent) external _owner_ {
    _tokenBuyer.setPremiumRate(premiumPercent);
  }

/* ---  Queries  --- */

  /**
   * @dev Checks if an address is a bpool.
   */
  function isBPool(address b) external view returns (bool) {
    return _isBPool[b];
  }

  /**
   * @dev Compute the create2 address for a pool.
   */
  function computePoolAddress(uint256 categoryID, uint256 indexSize)
    public
    view
    returns (address poolAddress)
  {
    bytes32 salt = keccak256(abi.encodePacked(
      POOL_IMPLEMENTATION_ID, categoryID, indexSize
    ));
    poolAddress = Create2.computeAddress(
      salt, PROXY_CODEHASH, address(_proxyManager)
    );
  }

  /**
   * @dev Gets a pool's update record.
   */
  function getPoolUpdateRecord(address poolAddress)
    external
    view
    returns (PoolUpdateRecord memory)
  {
    return _poolUpdateRecords[poolAddress];
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
    tokens = _oracle.getTopCategoryTokens(categoryID, indexSize);
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
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
    tokens = _oracle.getTopCategoryTokens(categoryID, indexSize);
    FixedPoint.uq112x112[] memory prices = _oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
    balances = new uint256[](indexSize);
    for (uint256 i = 0; i < indexSize; i++) {
      uint144 weightedValue = weights[i].mul(wethValue).decode144();
      balances[i] = uint256(prices[i].reciprocal().mul(weightedValue).decode144());
    }
  }

/* ---  Internal Pool Functions  --- */

  /**
   * @dev Estimate the total value of a pool by taking its first token's
   * "virtual balance" (balance * (totalWeight/weight)) and multiplying
   * by that token's average ether price from UniSwap.
   */
  function _estimatePoolValue(BPool pool) internal view returns (uint144) {
    (address token, uint256 value) = pool.extrapolatePoolValueFromToken();
    FixedPoint.uq112x112 memory price = _oracle.computeAveragePrice(token);
    return price.mul(value).decode144();
  }

  /**
   * @dev Deploy an index pool through the proxy manager.
   */
  function _deployPool(uint256 categoryID, uint256 indexSize)
    internal
    returns (address pool)
  {
    bytes32 salt = keccak256(abi.encodePacked(
      POOL_IMPLEMENTATION_ID, categoryID, indexSize
    ));
    return _proxyManager.deployProxyManyToOne(
      POOL_IMPLEMENTATION_ID,
      salt
    );
  }

/* ---  Internal Utility Functions  --- */

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
    assembly {
      outArr := arr
    }
  }

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