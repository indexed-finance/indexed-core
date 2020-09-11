const {
  abi: PoolControllerABI,
  bytecode: PoolControllerBytecode
} = require('../artifacts/PoolController.json');
const {
  abi: PoolABI,
  bytecode: PoolBytecode
} = require('../artifacts/BPool.json');
const { abi: MarketOracleABI } = require('../artifacts/MarketOracle.json');
const { abi: BPoolABI } = require('../artifacts/BPool.json');

const { deploy, toContract } = require('./util/contracts');
const { toBN } = require('./util/bn');
const { init } = require('../server/src/express');
const { getERC20 } = require('./erc20');

class PoolController {
  constructor(web3, poolController, oracle, from) {
    this.web3 = web3;
    this.from = from;
    this.poolController = toContract(web3, PoolControllerABI, poolController);
    this.oracle = toContract(web3, MarketOracleABI, oracle);
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

  static async deploy(web3, from, oracleAddress) {
    const poolContract = await deploy(
      web3,
      from,
      PoolABI,
      PoolBytecode,
      []
    );
    const poolController = await deploy(
      web3,
      from,
      PoolControllerABI,
      PoolControllerBytecode,
      [oracleAddress, poolContract.options.address]
    );
    return new PoolController(web3, poolController, oracleAddress, from);
  }

  poolShouldBeReweighed(poolAddress) {
    return this.poolController.methods.shouldPoolReweigh(poolAddress).call();
  }

  async poolExists(categoryID, indexSize) {
    const poolAddress = await this.poolController.methods
      .computePoolAddress(categoryID, indexSize).call();
    return this.poolController.methods.isBPool(poolAddress).call();
  }

  getInitialTokenWeightsAndBalances(categoryID, indexSize, wethValue) {
    return this.poolController.methods.getInitialTokenWeightsAndBalances(
      categoryID,
      indexSize,
      wethValue
    ).call();
  }

  async deployPool(
    categoryID,
    indexSize,
    name,
    symbol,
    initialWethValue
  ) {
    console.log(`Deploying pool ${categoryID}-${indexSize}`)
    const value = this.toWei(initialWethValue);
    let res = await this.getInitialTokenWeightsAndBalances(
      categoryID,
      indexSize,
      value
    );
    console.log(res)
    let { tokens, balances } = res;

    for (let i = 0; i < tokens.length; i++) {
      const token = getERC20(this.web3, tokens[i]);
      const balance = toBN(balances[i]);
      console.log(`Minting ${balance} to controller`)
      // We need extra because we're minting the tokens,
      // so the market caps will increase.
      await token.methods.getFreeTokens(
        this.poolController.options.address,
        balance.muln(2)
      ).send({ from: this.from, gas: 100000 });
    }
    const receipt = await this.poolController.methods.deployIndexPool(
      categoryID,
      indexSize,
      name,
      symbol,
      value
    ).send({ from: this.from, gas: 300000 * tokens.length });
    const { pool } = receipt.events.LOG_NEW_POOL.returnValues;
    console.log(`Deployed ${name} index fund for category #${categoryID} to ${pool}`);
    return toContract(this.web3, BPoolABI, pool);
  }
}

module.exports = PoolController;