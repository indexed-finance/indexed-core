pragma solidity ^0.6.0;

import {
  IUniswapV2Pair
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {
  IUniswapV2Factory
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import {
  IUniswapV2Router02
} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import { UniSwapV2PriceOracle } from "../../../UniSwapV2PriceOracle.sol";
import "./TestTokens.sol";


contract TestTokenMarkets is TestTokens {
  MockERC20 public weth;
  IUniswapV2Factory public factory;
  IUniswapV2Router02 public router;

  uint256 internal _liquidityAll;

  bool internal _marketsReady;
  uint256 internal _deployIndex;

  modifier marketsReady {
    require(_marketsReady, "Error: markets not deployed.");
    _;
  }

  constructor(
    MockERC20 _weth,
    IUniswapV2Factory _factory,
    IUniswapV2Router02 _router
  ) public {
    weth = _weth;
    factory = _factory;
    router = _router;
  }

  function _deployMarkets() internal tokensReady {
    if (_deployIndex == 0) {
      _deployIndex++;
      _deployTokenWethMarketWithLiquidity(token1, 1e20, price1);
    } else if (_deployIndex == 1) {
      _deployIndex++;
      _deployTokenWethMarketWithLiquidity(token2, 1e20, price2);
    } else if (_deployIndex == 2) {
      _deployIndex++;
      _deployTokenWethMarketWithLiquidity(token3, 1e20, price3);
    } else if (_deployIndex == 3) {
      _deployIndex++;
      _deployTokenWethMarketWithLiquidity(token4, 1e20, price4);
    } else if (_deployIndex == 4) {
      _deployIndex++;
      _deployTokenWethMarketWithLiquidity(token5, 1e20, price5);
      _liquidityAll = 1e20;
      _marketsReady = true;
    }
  }

  function _addLiquidityAll() internal marketsReady {
    _addLiquidity(token1, 1e19, price1);
    _addLiquidity(token2, 1e19, price2);
    _addLiquidity(token3, 1e19, price3);
    _addLiquidity(token4, 1e19, price4);
    _addLiquidity(token5, 1e19, price5);
    _liquidityAll += 1e19;
  }

  function _addLiquidity(
    MockERC20 token,
    uint256 amountToken,
    uint256 price
  ) internal {
    uint256 amountWeth = amountToken * price;
    token.getFreeTokens(address(this), amountToken);
    weth.getFreeTokens(address(this), amountWeth);
    token.approve(address(router), amountToken);
    weth.approve(address(router), amountWeth);
    router.addLiquidity(
      address(token),
      address(weth),
      amountToken,
      amountWeth,
      amountToken,
      amountWeth,
      address(this),
      now + 1
    );
  }

  function _deployTokenWethMarketWithLiquidity(
    MockERC20 token,
    uint256 amountToken,
    uint256 price
  ) internal {
    factory.createPair(address(token), address(weth));
    _addLiquidity(token, amountToken, price);
  }
}