const BN = require('bn.js');
const createKeccakHash = require('keccak');
const {
  nTokens,
  nTokensHex
} = require('./tokens');

const keccak256 = (data) => `0x${createKeccakHash('keccak256').update(data).digest().toString('hex')}`;
const toBN = (bn) => new BN(bn._hex.slice(2), 'hex');

const mapToHex = (arr) => arr.map((i) => i.toString('hex'));
const sortTokens = (arr) => arr.sort((a, b) => {
  if (a.marketCap.lt(b.marketCap)) return 1;
  if (a.marketCap.gt(b.marketCap)) return -1;
  return 0;
});

class IndexHelper {
  constructor(web3, from, uniswapHelper, oracleDeployer, poolControllerDeployer) {
    this.web3 = web3;
    this.from = from;
    this.uniswapHelper = uniswapHelper;
    this.oracleDeployer = oracleDeployer;
    this.poolControllerDeployer = poolControllerDeployer;
    this.stablecoin = uniswapHelper.stablecoin
  }

  async init() {
    // const oracleFactory = await ethers.getContractFactory("MarketOracle");
    this.marketOracle = await this.oracleDeployer.deploy(
      this.uniswapHelper.uniswapFactory.options.address,
      this.stablecoin.address,
      this.from
    );
    // const controllerFactory = await ethers.getContractFactory("PoolController");
    this.poolController = await this.poolControllerDeployer.deploy(this.marketOracle.address);
  }

  async getCategoryTokens(id) {
    const tokens = await this.marketOracle.getCategoryTokens(id);
    const marketCaps = await this.marketOracle.getCategoryMarketCaps(id);
    const arr = [];
    for (let i = 0; i < tokens.length; i++) {
      arr.push({
        token: tokens[i],
        marketCap: toBN(marketCaps[i])
      });
    }
    return arr;
  }

  async getSortedCategory(id) {
    const arr = this.getCategoryTokens(id);
    return sortTokens(arr);
  }

  async sortCategoryTokens(id) {
    const sortedTokens = await this.getSortedCategory();
    return this.marketOracle.orderCategoryTokensByMarketCap(
      id, sortedTokens.map((t) => t.token)
    ).then((r) => r.wait && r.wait());
  }

  async deployTokens(tokensArray, totalSupply, marketSupply) {
    for (let i = 0; i < tokensArray.length; i++) {
      const { name, symbol, initialPrice } = tokensArray[i];
      const token = await this.uniswapHelper.deployTokenAndMarket(
        name, symbol, initialPrice, marketSupply
      );
      tokensArray[i] = token;
      await token.token.getFreeTokens(this.from, nTokensHex(totalSupply - marketSupply));
    }
    return tokensArray;
  }

  async createCategory(metadata, tokenObjects) {
    const metadataHash = keccak256(JSON.stringify(metadata));
    const receipt = await this.marketOracle
      .createCategory(metadataHash).then(r => r.wait && r.wait());
    const opts = {
      categoryID: 1,
      tokens: tokenObjects.map(t => t.address)
    };
    await this.marketOracle.addTokens([opts]).then(r => r.wait && r.wait());
    return receipt;
  }

  async getCategoryMarketCaps(id) {
    return this.marketOracle.getCategoryMarketCaps(id);
  }

  async getTopCategoryTokens(id, size) {
    return this.marketOracle.getTopCategoryTokens(id, size);
  }
}

module.exports = IndexHelper;