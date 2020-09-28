const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
const { soliditySha3 } = require('web3-utils');
const BN = require('bn.js');
const bre = require("@nomiclabs/buidler");

const { wrapped_tokens: wrappedTokens } = require('./testData/categories.json');
const { nTokens, nTokensHex } = require('./lib/tokens');
const { calcRelativeDiff } = require("./lib/calc_comparisons");

chai.use(chaiAsPromised);
const { expect } = chai;

const errorDelta = 10 ** -8;
const keccak256 = (data) => soliditySha3(data);
const toBN = (bn) => BN.isBN(bn) ? bn : bn._hex ? new BN(bn._hex.slice(2), 'hex') : new BN(bn);

describe("MarketCapSqrtController.sol", () => {
  let uniswapFactory, uniswapRouter, weth;
  let from, uniswapOracle, shortUniswapOracle;
  let initializer;
  let erc20Factory, controller;
  let timestampAddition = 0;
  let sortedTokens;

  const fromWei = (_bn) => web3.utils.fromWei(toBN(_bn).toString(10));
  const toWei = (_bn) => web3.utils.toWei(toBN(_bn).toString(10));
  const decToWeiHex = (dec) => {
    let str = String(dec);
    if (str.includes('.')) {
      const comps = str.split('.');
      if (comps[1].length > 18) {
        str = `${comps[0]}.${comps[1].slice(0, 18)}`;
      }
    }
    return `0x` + new BN(web3.utils.toWei(str)).toString('hex');
  }

  const getTimestamp = () => Math.floor(new Date().getTime() / 1000) + timestampAddition;
  const increaseTimeByDays = (n = 3.5) => {
    timestampAddition += n * 24 * 60 * 60;
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
    await bre.run('deploy_controller');
    ({
      from,
      uniswapFactory,
      uniswapRouter,
      weth,
      uniswapOracle,
      controller,
      shortUniswapOracle
    } = bre.config.deployed);
    await bre.run('approve_deployers');
    [from] = await web3.eth.getAccounts();
  });

  async function deployToken(tokenObj) {
    const { name, symbol } = tokenObj;
    const token = await erc20Factory.deploy(name, symbol);
    tokenObj.token = token;
    tokenObj.address = token.address;
  }

  async function getFreeWeth(to, amount) {
    await weth.deposit({value: amount});
    if (to && to != from) {
      await weth.transfer(to, amount).send({ from: this.from });
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
    
    await weth.approve(uniswapRouter.options.address, amountWeth).then(r => r.wait());
    const timestamp = getTimestamp() + 1000;
    await uniswapRouter.methods.addLiquidity(
      token.address,
      weth.address,
      amountToken,
      amountWeth,
      amountToken,
      amountWeth,
      from,
      timestamp
    ).send({ from });
  }

  async function addLiquidityAll() {
    for (let i = 0; i < wrappedTokens.length; i++) {
      const { token, initialPrice } = wrappedTokens[i];
      // In order to update the cumulative prices on the market pairs,
      // we need to add some more liquidity (could also execute trades)
      await addTokenLiquidity(token, initialPrice, 50);
    }
  }

  /**
   * Deploy a market pair for (token, weth) and initialize it with liquidity.
   * @param tokenObj - object with token data
   * @param liquidity - amount of tokens to give as liquidity
   */
  async function createTokenMarket(tokenObj, liquidity) {
    const { address, initialPrice, token } = tokenObj;
    const result = await uniswapFactory.methods.createPair(address, weth.address).send({ from });
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
    it('Should create a wrapped tokens category', async () => {
      const metadata = {
        name: 'Wrapped Tokens',
        description: 'Category for wrapped tokens.'
      };
      const metadataHash = keccak256(JSON.stringify(metadata));
      const receipt = await controller.createCategory(metadataHash);
      const { events } = await receipt.wait();
      expect(events.length).to.eql(1);
      const [event] = events;
      expect(event.event).to.eql('CategoryAdded');
      expect(event.args.metadataHash).to.eql(metadataHash);
      expect(event.args.categoryID.toNumber()).to.eql(1);
    });

    it('Should add tokens to the wrapped tokens category', async () => {
      await controller.addTokens(1, wrappedTokens.map(t => t.address)).then(r => r.wait());
    });

    it('Should query the category tokens', async () => {
      const tokens = await controller.getCategoryTokens(1);
      expect(tokens).to.deep.equal(wrappedTokens.map(t => t.address));
    });

    it('Should fail to return a price if the latest price is not old enough', async () => {
      const [token] = await controller.getCategoryTokens(1);
      expect(
        uniswapOracle.computeAveragePrice(token)
      ).to.be.rejectedWith(/ERR_USABLE_PRICE_NOT_FOUND/g)
    });

    it('Should update the block timestamp', async () => {
      await increaseTimeByDays();
      await uniswapOracle.updatePrices(wrappedTokens.map(t => t.address));
    });

    it('Should return the correct market caps', async () => {
      const caps = [];
      for (let i = 0; i < wrappedTokens.length; i++) {
        const { address, token, initialPrice } = wrappedTokens[i];
        // In order to update the cumulative prices on the market pairs,
        // we need to add some more liquidity (could also execute trades)
        await addTokenLiquidity(token, initialPrice, 50);
        const expectedMarketCap = nTokens(150 * initialPrice);
        const realMarketCap = await controller.computeAverageMarketCap(address)
          .then(toBN);
        const pct = realMarketCap.div(expectedMarketCap);
        expect(pct.eqn(1)).to.be.true;
        caps.push(realMarketCap.toString('hex'));
      }
      const categoryCaps = await controller.getCategoryMarketCaps(1);
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
      const tokens = await controller.getCategoryTokens(id);
      const marketCaps = await controller.getCategoryMarketCaps(id);
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
      sortedTokens = categorySorted.map((t) => t.token);
      const receipt = await controller.orderCategoryTokensByMarketCap(
        1, sortedTokens
      ).then((r) => r.wait());
      const categoryAfterSort = await getCategoryData(1);
      expect(
        mapToHex(categoryAfterSort.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCapsSorted));
      console.log(`Cost To Sort Tokens: ${toBN(receipt.cumulativeGasUsed).toNumber()}`)
    });
  });

  describe('Pool Queries', async () => {
    it('getInitialTokensAndBalances()', async () => {
      const prices = [10, 2, 1];
      const marketCapsSqrts = [10, 2, 1].map(n => Math.sqrt(n * 150));
      const sqrtSum = marketCapsSqrts.reduce((a, b) => a+b, 0);
      const normWeights = marketCapsSqrts.map(m => m / sqrtSum);
      const ethValues = normWeights.map(w => w * 10);
      const balances = ethValues.map((v, i) => v / prices[i]);
      const { balances: targets } = await controller.getInitialTokensAndBalances(
        1,
        3,
        nTokensHex(10)
      );
      for (let i = 0; i < 3; i++) {
        const diff = calcRelativeDiff(balances[i], fromWei(targets[i]));
        expect(+diff).to.be.lte(errorDelta)
      }
    });
  })

  describe('Pool Deployment', async () => {
    let pool;
    it('prepareIndexPool()', async () => {
      const receipt = await controller.prepareIndexPool(
        1,
        3,
        nTokensHex(10),
        'Wrapped Tokens Top 3 Index',
        'WTI3'
      ).then(r => r.wait());

      const poolEvent = receipt.events.filter(e => e.event == 'NewDefaultPool')[0];
      expect(poolEvent).to.not.be.null;

      const { pool: _pool, controller: ctrlAddress } = poolEvent.args;
      expect(ctrlAddress).to.eq(controller.address);

      const initializerEvent = receipt.events.filter(e => e.event == 'NewPoolInitializer')[0];
      expect(initializerEvent).to.not.be.null;

      const {
        poolAddress,
        initializerAddress,
        categoryID,
        indexSize
      } = initializerEvent.args;
      expect(poolAddress).to.eq(_pool);
      const expectedInitializerAddress = await controller.computeInitializerAddress(
        poolAddress
      );
      expect(initializerAddress).to.eq(expectedInitializerAddress);
      expect(categoryID).to.eq('1');
      expect(indexSize).to.eq('3');
      pool = await ethers.getContractAt('IPool', poolAddress);
      initializer = await ethers.getContractAt('PoolInitializer', initializerAddress);
    });

    it('Does not make the pool public', async () => {
      const public = await pool.isPublicSwap();
      expect(public).to.eq(false);
    });
  });
    
  describe('Pool Initializer', async () => {
    it('getDesiredTokens()', async () => {
      const desiredTokens = await initializer.getDesiredTokens();
      expect(desiredTokens).to.deep.equal(sortedTokens);
    });

    it('getDesiredAmounts()', async () => {
      const prices = [10, 2, 1];
      const marketCapsSqrts = [10, 2, 1].map(n => Math.sqrt(n * 150));
      const sqrtSum = marketCapsSqrts.reduce((a, b) => a+b, 0);
      const normWeights = marketCapsSqrts.map(m => m / sqrtSum);
      const ethValues = normWeights.map(w => w * 10);
      const balances = ethValues.map((v, i) => v / prices[i]);
      const targets = await initializer.getDesiredAmounts(sortedTokens);
      for (let i = 0; i < 3; i++) {
        const diff = calcRelativeDiff(balances[i], fromWei(targets[i]));
        expect(+diff).to.be.lte(errorDelta)
      }
    });

    it('Updates token markets & oracle', async () => {
      await addLiquidityAll();
      await shortUniswapOracle.updatePrices(wrappedTokens.map(t => t.address));
      await increaseTimeByDays(1 / 24);
      await addLiquidityAll();
    });

    it('getCreditForTokens()', async () => {
      for (let t of wrappedTokens) {
        const desiredAmount = fromWei(
          await initializer.getDesiredAmount(t.address)
        );
        const expected = t.initialPrice * (+desiredAmount);
        const actual = fromWei(
          await initializer.getCreditForTokens(t.address, decToWeiHex(desiredAmount))
        );
        const diff = calcRelativeDiff(expected, actual);
        expect(+diff).to.be.lte(errorDelta);
      }
    });
  });
});
