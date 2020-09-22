const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);

const BN = require('bn.js');
const Decimal = require('decimal.js');
const bre = require("@nomiclabs/buidler");

const { wrapped_tokens: wrappedTokens } = require('./testData/categories.json');

const { nTokensHex, nTokens } = require('./lib/tokens');

const { expect } = chai;

const toBN = (bn) => BN.isBN(bn) ? bn : bn._hex ? new BN(bn._hex.slice(2), 'hex') : new BN(bn);

describe('UnboundTokenSeller.sol', async () => {
  let pool, seller, marketOracle, erc20Factory;
  let uniswapFactory, uniswapRouter, weth, from;
  let timestampAddition = 0;
  let tokens;
  let premiumPercent;

  const getTimestamp = () => Math.floor(new Date().getTime() / 1000) + timestampAddition;
  const increaseTimeBySeconds = (seconds) => {
    timestampAddition += seconds;
    const timestamp = getTimestamp();
    return web3.currentProvider._sendJsonRpcRequest({
      method: "evm_setNextBlockTimestamp",
      params: [timestamp],
      jsonrpc: "2.0",
      id: new Date().getTime()
    });
  };

  const fromWei = (_bn) => web3.utils.fromWei(toBN(_bn).toString(10));
  const toWei = (_bn) => web3.utils.toWei(toBN(_bn).toString(10));

  before(async () => {
    premiumPercent = 2;
    erc20Factory = await ethers.getContractFactory("MockERC20");
    await bre.run('deploy_short_term_uniswap_oracle');
    ({
      from,
      uniswapFactory,
      uniswapRouter,
      weth,
      shortUniswapOracle: marketOracle
    } = bre.config.deployed);
    [from] = await web3.eth.getAccounts();
    const UnboundTokenSeller = await ethers.getContractFactory('UnboundTokenSeller');
    seller = await UnboundTokenSeller.deploy(
      uniswapRouter.options.address,
      marketOracle.address,
      from
    );
    const MockPool = await ethers.getContractFactory('MockUnbindSourcePool');
    pool = await MockPool.deploy(seller.address);
    await seller.initialize(pool.address, premiumPercent);
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

  function calcOutGivenIn(tokenObjIn, tokenObjOut, amountIn) {
    const valueIn = nTokens(amountIn * tokenObjIn.initialPrice);
    const valueOut = valueIn.muln(100).divn(100 - premiumPercent);
    const amountOut = valueOut.divn(tokenObjOut.initialPrice);
    return amountOut;
  }

  function calcInGivenOut(tokenObjIn, tokenObjOut, amountOut) {
    const valueOut = nTokens(amountOut * tokenObjOut.initialPrice);
    const valueIn = valueOut.muln(100 - premiumPercent).divn(100);
    const amountIn = valueIn.divn(tokenObjIn.initialPrice);
    return amountIn;
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
      await marketOracle.updatePrices(tokens);
      await increaseTimeBySeconds(60 * 60);
      for (let token of wrappedTokens) {
        await addTokenLiquidity(token.token, token.initialPrice, 50);
      }
    });

    it('Should add the tokens to the mock pool', async () => {
      for (let token of wrappedTokens) {
        const amount = nTokens(10000).divn(token.initialPrice);
        await token.token.getFreeTokens(from, `0x${amount.toString('hex')}`);
        await token.token.approve(pool.address, `0x${amount.toString('hex')}`);
        await pool.addToken(
          token.address,
          nTokensHex(10),
          `0x${amount.toString('hex')}`
        );
      }
    });
  });

  describe('Unbind tokens', async () => {
    let token;
    before(() => {
      token = wrappedTokens[0];
    });

    it('Unbinds a token on the pool', async () => {
      const receipt = await pool.unbind(token.address).then(r => r.wait());
      const event = receipt.events[1];
      expect(event.eventSignature).to.eq('NewTokensToSell(address,uint256)');
      expect(event.args.token).to.eq(token.address);
      const amount = nTokens(10000).divn(token.initialPrice);
      console.log(amount);
      console.log(token.initialPrice)
      expect(
        event.args.amountReceived._hex.toString()
      ).to.eq(
        '0x' + amount.toString('hex')
      );
    });

    it('calcInGivenOut', async () => {
      const output = token;
      for (let input of wrappedTokens.slice(1)) {
        const expected = calcInGivenOut(input, output, 100);
        const actual = await seller.calcInGivenOut(
          input.address,
          output.address,
          nTokensHex(100)
        );
        expect(toBN(actual).toString('hex')).to.eq(expected.toString('hex'));
      }
    });

    it('calcOutGivenIn', async () => {
      const output = token;
      for (let input of wrappedTokens.slice(1)) {
        const expected = calcOutGivenIn(input, output, 10);
        const actual = await seller.calcOutGivenIn(
          input.address,
          output.address,
          nTokensHex(10)
        );
        expect(toBN(actual).toString('hex')).to.eq(expected.toString('hex'));
      }
    });
  });
});