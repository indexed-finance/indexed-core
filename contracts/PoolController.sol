pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./balancer/BFactory.sol";
import { BPool } from "./balancer/BPool.sol";
import "./lib/FixedPoint.sol";
import { IndexLibrary as Index } from "./lib/IndexLibrary.sol";
import { MarketOracle } from "./MarketOracle.sol";


contract PoolController is BFactory {
  uint256 public constant MIN_POOL_SIZE = 2;
  uint256 public constant MAX_POOL_SIZE = 8;
  uint256 public constant BONE = 10**18;
  uint256 public constant MAX_WEIGHT = BONE * 50;

  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;

  uint256 public constant WEIGHT_UPDATE_PERIOD = 7 days;
  mapping(address => uint256) public lastPoolReweighs;
  MarketOracle public oracle;

  constructor (address _oracle) public BFactory() {
    oracle = MarketOracle(_oracle);
  }

  function shouldPoolReweigh(address pool) public view returns (bool) {
    return now - lastPoolReweighs[pool] >= WEIGHT_UPDATE_PERIOD;
  }

  function computePoolAddress(uint256 categoryID, uint256 indexSize)
    external
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
   * @param categoryID Identifier for the indexed category
   * @param indexSize Number of tokens to hold in the index fund
   * @param name Name of the index token - should indicate the category and size
   * @param symbol Symbol for the index token
   */
  function deployIndexPool(
    uint256 categoryID,
    uint256 indexSize,
    string calldata name,
    string calldata symbol
  ) external {
    require(indexSize >= MIN_POOL_SIZE, "Less than minimum index size.");
    require(indexSize <= MAX_POOL_SIZE, "Exceeds maximum index size");
    require(oracle.hasCategory(categoryID), "Category does not exist");
    BPool bpool = _newBPool(categoryID, indexSize);
    bpool.initialize(
      address(this),
      name,
      symbol
    );
  }

  /**
   * @dev Initialize a pool with tokens, balances and weights.
   * TODO: Currently this just assumes that the pool controller already owns the tokens.
   * This should be updated to gradually purchase tokens from UniSwap.
   * Note: The call to the pool will throw if it is already initialized, so we don't check
   * in the controller to save gas.
   */
  function initializePool(
    uint256 categoryID,
    uint256 indexSize,
    uint256 initialStablecoinValue
  ) external {
    bytes32 salt = keccak256(abi.encodePacked(categoryID, indexSize));
    address poolAddress = ProxyLib.computeProxyAddress(
      _poolContract,
      salt
    );
    require(_isBPool[poolAddress], "Pool does not exist");
    (
      address[] memory tokens,
      uint96[] memory denormalizedWeights,
      uint256[] memory balances
    ) = getInitialTokenWeightsAndBalances(categoryID, indexSize, initialStablecoinValue);
    for (uint256 i = 0; i < indexSize; i++) {
      IERC20(tokens[i]).approve(poolAddress, balances[i]);
    }
    BPool(poolAddress).bindInitialTokens(tokens, balances, denormalizedWeights);
  }

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

  // /**
  //  * TODO Implement functionality to replace the indexed tokens.
  //  */
  // function updatePoolWeights(address poolAddress) external {
  //   require(shouldPoolReweigh(poolAddress), "ERR_POOL_NOT_READY");
  //   lastPoolReweighs[poolAddress] = now;
  //   BPool pool = BPool(poolAddress);
  //   (address[] memory tokens) = pool.getCurrentTokens();
  //   FixedPoint.uq112x112[] memory prices = oracle.computeAveragePrices(tokens);
  //   FixedPoint.uq112x112[] memory weights = Index.computeTokenWeights(tokens, prices);
  //   uint96[] memory denormalizedWeights = new uint96[](tokens.length);
  //   for (uint256 i = 0; i < denormalizedWeights.length; i++) {
  //     denormalizedWeights[i] = denormalizeFractionalWeight(weights[i]);
  //   }
  // }

  /**
   * @dev Converts a fixed point fraction to a denormalized weight.
   * Multiply the fraction by the max weight and decode to an unsigned integer.
   */
  function denormalizeFractionalWeight(FixedPoint.uq112x112 memory fraction)
    internal
    pure
    returns (uint96)
  {
    return uint96(fraction.mul(MAX_WEIGHT).decode144());
  }
}