const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
const BN = require('bn.js');
const bre = require("@nomiclabs/buidler");

const { deployments, ethers } = bre;

const { nTokensHex } = require('./lib/tokens');
const { addLiquidity } = require("./lib/uniswap");

chai.use(chaiAsPromised);
const { expect } = chai;

const toBN = (bn) => new BN(bn._hex.slice(2), 'hex');

describe("UniSwapV2PriceOracle.sol", () => {
  let marketOracle;
  let tokens;
  let wrappedTokens;

  before(async () => {
    erc20Factory = await ethers.getContractFactory("MockERC20");
    await deployments.fixture(['Core', 'Mocks']);
    wrappedTokens = [...bre.config.wrappedTokens];
    uniswapFactory = await ethers.getContract('uniswapFactory');
    uniswapRouter = await ethers.getContract('uniswapRouter');
    weth = await ethers.getContract('weth');
    marketOracle = await ethers.getContract('WeeklyTWAPUniSwapV2Oracle');
    ([from] = await web3.eth.getAccounts());
    tokens = wrappedTokens.map(t => t.address);
  });

  describe('Initialize Token Markets', async () => {
    it('Should add liquidity to the markets', async () => {
      for (let token of wrappedTokens) {
        await addLiquidity(token.address, token.initialPrice, 100);
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
        await addLiquidity(address, initialPrice, 50);
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
