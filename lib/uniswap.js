const {
  abi: UniswapV2FactoryABI,
  bytecode: UniswapV2FactoryBytecode,
} = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const {
  abi: WETH9ABI,
  bytecode: WETH9Bytecode,
} = require("@uniswap/v2-periphery/build/WETH9.json");
const {
  abi: UniswapV2RouterABI,
  bytecode: UniswapV2RouterBytecode,
} = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");

const { deployERC20, getERC20 } = require('./erc20');
const { nTokens, nTokensHex } = require('./util/bn');
const { deploy, toContract } = require('./util/contracts');

module.exports = class Uniswap {
  constructor(web3, contracts, from = null) {
    this.web3 = web3;
    this.from = from;
    const { uniswapFactory, uniswapRouter, weth, stablecoin } = contracts;
    this.uniswapFactory = toContract(web3, UniswapV2FactoryABI, uniswapFactory);
    this.uniswapRouter = toContract(web3, UniswapV2RouterABI, uniswapRouter);
    this.weth = toContract(web3, WETH9ABI, weth);
    this.stablecoin = getERC20(web3, stablecoin);
  }

  static async deploy(web3, from) {
    const uniswapFactory = await deploy(
      web3,
      from,
      UniswapV2FactoryABI,
      UniswapV2FactoryBytecode,
      [from]
    );
    const weth = await deploy(
      web3,
      from,
      WETH9ABI,
      WETH9Bytecode,
      [from]
    );
    const uniswapRouter = await deploy(
      web3,
      from,
      UniswapV2RouterABI,
      UniswapV2RouterBytecode,
      [uniswapFactory.options.address, weth.options.address]
    );
    const stablecoin = await deployERC20(web3, from, "DAI StableCoin", "DAI");
    return new Uniswap(web3, { uniswapFactory, uniswapRouter, weth, stablecoin }, from);
  }

  /**
   * @returns {Promise<number>}
   */
  getTimestamp() {
    return this.web3.eth.getBlock('pending').then(({ timestamp }) => timestamp);
  }

  async deployMarket(tokenAddress) {
    const result = await this.uniswapFactory.methods.createPair(
      tokenAddress,
      this.stablecoin.options.address
    ).send({ from: this.from, gas: 5e6 });
    const { pair } = result.events.PairCreated.returnValues;
    return pair;
  }

  /**
   * Adds liquidity to the UniSwap market between a token and the stablecoin.
   * @param {String} tokenAddress Address of the ERC20 token
   * @param {Number} price Price of token in the stablecoin
   * @param {Number} liquidity Amount of tokens to provide
   */
  async addMarketLiquidity(tokenAddress, price, liquidity) {
    const token = getERC20(this.web3, tokenAddress);
    const amountToken = nTokensHex(liquidity);
    const amountStablecoin = nTokensHex(liquidity * price);
    await token.methods.getFreeTokens(this.from, amountToken)
      .send({ from: this.from });
    await this.stablecoin.methods.getFreeTokens(this.from, amountStablecoin)
      .send({ from: this.from });
    await token.methods.approve(this.uniswapRouter.options.address, amountToken)
      .send({ from: this.from });
    await this.stablecoin.methods.approve(this.uniswapRouter.options.address, amountStablecoin)
      .send({ from: this.from });
    const timestamp = (await this.getTimestamp()) + 1000;
    await this.uniswapRouter.methods.addLiquidity(
      tokenAddress,
      this.stablecoin.options.address,
      amountToken,
      amountStablecoin,
      amountToken,
      amountStablecoin,
      this.from,
      timestamp
    ).send({ from: this.from, gas: 5e6 });
  }
}