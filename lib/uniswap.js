const {
  abi: UniswapV2FactoryABI,
} = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const {
  abi: UniswapV2RouterABI,
} = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");
const {
  abi: MockDeployerABI
} = require('../artifacts/MockTokenMarketDeployer.json');
const { getERC20 } = require('./erc20');
const { toBN } = require('./util/bn');
const { toContract } = require('./util/contracts');

module.exports = class Uniswap {
  constructor(web3, contracts, from = null) {
    this.web3 = web3;
    this.from = from;
    const { uniswapFactory, uniswapRouter, weth, mockDeployer } = contracts;
    this.uniswapFactory = toContract(web3, UniswapV2FactoryABI, uniswapFactory);
    this.uniswapRouter = toContract(web3, UniswapV2RouterABI, uniswapRouter);
    this.mockDeployer = toContract(web3, MockDeployerABI, mockDeployer);
    this.weth = getERC20(web3, weth);
  }

  getWethPair(tokenAddress) {
    return this.uniswapFactory.methods.getPair(
      this.weth.options.address,
      tokenAddress
    ).call();
  }

  /**
   * Convert a web3 'wei' value (i.e. normalized value times 1e18) to an 'ether' value (divide by 1e18)
   * @param {BN | number | string} _bn - Hex string, number or BN
   * @returns {String} Number string
   */
  fromWei(_bn) {
    return this.web3.utils.fromWei(toBN(_bn).toString(10));
  }

  /**
   * Convert a web3 'ether' value (i.e. normalized value) to a 'wei' value (multiply by 1e18)
   * @param {BN | number | string} _bn - Hex string, number or BN
   * @returns {String} Number string
   */
  toWei(_bn) {
    return this.web3.utils.toWei(toBN(_bn).toString(10));
  }

  /**
   * @returns {Promise<number>}
   */
  getTimestamp() {
    return this.web3.eth.getBlock('latest').then(({ timestamp }) => timestamp);
  }

  async deployMarket(tokenAddress) {
    const result = await this.uniswapFactory.methods.createPair(
      tokenAddress,
      this.weth.options.address
    ).send({ from: this.from, gas: 5e6 });
    const { pair } = result.events.PairCreated.returnValues;
    return pair;
  }

  async deployTokenAndMarketWithLiquidity(name, symbol, price, liquidity) {
    const receipt = await this.mockDeployer.methods.deployTokenAndMarketWithLiquidity(
      name,
      symbol,
      this.toWei(liquidity),
      this.toWei(price * liquidity)
    ).send({ from: this.from, gas: 4004782 });
    const tokenAddress = receipt.events.TokenDeployed.returnValues.token;
    console.log(`Deployed ${name} to ${tokenAddress} & market pair with ${liquidity} tokens @${price} WETH`);
    return tokenAddress;
  }

  async deployPoolMarketWithLiquidity(poolAddress, price, liquidity) {
    await this.mockDeployer.methods.deployPoolMarketWithLiquidity(
      poolAddress,
      this.toWei(liquidity),
      this.toWei(price * liquidity)
    ).send({ from: this.from, gas: 5e6 });
    console.log(`Deployed UniSwap market for ${poolAddress} with ${liquidity} tokens @${price} WETH`)
  }

  async addPoolMarketLiquidity(poolAddress, price, liquidity) {
    await this.mockDeployer.methods.addPoolMarketLiquidity(
      poolAddress,
      this.toWei(liquidity),
      this.toWei(price * liquidity)
    ).send({ from: this.from, gas: 5e6 });
    console.log(`Added pool market liquidity w/ ${liquidity} tokens @${price} WETH`)
  }

  /**
   * Adds liquidity to the UniSwap market between a token and weth.
   * @param {String} tokenAddress Address of the ERC20 token
   * @param {Number} price Price of token in weth
   * @param {Number} liquidity Amount of tokens to provide
   */
  async addMarketLiquidity(tokenAddress, price, liquidity) {
    await this.mockDeployer.methods.addLiquidity(
      tokenAddress,
      this.toWei(liquidity),
      this.toWei(price * liquidity)
    ).send({ from: this.from, gas: 5e6 });
    // console.log(`Added token market liquidity w/ ${liquidity} tokens @${price} WETH`)
  }
}