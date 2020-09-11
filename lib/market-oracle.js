const { BN, toBN } = require('./util/bn');

const {
  abi: MarketOracleABI,
  bytecode: MarketOracleBytecode
} = require('../artifacts/MarketOracle.json');

const { abi: Erc20ABI } = require('../artifacts/IERC20.json');
const { deploy, toContract } = require('./util/contracts');
const { getIPFSFile } = require('./util/ipfs');

/**
 * @typedef {Object} CategoryInfo
 * @property {String} metadataHash - IPFS hash for the category metadata
 * @property {String} name - Category name
 * @property {String} symbol - Category symbol
 * @property {String} description - Category description
 * @property {String[]} tokens - Array of token addresses in the category
 * @property {number} lastUpdated - Timestamp of last time the category was sorted
 */

const ONE_DAY = 24 * 60 * 60;

const sortTokens = (arr) => arr.sort((a, b) => {
  if (a.marketCap.lt(b.marketCap)) return 1;
  if (a.marketCap.gt(b.marketCap)) return -1;
  return 0;
});

module.exports = class MarketOracle {
  /**
   * @param {Web3} web3 - web3 object
   * @param {string} address - address of the market oracle
   * @param {string?} from - address of the caller account (can be null)
   */
  constructor(web3, address, from = null) {
    this.from = from;
    this.web3 = web3;
    this.oracle = toContract(web3, MarketOracleABI, address);
  }

  static async deploy(web3, uniswapFactoryAddress, wethAddress, from) {
    const oracle = await deploy(web3, from, MarketOracleABI, MarketOracleBytecode, [
      uniswapFactoryAddress,
      wethAddress,
      from
    ]);
    return new MarketOracle(web3, oracle, from);
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

  async getCategoryMetadata(id) {
    const metadataHash = await this.oracle.methods.categoryMetadata(id).call();
    console.log(metadataHash)
    return getIPFSFile(metadataHash);
  }

  /**
   * Get data about a token category
   * @param {string | number} id - Category identifier
   * @returns {Promise<CategoryInfo>}
   */
  async getCategory(id) {
    const metadataHash = this.oracle.methods.categoryMetadata(id).call();
    const tokens = this.oracle.methods.getCategoryTokens(id).call();
    const lastUpdated = this.oracle.methods.lastCategoryUpdate(id).call();
    const { name, symbol, description } = await getIPFSFile(metadataHash);
    return {
      lastUpdated: await lastUpdated,
      metadataHash: await metadataHash,
      tokens: await tokens,
      name,
      symbol,
      description
    };
  }

  /**
   * Get all token categories on the market oracle
   * @returns {Promise<CategoryInfo[]>}
   */
  async getTokenCategories() {
    const categoryIndex = await this.oracle.methods.categoryIndex().call();
    const proms = [];
    for (let i = 1; i < categoryIndex; i++) proms.push(this.getCategory(i));
    return Promise.all(proms);
  }

  /**
   * Query the moving average market cap for a token
   * @param {String} address Token address
   */
  async getTokenMarketCap(address) {
    const priceRecord = await this.oracle.methods.lastObservedPrices(address).call();
    if (!priceRecord || !priceRecord.timestamp) {
      throw new Error('Token not found on oracle')
    }
    const { timestamp } = priceRecord;
    const blockTimestamp = await this.getTimestamp();
    const timeElapsed = blockTimestamp - timestamp;
    if (timeElapsed > ONE_DAY) {
      throw new Error('Token price needs to be updated.');
    }
    const cap = await this.oracle.methods.computeAverageMarketCap(address).call();
    return this.fromWei(cap);
  }

  async createCategory(metadataHash) {
    const receipt = await this.oracle.methods.createCategory(metadataHash).send({ from: this.from, gas: 160000 });
    const { categoryID } = receipt.events.CategoryAdded.returnValues;
    return categoryID;
  }

  addTokenToCategory(token, categoryID) {
    console.log({ token, categoryID })
    return this.oracle.methods.addToken(token, categoryID).send({ from: this.from, gas: 160000 });
  }

  async updateCategoryPrices(categoryID) {
    const tokens = await this.oracle.methods.getCategoryTokens(categoryID).call();
    await this.oracle.methods.updatePrices(tokens).send({ from: this.from });
  }

  async categoryShouldBeSorted(categoryID) {
    const lastUpdated = this.oracle.methods.lastCategoryUpdate(categoryID).call();
    const now = await this.getTimestamp();
    const timeElapsed = now - lastUpdated;
    return timeElapsed >= ONE_DAY;
  }

  async tokenPriceShouldBeUpdated(address) {
    const { timestamp } = await this.oracle.methods.lastObservedPrices(address).call();
    const now = await this.getTimestamp();
    const timeElapsed = now - timestamp;
    return timeElapsed >= ONE_DAY;
  }

  async getNormalizedTokenPrices(tokens) {
    const prices = await this.oracle.methods.computeAveragePrices(tokens).call();
    return prices;
  }

  async getIndexTokenPrice(
    mockDeployer,
    pool
  ) {
    const totalSupply = this.fromWei(await pool.methods.totalSupply().call());
    const totalValue = this.fromWei(
      await mockDeployer.methods.computePoolValue(
        this.oracle.options.address,
        pool.options.address
      ).call()
    );
    return totalValue / totalSupply;
  }

  async sortCategoryTokens(categoryID) {
    const tokens = await this.oracle.methods.getCategoryTokens(categoryID).call();
    console.log('sorting tokens')
    let marketCaps = await this.oracle.methods.computeAverageMarketCaps(tokens).call();
    console.log('got market caps')
    marketCaps = marketCaps.map(toBN);
    let tokensArr = [];
    for (let i = 0; i < tokens.length; i++) {
      tokensArr.push({
        token: tokens[i],
        marketCap: marketCaps[i]
      });
    }
    tokensArr = sortTokens(tokensArr);
    return this.oracle.methods.orderCategoryTokensByMarketCap(
      categoryID,
      tokensArr.map((t) => t.token)
    ).send({ from: this.from, gas: 300000 });
  }
}