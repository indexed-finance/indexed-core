pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../MockERC20.sol";
import {
  IUniswapV2Pair
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {
  IUniswapV2Factory
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import {
  IUniswapV2Router02
} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import { UniSwapV2PriceOracle } from "../../UniSwapV2PriceOracle.sol";
import "../../MarketCapSortedTokenCategories.sol";
import "./util/TestTokenMarkets.sol";
import "./util/Diff.sol";
import "./util/TestOrder.sol";
import { PriceLibrary as Prices } from "../../lib/PriceLibrary.sol";


contract CategoriesTest is TestTokenMarkets, Diff, TestOrder {
  MarketCapSortedTokenCategories public categories;

  constructor(
    MockERC20 _weth,
    IUniswapV2Factory _factory,
    IUniswapV2Router02 _router,
    MarketCapSortedTokenCategories _categories
  ) public TestTokenMarkets(_weth, _factory, _router) {
    categories = _categories;
  }

  function init() public {
    _deployTokens();
  }

  function init2() public {
    _deployMarkets();
  }

  function test_createCategory() public testIndex(0) {
    uint256 index = categories.categoryIndex();
    categories.createCategory(keccak256("Category 1"));
    require(
      categories.categoryIndex() == index+1,
      "Error: Category index does not match."
    );
    require(categories.hasCategory(index+1), "Error: hasCategory returned false");
  }

  function test_addToken() public testIndex(1) {
    address[] memory tokens = categories.getCategoryTokens(1);
    require(tokens.length == 0, "Error: already added tokens");
    categories.addToken(address(token1), 1);
    tokens = categories.getCategoryTokens(1);
    require(
      tokens.length == 1 && tokens[0] == address(token1),
      "Error: token not added"
    );
    UniSwapV2PriceOracle oracle = categories.oracle();
    Prices.PriceObservation memory observation = oracle.getPriceObservation(
      address(token1),
      oracle.observationIndexOf(block.timestamp)
    );
    require(
      observation.timestamp == uint32(block.timestamp),
      "Error: price observation not made when token added"
    );
  }

  function test_addTokens() public testIndex(2) markTime {
    address[] memory tokens = new address[](4);
    tokens[0] = address(token2);
    tokens[1] = address(token3);
    tokens[2] = address(token4);
    tokens[3] = address(token5);

    categories.addTokens(1, tokens);
    address[] memory curTokens = categories.getCategoryTokens(1);
    require(curTokens.length == 5, "Error: tokens not added");
    require(
      curTokens[0] == address(token1) &&
      curTokens[1] == address(token2) &&
      curTokens[2] == address(token3) &&
      curTokens[3] == address(token4) &&
      curTokens[4] == address(token5),
      "Error: token order incorrect"
    );
  }

  function test_orderCategoryTokensByMarketCap() public testIndex(3) forceDelay(2 days) {
    _addLiquidityAll();
    address[] memory sortedTokens = tokensOrderedByPrice();
    categories.orderCategoryTokensByMarketCap(1, sortedTokens);
    address[] memory curTokens = categories.getCategoryTokens(1);
    testArrayDeepEq(sortedTokens, curTokens, "Error: Sorted tokens not equal.");
    uint144[] memory actualCaps = categories.getCategoryMarketCaps(1);
    uint256[] memory expectedCaps = marketCapsOrderedByPrice(_liquidityAll);
    testUintArrayDiff(
      expectedCaps,
      _to256Array(actualCaps),
      "Error: getCategoryMarketCaps did not equal expected."
    );
  }

  function test_getTopCategoryTokens() public testIndex(4) {
    try categories.getTopCategoryTokens(0, 1) {
      revert("Error: Expected call to revert.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_CATEGORY_ID"),
        "Error: Expected ERR_CATEGORY_ID error message."
      );
    }
    try categories.getTopCategoryTokens(2, 1) {
      revert("Error: Expected call to revert.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_CATEGORY_ID"),
        "Error: Expected ERR_CATEGORY_ID error message."
      );
    }
    address[] memory sortedTokens = tokensOrderedByPrice();
    address[] memory curTokens = categories.getTopCategoryTokens(1, 5);
    testArrayDeepEq(sortedTokens, curTokens, "Error: Sorted tokens not equal.");
  }

  function test_computeAverageMarketCaps() public testIndex(5) {
    address[] memory sortedTokens = tokensOrderedByPrice();
    uint256[] memory expectedCaps = marketCapsOrderedByPrice(_liquidityAll);
    uint144[] memory actualCaps = categories.computeAverageMarketCaps(sortedTokens);
    testUintArrayDiff(
      expectedCaps,
      _to256Array(actualCaps),
      "Error: computeAverageMarketCaps did not equal expected."
    );
  }

  function returnOwnership() external {
    categories.setOwner(msg.sender);
  }
    
  /**
   * @dev Re-assigns a uint144 array to a uint256 array.
   * This does not affect memory allocation as all Solidity
   * uint arrays take 32 bytes per item.
   */
  function _to256Array(uint144[] memory arr)
    internal
    pure
    returns (uint256[] memory outArr)
  {
    assembly { outArr := arr }
  }
}