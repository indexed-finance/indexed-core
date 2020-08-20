pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { BPool } from "./balancer/BPool.sol";
import "./interfaces/IERC20.sol";
import "./lib/FixedPoint.sol";
import "./lib/ProxyLib.sol";
import { IndexLibrary as Index } from "./lib/IndexLibrary.sol";
import { MarketOracle } from "./MarketOracle.sol";


contract PoolController {
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;

  uint256 public constant MIN_POOL_SIZE = 2;
  uint256 public constant MAX_POOL_SIZE = 8;
  uint256 public constant BONE = 10**18;
  uint256 public constant WEIGHT_MULTIPLIER = BONE * 25;
  uint256 public constant POOL_REWEIGH_DELAY = 7 days;

  event LOG_NEW_POOL(address indexed caller, address indexed pool, uint256 categoryID, uint256 indexSize);
  event LOG_BLABS(address indexed caller, address indexed blabs);

  address internal _poolContract;
  mapping(address => bool) internal _isBPool;

  mapping(address => uint256) public lastPoolReweighs;
  MarketOracle public oracle;

  constructor (address _oracle) public {
    oracle = MarketOracle(_oracle);
    _poolContract = address(new BPool());
  }

  function isBPool(address b) external view returns (bool) {
    return _isBPool[b];
  }

  function shouldPoolReweigh(address pool) public view returns (bool) {
    return now - lastPoolReweighs[pool] >= POOL_REWEIGH_DELAY;
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

  /**
   * @dev Deploy a new indexed pool with the category ID and index size.
   * TODO: Currently this just assumes that the pool controller already owns the tokens.
   * This should be updated to gradually purchase tokens from UniSwap.
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
  ) external {
    require(indexSize >= MIN_POOL_SIZE, "Less than minimum index size.");
    require(indexSize <= MAX_POOL_SIZE, "Exceeds maximum index size");
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
    ) = getInitialTokenWeightsAndBalances(categoryID, indexSize, initialStablecoinValue);
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

  // function reIndexPool(
  //   uint256 categoryID,
  //   uint256 indexSize
  // )
  //   public
  //   view
  //   returns (
  //     address[] memory tokens,
  //     uint96[] memory denormalizedWeights,
  //     uint256[] memory balances
  //   )
  // {
  //   tokens = oracle.getTopCategoryTokens(categoryID, indexSize);
  //   address poolAddress = computePoolAddress(categoryID, indexSize);
  //   FixedPoint.uq112x112[] memory prices = oracle.computeAveragePrices(tokens);
  //   FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
  //   balances = new uint256[](indexSize);
    
  // }

  /**
   * @dev Reweighs the assets in a pool by market cap and sets the
   * desired new weights, which will be adjusted over time.
   */
  function reweighPool(address poolAddress) external {
    require(_isBPool[poolAddress], "ERR_NOT_POOL");
    require(shouldPoolReweigh(poolAddress), "ERR_POOL_REWEIGH_DELAY");
    address[] memory tokens = BPool(poolAddress).getCurrentTokens();
    FixedPoint.uq112x112[] memory prices = oracle.computeAveragePrices(tokens);
    FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
    uint96[] memory denormalizedWeights = new uint96[](tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      denormalizedWeights[i] = denormalizeFractionalWeight(weights[i]);
    }
    BPool(poolAddress).reweighTokens(tokens, denormalizedWeights);
    lastPoolReweighs[poolAddress] = now;
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
}