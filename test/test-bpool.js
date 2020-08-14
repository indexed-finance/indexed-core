const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);

const UniswapHelper = require('./lib/uniswap-helper');
const createKeccakHash = require('keccak');
const BN = require('bn.js');

const { nTokens, nTokensHex } = require('./lib/tokens');
const { wrapped_tokens: wrappedTokens } = require('./testData/categories.json');

const { expect } = chai;
const keccak256 = (data) => `0x${createKeccakHash('keccak256').update(data).digest().toString('hex')}`;

const toBN = (bn) => new BN(bn._hex.slice(2), 'hex');

describe("BPool", () => {
  let uniswapHelper, from, marketOracle, stablecoin, poolController, indexPool;
  let timestampAddition = 0;

  const getTimestamp = () => Math.floor(new Date().getTime() / 1000) + timestampAddition;
  const increaseTimeByOneDay = () => {
    timestampAddition += 24 * 60 * 60;
    const timestamp = getTimestamp();
    return web3.currentProvider._sendJsonRpcRequest({
      method: "evm_setNextBlockTimestamp",
      params: [timestamp],
      jsonrpc: "2.0",
      id: new Date().getTime()
    });
  }

  before(async () => {
    [from] = await web3.eth.getAccounts();
    const erc20Factory = await ethers.getContractFactory("MockERC20");
    uniswapHelper = new UniswapHelper(web3, from, erc20Factory, getTimestamp);
    await uniswapHelper.init();
    stablecoin = uniswapHelper.stablecoin;
    const oracleFactory = await ethers.getContractFactory("MarketOracle");
    marketOracle = await oracleFactory.deploy(
      uniswapHelper.uniswapFactory.options.address,
      stablecoin.address,
      from
    );
  });

  it('Should deploy the Pool Controller', async () => {
    const controllerFactory = await ethers.getContractFactory("PoolController");
    poolController = await controllerFactory.deploy(marketOracle.address);
  });

  describe('Initialize Markets', async () => {
    it('Should deploy the wrapped token market pairs', async () => {
      for (let i = 0; i < wrappedTokens.length; i++) {
        const { name, symbol, initialPrice } = wrappedTokens[i];
        const token = await uniswapHelper.deployTokenAndMarket(name, symbol, initialPrice, 100);
        wrappedTokens[i] = token;
        token.token.getFreeTokens(from, nTokensHex(100000));
      }
    });
  });

  describe('Initialize Oracle', async () => {
    it('Should create a wrapped tokens category', async () => {
      const metadata = {
        name: 'Wrapped Tokens',
        description: 'Category for wrapped tokens.'
      };
      const metadataHash = keccak256(JSON.stringify(metadata));
      const receipt = await marketOracle.createCategory(metadataHash);
      const { events } = await receipt.wait();
      expect(events.length).to.eql(1);
      const [event] = events;
      expect(event.event).to.eql('CategoryAdded');
      expect(event.args.metadataHash).to.eql(metadataHash);
      expect(event.args.categoryID.toNumber()).to.eql(1);
    });

    it('Should add tokens to the wrapped tokens category', async () => {
      const opts = {
        categoryID: 1,
        tokens: wrappedTokens.map(t => t.address)
      };
      await marketOracle.addTokens([opts]).then(r => r.wait());
    });

    it('Should update the block timestamp', async () => {
      await increaseTimeByOneDay();
    });

    it('Should return the correct market caps', async () => {
      const caps = [];
      for (let i = 0; i < wrappedTokens.length; i++) {
        const { symbol, address, initialPrice } = wrappedTokens[i];
        // In order to update the cumulative prices on the market pairs,
        // we need to add some more liquidity (could also execute trades)
        await uniswapHelper.addTokenLiquidity(symbol, initialPrice, 50);
        const expectedMarketCap = nTokens(100150).muln(initialPrice);
        const realMarketCap = await marketOracle.computeAverageMarketCap(address)
          .then(toBN);
        const pct = realMarketCap.div(expectedMarketCap);
        expect(pct.eqn(1)).to.be.true;
        caps.push(realMarketCap.toString('hex'));
      }
      const categoryCaps = await marketOracle.getCategoryMarketCaps(1);
      expect(categoryCaps.map(toBN).map(c => c.toString('hex'))).to.deep.equal(caps);
    });
  });

  describe('Sort Tokens', async () => {
    const mapToHex = (arr) => arr.map((i) => i.toString('hex'));
    const sortArr = (arr) => arr.sort((a, b) => {
      if (a.marketCap.lt(b.marketCap)) return 1;
      if (a.marketCap.gt(b.marketCap)) return -1;
      return 0;
    });

    async function getCategoryData(id) {
      const tokens = await marketOracle.getCategoryTokens(id);
      const marketCaps = await marketOracle.getCategoryMarketCaps(id);
      const arr = [];
      for (let i = 0; i < tokens.length; i++) {
        arr.push({
          token: tokens[i],
          marketCap: toBN(marketCaps[i])
        });
      }
      return arr;
    }

    it('Should sort the tokens and update the category', async () => {
      const category = await getCategoryData(1);
      const marketCaps = [12000, 200, 390].map(n => nTokens(100150).muln(n));
      expect(
        mapToHex(category.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCaps));
      const categorySorted = sortArr(category);
      const marketCapsSorted = [12000, 390, 200].map(n => nTokens(100150).muln(n));
      expect(
        mapToHex(categorySorted.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCapsSorted));
      const receipt = await marketOracle.orderCategoryTokensByMarketCap(
        1, categorySorted.map((t) => t.token)
      ).then((r) => r.wait());
      const categoryAfterSort = await getCategoryData(1);
      expect(
        mapToHex(categoryAfterSort.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCapsSorted));
      console.log(`Cost To Sort Tokens: ${toBN(receipt.cumulativeGasUsed).toNumber()}`)
    });
  });

  describe('Pool Deployment', async () => {
    let sortedTokens = [];
    let normalizedWeights_real = [], denormalizedWeights_real = [], balances_real = [];

    before(async () => {
      const sortedTokenAddresses = await marketOracle.getTopCategoryTokens(1, 3);
      sortedTokens = sortedTokenAddresses.map(addr => uniswapHelper.getTokenByAddress(addr));
      let sum_qrts = 0;
      for (let token of sortedTokens) {
        const mkt_cap = Math.sqrt(100150 * token.initialPrice);
        sum_qrts += mkt_cap;
      }
      const totalValue = nTokens(10000);
      const max_weight = nTokens(50);
      for (let token of sortedTokens) {
        const mkt_cap = Math.sqrt(100150 * token.initialPrice);
        const weight = mkt_cap / sum_qrts;
        normalizedWeights_real.push(weight);
        denormalizedWeights_real.push(max_weight.muln(weight));
        balances_real.push(totalValue.muln(weight).divn(token.initialPrice));
      }
    });

    const diffAsPct = (a, b) => {
      const diff = a.sub(b);
      const expandedDiff = a.div(diff).toNumber();
      return 100 / expandedDiff;
    }

    it('Computes the correct balances and denormalized weights', async () => {
      const { balances, denormalizedWeights } = await poolController.getInitialTokenWeightsAndBalances(1, 3, nTokensHex(10000));
      for (let i = 0; i < balances.length; i++) {
        const balance = toBN(balances[i]);
        const denormalizedWeight = toBN(denormalizedWeights[i]);
        const balanceReal = balances_real[i];
        const denormalizedWeight_real = denormalizedWeights_real[i];
        const balPctDiff = diffAsPct(balance, balanceReal);
        const weightPctDiff = diffAsPct(denormalizedWeight, denormalizedWeight_real);
        expect(balPctDiff < 0.1);
        expect(weightPctDiff < 0.1);
      }
    });
    
    it('Give tokens to the pool controller', async () => {
      const { tokens, balances } = await poolController.getInitialTokenWeightsAndBalances(1, 3, nTokensHex(10000));
      const controllerAddress = poolController.address;
      for (let i = 0; i < balances.length; i++) {
        const token = await ethers.getContractAt('MockERC20', tokens[i]);
        await token.transfer(controllerAddress, balances[i]);
        const controllerBalance = await token.balanceOf(controllerAddress);
        expect(controllerBalance).to.equal(balances[i]);
      }
    });

    it('Fails to deploy an index for a category that does not exist', async () => {
      expect(
        poolController.deployIndexPool(
          2,
          3,
          "Invalid category index",
          "BADC2"
        ).then(r => r.wait())
      ).to.be.rejectedWith(/Category does not exist/g);
    });

    it('Deploys the category index pool', async () => {
      const expectedAddress = await poolController.computePoolAddress(1, 3);
      const receipt = await poolController.deployIndexPool(
        1,
        3,
        "Top 3 Wrapped Tokens Index",
        "WTI3"
      );
      const { events, gasUsed } = await receipt.wait();
      console.log(`Pool Deployment Cost: ${gasUsed}`)
      expect(events.length).to.eql(1);
      const [event] = events;
      expect(event.event).to.eql('LOG_NEW_POOL');
      const {
        pool,
        categoryID,
        indexSize
      } = event.args;
      expect(pool).to.equal(expectedAddress);
      expect(categoryID).to.equal(categoryID);
      expect(indexSize).to.equal(indexSize);
      indexPool = await ethers.getContractAt('BPool', expectedAddress);
    });

    it('Sets the controller address on deployment', async () => {
      const controllerAddress = await indexPool.getController();
      expect(controllerAddress).to.equal(poolController.address);
    });

    it('Has not enabled public swapping', async () => {
      const isPublicSwap = await indexPool.isPublicSwap();
      const isFinalized = await indexPool.isFinalized();
      expect(isPublicSwap).to.be.false;
      expect(isFinalized).to.be.false;
    });

    it('Sets the correct token name and symbol', async () => {
      const name = await indexPool.name();
      expect(name).to.equal("Top 3 Wrapped Tokens Index");
      const symbol = await indexPool.symbol();
      expect(symbol).to.equal("WTI3");
    });
  });

  describe('Pool Initialization', async () => {
    let tokens, balances, denormalizedWeights;

    before(async () => {
      ({ tokens, balances, denormalizedWeights } = await poolController.getInitialTokenWeightsAndBalances(1, 3, nTokensHex(10000)))
    });

    it('Initializes the pool tokens and weights', async () => {
      const receipt = await poolController.initializePool(1, 3, nTokensHex(10000)).then(r => r.wait());
      console.log(`Pool Initialization Cost: ${receipt.gasUsed}`)
    });

    it('Set the correct tokens', async () => {
      const currentTokens = await indexPool.getCurrentTokens();
      expect(currentTokens).to.deep.equal(tokens);
    });

    it('Pulled the correct balances', async () => {
      const poolBalances = await Promise.all(tokens.map(token => indexPool.getBalance(token)));
      expect(poolBalances).to.deep.equal(balances);
    });

    it('Set the correct denormalized weights', async () => {
      const poolWeights = await Promise.all(tokens.map(token => indexPool.getDenormalizedWeight(token)));
      expect(poolWeights).to.deep.equal(denormalizedWeights);
    });

    it('Enabled public swapping', async () => {
      const isPublicSwap = await indexPool.isPublicSwap();
      const isFinalized = await indexPool.isFinalized();
      expect(isPublicSwap).to.be.true;
      expect(isFinalized).to.be.true;
    });

    it('Minted the correct amount of tokens for the controller', async () => {
      const expectedBalance = nTokensHex(100);
      const balance = await indexPool.balanceOf(poolController.address);
      expect(balance).to.equal(expectedBalance);
    });
  });
});