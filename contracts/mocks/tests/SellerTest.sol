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
import { MockERC20, TestTokenMarkets } from "./util/TestTokenMarkets.sol";
import "./util/Diff.sol";
import "./util/TestOrder.sol";
import { UnboundTokenSeller, IPool } from "../../UnboundTokenSeller.sol";
import { MockUnbindSourcePool } from "../MockUnbindSourcePool.sol";
import { UniswapV2Library } from "../../lib/UniswapV2Library.sol";


contract SellerTest is TestTokenMarkets, Diff, TestOrder {
  UnboundTokenSeller public seller;
  UniSwapV2PriceOracle public shortOracle;
  MockUnbindSourcePool public pool;

  constructor(
    MockERC20 _weth,
    IUniswapV2Factory _factory,
    IUniswapV2Router02 _router,
    UniSwapV2PriceOracle _shortOracle
  )
    public
    TestTokenMarkets(_weth, _factory, _router)
  {
    shortOracle = _shortOracle;
    seller = new UnboundTokenSeller(_router, _shortOracle, address(this));
    pool = new MockUnbindSourcePool(address(seller));
    seller.initialize(IPool(address(pool)), 2);
  }

  function init() public {
    _deployTokens();
  }

  function init2() public {
    _deployMarkets();
  }

  function init3() public {
    shortOracle.updatePrices(tokensOrderedByPrice());
    pool.addToken(address(token1), 1.5e18, 5e21 / price1);
    pool.addToken(address(token2), 1.5e18, 5e21 / price2);
    pool.addToken(address(token3), 1.5e18, 5e21 / price3);
    pool.addToken(address(token4), 1.5e18, 5e21 / price4);
    pool.addToken(address(token5), 1.5e18, 5e21 / price5);
  }

  function test_setPremiumPercent() external {
    try seller.setPremiumPercent(0) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_PREMIUM"),
        "Error: Expected ERR_PREMIUM error message."
      );
    }
    try seller.setPremiumPercent(20) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_PREMIUM"),
        "Error: Expected ERR_PREMIUM error message."
      );
    }
    seller.setPremiumPercent(2);
    require(seller.getPremiumPercent() == 2, "Error: Unexpected premium returned.");
  }

  function test_handleUnbindToken() external {
    try seller.handleUnbindToken(address(token1), 1e18) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_ONLY_POOL"),
        "Error: Expected ERR_ONLY_POOL error message."
      );
    }
    pool.unbind(address(token1));
    require(
      token1.balanceOf(address(seller)) == 5e21 / price1,
      "Error: tokens not transferred to pool."
    );
  }

  function test_calcOutGivenIn() external view {
    uint256 amountIn = 1e18;
    uint256 wethValue = (amountIn * price2 * 100) / 98;
    uint256 expectedTokenOutput = wethValue / price1;
    uint256 actualTokenOutput = seller.calcOutGivenIn(
      address(token2),
      address(token1),
      amountIn
    );
    testDiff(
      expectedTokenOutput,
      actualTokenOutput,
      "Error: Seller gave unexpected output value."
    );
  }

  function test_calcInGivenOut() external view {
    uint256 amountOut = 1e18;
    uint256 valueOut = (amountOut * price1 * 98) / 100;
    uint256 expectedTokenInput = valueOut / price2;
    uint256 actualTokenInput = seller.calcInGivenOut(
      address(token2),
      address(token1),
      amountOut
    );
    testDiff(
      expectedTokenInput,
      actualTokenInput,
      "Error: Seller gave unexpected input value."
    );
  }

  function test_swapExactTokensForTokens() external {
    uint256 amountIn = 1e17;
    uint256 wethValue = (amountIn * price2 * 100) / 98;
    uint256 expectedTokenOutput = wethValue / price1;
  
    try seller.swapExactTokensForTokens(
      address(token2),
      address(token1),
      amountIn,
      expectedTokenOutput + 1
    ) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_MIN_AMOUNT_OUT"),
        "Error: Expected ERR_MIN_AMOUNT_OUT error message."
      );
    }
    token2.getFreeTokens(address(this), amountIn);
    token2.approve(address(seller), amountIn);
    uint256 poolBalance1 = pool.getBalance(address(token2));
    uint256 amountOut = seller.swapExactTokensForTokens(
      address(token2),
      address(token1),
      amountIn,
      expectedTokenOutput
    );
    require(
      amountOut == expectedTokenOutput,
      "Error: Received unexpected token output."
    );
    uint256 poolBalance2 = pool.getBalance(address(token2));
    require(
      poolBalance1 + amountIn == poolBalance2,
      "Error: Pool did not gulp tokens."
    );
  }

  function test_swapTokensForExactTokens() external {
    uint256 amountOut = 1e17;
    uint256 valueOut = (amountOut * price1 * 98) / 100;
    uint256 expectedTokenInput = valueOut / price2;
  
    try seller.swapTokensForExactTokens(
      address(token2),
      address(token1),
      amountOut,
      expectedTokenInput - 1
    ) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_MAX_AMOUNT_IN"),
        "Error: Expected ERR_MAX_AMOUNT_IN error message."
      );
    }
    token2.getFreeTokens(address(this), expectedTokenInput);
    token2.approve(address(seller), expectedTokenInput);
    uint256 poolBalance1 = pool.getBalance(address(token2));
    uint256 amountIn = seller.swapTokensForExactTokens(
      address(token2),
      address(token1),
      amountOut,
      expectedTokenInput
    );
    require(
      amountIn == expectedTokenInput,
      "Error: Paid an unexpected amount."
    );
    uint256 poolBalance2 = pool.getBalance(address(token2));
    require(
      poolBalance1 + amountIn == poolBalance2,
      "Error: Pool did not gulp tokens."
    );
  }

  function test_executeSwapTokensForExactTokens() external {
    uint256 amountOut = 1e17;
    uint256 maxValueIn = (amountOut * price2 * 100) / 98;
    uint256 maxAmountIn = maxValueIn / price1;
    uint256 expectedWethSwap2 = UniswapV2Library.getAmountIn(amountOut, 1e20 * price2, 1e20);
    uint256 expectedAmountIn = UniswapV2Library.getAmountIn(expectedWethSwap2, 1e20, 1e20 * price1);
    uint256 expectedPremium = maxAmountIn - expectedAmountIn;

    address[] memory path = new address[](3);
    path[0] = address(token1);
    path[1] = address(weth);
    path[2] = address(token2);
    uint256 poolBalance1 = pool.getBalance(address(token2));
    uint256 premium = seller.executeSwapTokensForExactTokens(
      address(token1),
      address(token2),
      amountOut,
      path
    );
    uint256 poolBalance2 = pool.getBalance(address(token2));
    require(
      poolBalance1 + amountOut == poolBalance2,
      "Error: Pool did not gulp tokens."
    );
    require(expectedPremium == premium, "Error: Unexpected premium.");
  }

  function test_executeSwapExactTokensForTokens() external {
    // Relatively small amount to avoid needing to calculate uniswap slippage for
    // expected premium
    uint256 amountIn = 1e17;
    uint256 minValueOut = (amountIn * price1 * 98) / 100;
    uint256 minAmountOut = minValueOut / price2;
    uint256 expectedWethSwap1 = UniswapV2Library.getAmountOut(amountIn, 1e20, 1e20 * price1);
    uint256 expectedAmountOut = UniswapV2Library.getAmountOut(expectedWethSwap1, 1e20 * price2, 1e20);
    uint256 expectedPremium = expectedAmountOut - minAmountOut;

    address[] memory path = new address[](3);
    path[0] = address(token1);
    path[1] = address(weth);
    path[2] = address(token2);
    uint256 poolBalance1 = pool.getBalance(address(token2));
    uint256 premium = seller.executeSwapExactTokensForTokens(
      address(token1),
      address(token2),
      amountIn,
      path
    );
    uint256 poolBalance2 = pool.getBalance(address(token2));
    require(
      poolBalance1 + minAmountOut == poolBalance2,
      "Error: Pool did not gulp tokens."
    );
    require(expectedPremium == premium, "Error: Unexpected premium.");
  }
}