pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

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
import {
  MarketCapSqrtController,
  PoolInitializer,
  IPool,
  UnboundTokenSeller
} from "../../MarketCapSqrtController.sol";
import { MockERC20, TestTokenMarkets } from "./util/TestTokenMarkets.sol";
import "./util/Diff.sol";
import "./util/TestOrder.sol";
import "../../lib/Babylonian.sol";


contract ControllerTest is TestTokenMarkets, Diff, TestOrder {
  MarketCapSqrtController public controller;
  PoolInitializer internal _initializer;
  UniSwapV2PriceOracle internal _shortOracle;
  IPool internal _pool;
  using Babylonian for uint;

  constructor(
    MockERC20 _weth,
    IUniswapV2Factory _factory,
    IUniswapV2Router02 _router,
    MarketCapSqrtController _controller,
    UniSwapV2PriceOracle _shortTermOracle
  ) public TestTokenMarkets(_weth, _factory, _router) {
    controller = _controller;
    _shortOracle = _shortTermOracle;
  }

  function init() public {
    _deployTokens();
  }

  function init2() public {
    _deployMarkets();
  }

  function init3() public markTime {
    controller.createCategory(keccak256("Category 1"));
    address[] memory tokens = new address[](5);
    tokens[0] = address(token1);
    tokens[1] = address(token2);
    tokens[2] = address(token3);
    tokens[3] = address(token4);
    tokens[4] = address(token5);

    controller.addTokens(1, tokens);
  }

  function init4() public testIndex(0) forceDelay(2 days) {
    _addLiquidityAll();
    address[] memory sortedTokens = tokensOrderedByPrice();
    controller.orderCategoryTokensByMarketCap(1, sortedTokens);
    _shortOracle.updatePrices(tokensOrderedByPrice());
  }

  function _getExpectedTokensAndBalances(uint256 wethValue)
    internal
    view
    returns (
      address[] memory expectedTokens,
      uint256[] memory expectedBalances
    )
  {
    expectedTokens = tokensOrderedByPrice();
    uint256[] memory marketCaps = marketCapsOrderedByPrice(_liquidityAll);
    uint256[] memory prices = orderedPrices();
    expectedBalances = new uint256[](5);
    uint256 mcapSqrtSum = 0;
    for (uint256 i = 0; i < 5; i++) {
      uint256 mcapSqrt = marketCaps[i].sqrt();
      mcapSqrtSum += mcapSqrt;
    }
    for (uint256 i = 0; i < 5; i++) {
      uint256 mcapSqrt = marketCaps[i].sqrt();
      uint256 expectedValue = (wethValue * mcapSqrt) / mcapSqrtSum;
      expectedBalances[i] = expectedValue / prices[i];
    }
  }

  function test_getInitialTokensAndBalances() external testIndex(1) {
    uint256 wethValue = 5e18;
    (
      address[] memory expectedTokens,
      uint256[] memory expectedBalances
    ) = _getExpectedTokensAndBalances(wethValue);
    (
      address[] memory actualTokens,
      uint256[] memory actualBalances
    ) = controller.getInitialTokensAndBalances(1, 5, uint144(wethValue));
    testArrayDeepEq(
      expectedTokens,
      actualTokens,
      "Error: Function returned wrong tokens for category."
    );
    testUintArrayDiff(
      expectedBalances,
      actualBalances,
      "Error: Function returned wrong balances for tokens."
    );
  }

  function test_prepareIndexPool() external testIndex(2) forceDelay(1 hours) {
    uint256 wethValue = 5e18;
    (
      address poolAddress,
      address initializerAddress
    ) = controller.prepareIndexPool(
      1,
      5,
      wethValue,
      "TestPool",
      "TPI"
    );
    require(
      poolAddress == controller.computePoolAddress(1, 5),
      "Error: Unexpected pool address"
    );
    require(
      initializerAddress == controller.computeInitializerAddress(poolAddress),
      "Error: Unexpected initializer address."
    );
    _initializer = PoolInitializer(initializerAddress);
    _pool = IPool(poolAddress);
    (
      address[] memory expectedTokens,
      uint256[] memory expectedBalances
    ) = _getExpectedTokensAndBalances(wethValue);
    address[] memory actualTokens = _initializer.getDesiredTokens();
    uint256[] memory actualBalances = _initializer.getDesiredAmounts(actualTokens);
    testArrayDeepEq(
      expectedTokens,
      actualTokens,
      "Error: Pool initializer had unexpected tokens."
    );
    testUintArrayDiff(
      expectedBalances,
      actualBalances,
      "Error: Pool initializer had unexpected target values."
    );
  }

  function test_finishPreparedIndexPool() external testIndex(3) {
    address[] memory tokens = tokensOrderedByPrice();
    uint256[] memory amounts = _initializer.getDesiredAmounts(tokens);
    for (uint256 i = 0; i < 5; i++) {
      MockERC20(tokens[i]).getFreeTokens(address(this), amounts[i]);
      MockERC20(tokens[i]).approve(address(_initializer), amounts[i]);
    }
    _initializer.contributeTokens(tokens, amounts, 0);
    require(
      _initializer.getCreditOf(address(this)) == _initializer.getTotalCredit(),
      "Error: Caller did not receive all credit."
    );
    _initializer.finish();
    _initializer.claimTokens();
    require(
      _initializer.getCreditOf(address(this)) == 0,
      "Error: Caller's credit not zero after claim."
    );
    uint256 balance = _pool.balanceOf(address(this));
    require(balance == 1e20, "Error: Initializer did not give 100 pool tokens.");
  }

  function test_setMaxPoolTokens() external testIndex(4) {
    uint256 max = 1e21; 
    controller.setMaxPoolTokens(address(_pool), max);
    require(
      _pool.getMaxPoolTokens() == max,
      "Error: maxPoolTokens not set."
    );
  }

  function test_setDefaultSellerPremium() external testIndex(5) {
    try controller.setDefaultSellerPremium(0) {
      revert("Expected Error");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_PREMIUM"),
        "Error: Expected ERR_PREMIUM error message."
      );
    }

    try controller.setDefaultSellerPremium(20) {
      revert("Expected Error");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_PREMIUM"),
        "Error: Expected ERR_PREMIUM error message."
      );
    }

    controller.setDefaultSellerPremium(1);
    uint256 premium = controller.defaultSellerPremium();
    require(premium == 1, "Error: default premium not set.");
  }

  function test_updateSellerPremiumToDefault() external testIndex(6) {
    address sellerAddress = controller.computeSellerAddress(address(_pool));
    controller.updateSellerPremiumToDefault(sellerAddress);
    require(
      UnboundTokenSeller(sellerAddress).getPremiumPercent() == 1,
      "Error: Token seller premium not set."
    );
  }

  function test_setSwapFee() external testIndex(7) {
    try controller.setSwapFee(address(_pool), 1e17 + 1) {
      revert("Expected setSwapFee to revert.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_MAX_FEE"),
        "Error: Expected ERR_MAX_FEE error message."
      );
    }
    try controller.setSwapFee(address(_pool), 1e12 - 1) {
      revert("Expected setSwapFee to revert.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_MIN_FEE"),
        "Error: Expected ERR_MIN_FEE error message."
      );
    }
    uint256 fee = 1e15;
    controller.setSwapFee(address(_pool), fee);
    require(
      _pool.getSwapFee() == fee,
      "Error: Swap fee not set on pool"
    );
  }
}