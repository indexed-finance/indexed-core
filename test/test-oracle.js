const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
const { soliditySha3 } = require('web3-utils');
const BN = require('bn.js');
const bre = require("@nomiclabs/buidler");

const { setupUniSwapV2 } = require('./lib/uniswap-setup');
const { wrapped_tokens: wrappedTokens } = require('./testData/categories.json');
const { nTokens, nTokensHex } = require('./lib/tokens');

chai.use(chaiAsPromised);
const { expect } = chai;

const keccak256 = (data) => soliditySha3(data);
const toBN = (bn) => new BN(bn._hex.slice(2), 'hex');

describe("Market Oracle", () => {
  let uniswapFactory, uniswapRouter, weth;
  let from, marketOracle;
  let erc20Factory;
  let timestampAddition = 0;

  const getTimestamp = () => Math.floor(new Date().getTime() / 1000) + timestampAddition;
  const increaseTimeByOnePeriod = () => {
    timestampAddition += 3.5 * 24 * 60 * 60;
    const timestamp = getTimestamp();
    return web3.currentProvider._sendJsonRpcRequest({
      method: "evm_setNextBlockTimestamp",
      params: [timestamp],
      jsonrpc: "2.0",
      id: new Date().getTime()
    });
  }

  before(async () => {
    erc20Factory = await ethers.getContractFactory("MockERC20");
    ({
      from,
      uniswapFactory,
      uniswapRouter,
      weth,
      marketOracle
    } = await bre.run('deploy_contracts'));
    [from] = await web3.eth.getAccounts();
    ({ weth, uniswapFactory, uniswapRouter } = await setupUniSwapV2(web3, from));
  });

  async function deployToken(tokenObj) {
    const { name, symbol } = tokenObj;
    const token = await erc20Factory.deploy(name, symbol);
    tokenObj.token = token;
    tokenObj.address = token.address;
  }

  async function getFreeWeth(to, amount) {
    await weth.methods.deposit().send({
      from,
      value: amount
    });
    if (to && to != from) {
      await weth.methods.transfer(to, amount).send({ from: this.from });
    }
  }

  /**
   * Add liquidity to uniswap market pair for a token and weth
   * @param price Amount of weth per token
   * @param liquidity Amount of tokens to add
   */
  async function addTokenLiquidity(token, price, liquidity) {
    const amountToken = nTokensHex(liquidity);
    const amountWeth = nTokensHex(liquidity * price);
    await token.getFreeTokens(from, amountToken).then(r => r.wait());
    await getFreeWeth(from, amountWeth);
    await token.approve(uniswapRouter.options.address, amountToken).then(r => r.wait());
    
    await weth.methods.approve(uniswapRouter.options.address, amountWeth).send({ from })
    const timestamp = getTimestamp() + 1000;
    await uniswapRouter.methods.addLiquidity(
      token.address,
      weth.options.address,
      amountToken,
      amountWeth,
      amountToken,
      amountWeth,
      from,
      timestamp
    ).send({ from });
  }

  /**
   * Deploy a market pair for (token, weth) and initialize it with liquidity.
   * @param tokenObj - object with token data
   * @param liquidity - amount of tokens to give as liquidity
   */
  async function createTokenMarket(tokenObj, liquidity) {
    const { address, initialPrice, token } = tokenObj;
    const result = await uniswapFactory.methods.createPair(address, weth.options.address).send({ from });
    const { pair } = result.events.PairCreated.returnValues;
    tokenObj.pair = pair;
    await addTokenLiquidity(token, initialPrice, liquidity);
  }

  describe('Initialize Tokens', async () => {
    it('Should deploy the wrapped token mocks', async () => {
      for (let i = 0; i < wrappedTokens.length; i++) {
        await deployToken(wrappedTokens[i]);
      }
    });
  });

  describe('Initialize Markets', async () => {
    it('Should deploy the wrapped token market pairs', async () => {
      for (let i = 0; i < wrappedTokens.length; i++) {
        await createTokenMarket(wrappedTokens[i], 100);
      }
    });
  });

  describe('Initialize Oracle', async () => {
    it('Should deploy the market oracle', async () => {
      const oracleFactory = await ethers.getContractFactory("MarketOracle");
      marketOracle = await oracleFactory.deploy(
        uniswapFactory.options.address,
        weth.options.address,
        from
      );
    });

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
      await marketOracle.addTokens(1, wrappedTokens.map(t => t.address)).then(r => r.wait());
    });

    it('Should query the category tokens', async () => {
      const tokens = await marketOracle.getCategoryTokens(1);
      expect(tokens).to.deep.equal(wrappedTokens.map(t => t.address));
    });

    it('Should fail to return a price if the latest price is not old enough', async () => {
      const [token] = await marketOracle.getCategoryTokens(1);
      expect(
        marketOracle.computeAveragePrice(token)
      ).to.be.rejectedWith(/ERR_USABLE_PRICE_NOT_FOUND/g)
    });

    it('Should update the block timestamp', async () => {
      await increaseTimeByOnePeriod();
    });

    it('Should return the correct market caps', async () => {
      const caps = [];
      for (let i = 0; i < wrappedTokens.length; i++) {
        const { address, token, initialPrice } = wrappedTokens[i];
        // In order to update the cumulative prices on the market pairs,
        // we need to add some more liquidity (could also execute trades)
        await addTokenLiquidity(token, initialPrice, 50);
        const expectedMarketCap = nTokens(150 * initialPrice);
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
      const marketCaps = [10, 1, 2].map(n => nTokens(n * 150));
      expect(
        mapToHex(category.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCaps));
      const categorySorted = sortArr(category);
      const marketCapsSorted = [10, 2, 1].map(n => nTokens(n * 150));
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
});
