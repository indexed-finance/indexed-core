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

describe("UniSwapV2PriceOracle.sol", () => {
  let uniswapFactory, uniswapRouter, weth;
  let from, marketOracle;
  let erc20Factory, tokens;
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
    await bre.run('deploy_uniswap_oracle');
    ({
      from,
      uniswapFactory,
      uniswapRouter,
      weth,
      uniswapOracle: marketOracle
    } = bre.config.deployed);
    [from] = await web3.eth.getAccounts();
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
    await weth.getFreeTokens(from, amountWeth).then(r => r.wait());;
    await token.approve(uniswapRouter.options.address, amountToken).then(r => r.wait());
    
    await weth.approve(uniswapRouter.options.address, amountWeth).then(r => r.wait())
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
      tokens = wrappedTokens.map(t => t.address);
    });

    it('Should deploy the wrapped token market pairs', async () => {
      for (let i = 0; i < wrappedTokens.length; i++) {
        await createTokenMarket(wrappedTokens[i], 100);
      }
    });
  });

  describe('Prices', async () => {

    it('updatePrices()', async () => {
      await marketOracle.updatePrices(tokens);
    });
  
    it('Fails to query when the price is too new', async () => {
      await expect(
        marketOracle.computeAverageAmountOut(tokens[0], 500)
      ).to.be.rejectedWith(/ERR_USABLE_PRICE_NOT_FOUND/g);
    });
  
    it('computeAverageAmountOut()', async () => {
      await increaseTimeByOnePeriod();
      for (let i = 0; i < wrappedTokens.length; i++) {
        const { address, token, initialPrice } = wrappedTokens[i];
        // In order to update the cumulative prices on the market pairs,
        // we need to add some more liquidity (could also execute trades)
        await addTokenLiquidity(token, initialPrice, 50);
        await marketOracle.updatePrice(address);
        const expected = nTokensHex(initialPrice * 100);
        const actual = await marketOracle.computeAverageAmountOut(
          address,
          nTokensHex(100)
        );
        expect(`0x${toBN(actual).toString('hex')}`).to.eq(expected);
      }
    });
  
    it('computeAverageAmountsOut()', async () => {
      const amountsOut = await marketOracle.computeAverageAmountsOut(
        tokens,
        Array(tokens.length).fill(nTokensHex(100))
      );
      const expected = wrappedTokens.map(({ initialPrice }) => nTokensHex(initialPrice * 100));
      const actual = amountsOut.map(a => `0x${toBN(a).toString('hex')}`);
      expect(expected).to.deep.eq(actual);
    });
  });

  // describe('Sort Tokens', async () => {
  //   const mapToHex = (arr) => arr.map((i) => i.toString('hex'));
  //   const sortArr = (arr) => arr.sort((a, b) => {
  //     if (a.marketCap.lt(b.marketCap)) return 1;
  //     if (a.marketCap.gt(b.marketCap)) return -1;
  //     return 0;
  //   });

  //   async function getCategoryData(id) {
  //     const tokens = await marketOracle.getCategoryTokens(id);
  //     const marketCaps = await marketOracle.getCategoryMarketCaps(id);
  //     const arr = [];
  //     for (let i = 0; i < tokens.length; i++) {
  //       arr.push({
  //         token: tokens[i],
  //         marketCap: toBN(marketCaps[i])
  //       });
  //     }
  //     return arr;
  //   }

  //   it('Should sort the tokens and update the category', async () => {
  //     const category = await getCategoryData(1);
  //     const marketCaps = [10, 1, 2].map(n => nTokens(n * 150));
  //     expect(
  //       mapToHex(category.map((t) => t.marketCap))
  //     ).to.deep.equal(mapToHex(marketCaps));
  //     const categorySorted = sortArr(category);
  //     const marketCapsSorted = [10, 2, 1].map(n => nTokens(n * 150));
  //     expect(
  //       mapToHex(categorySorted.map((t) => t.marketCap))
  //     ).to.deep.equal(mapToHex(marketCapsSorted));
  //     const receipt = await marketOracle.orderCategoryTokensByMarketCap(
  //       1, categorySorted.map((t) => t.token)
  //     ).then((r) => r.wait());
  //     const categoryAfterSort = await getCategoryData(1);
  //     expect(
  //       mapToHex(categoryAfterSort.map((t) => t.marketCap))
  //     ).to.deep.equal(mapToHex(marketCapsSorted));
  //     console.log(`Cost To Sort Tokens: ${toBN(receipt.cumulativeGasUsed).toNumber()}`)
  //   });
  // });
});
