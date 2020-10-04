const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
const { soliditySha3 } = require('web3-utils');
const BN = require('bn.js');
const bre = require("@nomiclabs/buidler");

const { deployments, ethers } = bre;

const { wrapped_tokens: wrappedTokens } = require('./testData/categories.json');
const { nTokensHex } = require('./lib/tokens');

chai.use(chaiAsPromised);
const { expect } = chai;

const keccak256 = (data) => soliditySha3(data);
const toBN = (bn) => new BN(bn._hex.slice(2), 'hex');

describe("UniSwapV2PriceOracle.sol", () => {
  let uniswapFactory, uniswapRouter, weth;
  let from, marketOracle;
  let erc20Factory, tokens;
  let timestampAddition = 0;

  before(async () => {
    erc20Factory = await ethers.getContractFactory("MockERC20");
    await deployments.fixture();
    uniswapFactory = await ethers.getContract('uniswapFactory');
    uniswapRouter = await ethers.getContract('uniswapRouter');
    weth = await ethers.getContract('weth');
    marketOracle = await ethers.getContract('WeeklyTWAPUniSwapV2Oracle');
    [from] = await web3.eth.getAccounts();
  });

  async function deployToken(tokenObj) {
    const { name, symbol } = tokenObj;
    const token = await erc20Factory.deploy(name, symbol);
    tokenObj.token = token;
    tokenObj.address = token.address;
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
    await token.approve(uniswapRouter.address, amountToken).then(r => r.wait());
    
    await weth.approve(uniswapRouter.address, amountWeth).then(r => r.wait())
    const timestamp = await bre.run('getTimestamp') + 1000;
    await uniswapRouter.addLiquidity(
      token.address,
      weth.address,
      amountToken,
      amountWeth,
      amountToken,
      amountWeth,
      from,
      timestamp
    );
  }

  /**
   * Deploy a market pair for (token, weth) and initialize it with liquidity.
   * @param tokenObj - object with token data
   * @param liquidity - amount of tokens to give as liquidity
   */
  async function createTokenMarket(tokenObj, liquidity) {
    const { address, initialPrice, token } = tokenObj;
    const receipt = await uniswapFactory.createPair(address, weth.address);
    const { events } = await receipt.wait();
    const { args: { pair } } = events.filter(e => e.event == 'PairCreated')[0];
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
      await bre.run('increaseTime', { days: 2 });
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
});
