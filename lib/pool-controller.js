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

  getInitialTokenWeightsAndBalances(categoryID, indexSize, stablecoinValue) {
    return this.poolController.methods.getInitialTokenWeightsAndBalances(
      categoryID,
      indexSize,
      stablecoinValue
    ).call();
  }

  async deployPool(
    categoryID,
    indexSize,
    name,
    symbol,
    initialStablecoinValue
  ) {
    const value = toBN(initialStablecoinValue);
    let { tokens, balances } = await this.getInitialTokenWeightsAndBalances(
      categoryID,
      indexSize,
      value
    );
    for (let i = 0; i < tokens.length; i++) {
      const token = getERC20(this.web3, tokens[i]);
      const balance = toBN(balances[i]);
      await token.methods.getFreeTokens(
        this.poolController.options.address,
        balance
      ).send({ from: this.from });
    }
    const receipt = await this.poolController.methods.deployIndexPool(
      categoryID,
      indexSize,
      name,
      symbol,
      value
    ).send({ from: this.from });
    const { pool } = receipt.events.LOG_NEW_POOL.returnValues;
    return toContract(this.web3, BPoolABI, pool);
  }
}

module.exports = PoolController;