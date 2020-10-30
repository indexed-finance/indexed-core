const { BigNumber } = require("ethers");
const { getTransactionTimestamp } = require("../utils");

const toAddress = (token) => (typeof token == 'string' ? token : token.address).toLowerCase();

const MAX_UINT112 = BigNumber.from(2).pow(112);

function encodePrice(_tokenReserves, _wethReserves, _blockTimestamp, lastPrice = {}) {
  const blockTimestamp = _blockTimestamp % (2**32);
  const timeElapsed = blockTimestamp - (lastPrice.blockTimestamp || 0);
  let tokenPriceAverage = lastPrice.tokenPriceAverage;
  let ethPriceAverage = lastPrice.ethPriceAverage;
  let tokenPriceCumulativeLast = BigNumber.from(0)
  let ethPriceCumulativeLast = BigNumber.from(0);
  if (timeElapsed > 0 && lastPrice.tokenReserves && lastPrice.wethReserves) {
    const { tokenReserves, wethReserves } = lastPrice;
    tokenPriceAverage = wethReserves.mul(MAX_UINT112).div(tokenReserves);
    ethPriceAverage = tokenReserves.mul(MAX_UINT112).div(wethReserves);
    tokenPriceCumulativeLast = lastPrice.tokenPriceCumulativeLast.add(
      tokenPriceAverage.mul(timeElapsed)
    );
    ethPriceCumulativeLast = lastPrice.ethPriceCumulativeLast.add(
      ethPriceAverage.mul(timeElapsed)
    );
  }
  const tokenReserves = BigNumber.from(lastPrice.tokenReserves || 0).add(_tokenReserves);
  const wethReserves = BigNumber.from(lastPrice.wethReserves || 0).add(_wethReserves);
  return {
    tokenReserves,
    wethReserves,
    tokenPriceAverage,
    ethPriceAverage,
    blockTimestamp,
    tokenPriceCumulativeLast,
    ethPriceCumulativeLast
  };
}

class LiquidityManager {
  constructor(liquidityAdder, uniswapOracle) {
    this.prices = {};
    this.liquidityAdder = liquidityAdder;
    this.uniswapOracle = uniswapOracle;
  }

  updateEncodedPrice(address, amountToken, amountWeth, timestamp) {
    const lastPrice = this.prices[address] || {};
    this.prices[address] = encodePrice(amountToken, amountWeth, +timestamp, lastPrice || {});
  }

  async addLiquidity(token, amountToken, amountWeth) {
    const address = toAddress(token);
    const [amountTokenActual, amountWethActual] = await this.liquidityAdder.callStatic.addLiquiditySingle(
      address,
      amountToken,
      amountWeth
    );
    const tx = this.liquidityAdder.addLiquiditySingle(
      address,
      amountToken,
      amountWeth,
      { gasLimit: 4700000 }
    );
    const timestamp = await getTransactionTimestamp(tx);
    this.updateEncodedPrice(address, amountTokenActual, amountWethActual, timestamp);
    return tx;
  }

  async updatePrice(_token) {
    const address = toAddress(_token);
    const tx = this.uniswapOracle.updatePrice(address);
    const timestamp = await getTransactionTimestamp(tx);
    this.updateEncodedPrice(address, 0, 0, timestamp);
    return tx;
  }

  async updatePricesInternal(_tokens) {
    const addresses = _tokens.map(toAddress);
    const { timestamp } = await this.liquidityAdder.provider.getBlock('latest');
    for (let address of addresses) {
      this.updateEncodedPrice(address, 0, 0, timestamp);
    }
  }

  async updatePrices(_tokens) {
    const addresses = _tokens.map(toAddress);
    const tx = this.uniswapOracle.updatePrices(addresses);
    const timestamp = await getTransactionTimestamp(tx);
    for (let address of addresses) {
      this.updateEncodedPrice(address, BigNumber.from(0), BigNumber.from(0), timestamp);
    }
    return tx;
  }

  async swapIncreasePrice(_token) {
    const address = toAddress(_token);
    const [amountWeth, amountToken] = await this.liquidityAdder.callStatic.swapIncreasePrice(address);
    const tx = this.liquidityAdder.swapIncreasePrice(address);
    const timestamp = await getTransactionTimestamp(tx);
    this.updateEncodedPrice(address, BigNumber.from(0).sub(amountToken), amountWeth, timestamp);
    return tx;
  }

  async swapDecreasePrice(_token) {
    const address = toAddress(_token);
    const [amountToken, amountWeth] = await this.liquidityAdder.callStatic.swapDecreasePrice(address);
    const tx = this.liquidityAdder.swapDecreasePrice(address);
    const timestamp = await getTransactionTimestamp(tx);
    this.updateEncodedPrice(address, amountToken, BigNumber.from(0).sub(amountWeth), timestamp);
    return tx;
  }

  getTokenValue(_token, amountToken) {
    const address = toAddress(_token);
    const lastPrice = this.prices[address];
    return lastPrice.tokenPriceAverage.mul(amountToken).div(MAX_UINT112);
  }

  getEthValue(_token, amountWeth) {
    const lastPrice = this.prices[toAddress(_token)];
    return lastPrice.ethPriceAverage.mul(amountWeth).div(MAX_UINT112);
  }

  getAverageTokenPrice(_token) {
    const lastPrice = this.prices[toAddress(_token)];
    return lastPrice.tokenPriceAverage;
  }

  getAverageEthPrice(_token) {
    const lastPrice = this.prices[toAddress(_token)];
    return lastPrice.ethPriceAverage;
  }
}

module.exports = LiquidityManager;