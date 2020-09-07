const { setupUniSwapV2 } = require('./uniswap-setup');
const { nTokens, nTokensHex } = require('./tokens');

const defaultGetTimestamp = () => new Date().getTime() / 1000;

class UniswapHelper {
  constructor(web3, from, erc20Factory, getTimestamp = defaultGetTimestamp) {
    this.web3 = web3;
    this.from = from;
    this.tokens = [];
    this.tokenIndices = {}
    this.erc20Factory = erc20Factory;
    this.getTimestamp = getTimestamp;
  }

  async init() {
    /* {
      uniswapFactory,
      uniswapRouter,
      weth
    } */
    const contracts = await setupUniSwapV2(this.web3, this.from);
    Object.assign(this, contracts);
    // this.stablecoin = await this.erc20Factory.deploy("DAI Stablecoin", "DAI");
  }

  getToken(symbol) {
    const tokenIndex = this.tokenIndices[symbol];
    return this.tokens[tokenIndex];
  }

  getTokenByAddress(address) {
    for (let token of this.tokens ) {
      if (token.address == address) return token;
    }
  }

  async getFreeWeth(to, amount) {
    await this.weth.methods.deposit().send({
      from: this.from,
      value: amount
    });
    if (to && to != this.from) {
      await this.weth.methods.transfer(to, amount).send({ from: this.from });
    }
  }

  /**
   * Add liquidity to uniswap market pair for a token and weth
   * @param price Amount of weth per token
   * @param liquidity Amount of tokens to add
   */
  async addTokenLiquidity(symbol, price, liquidity) {
    const token = this.getToken(symbol).token;
    const amountToken = nTokensHex(liquidity);
    const amountWeth = nTokensHex(liquidity * price);
    await token.getFreeTokens(this.from, amountToken).then(r => r.wait && r.wait());
    await this.getFreeWeth(this.from, amountWeth);
    // await this.weth.getFreeTokens(this.from, amountWeth).then(r => r.wait && r.wait());
    await token.approve(this.uniswapRouter.options.address, amountToken).then(r => r.wait && r.wait());
    await this.weth.methods.approve(this.uniswapRouter.options.address, amountWeth).send({ from: this.from });
    const timestamp = this.getTimestamp() + 1000;
    await this.uniswapRouter.methods.addLiquidity(
      token.address,
      this.weth.options.address,
      amountToken,
      amountWeth,
      amountToken,
      amountWeth,
      this.from,
      timestamp
    ).send({ from: this.from });
  }

  // Deploys an ERC20 and creates a uniswap market between it
  // and weth
  async deployTokenAndMarket(name, symbol, initialPrice, liquidity) {
    const token = await this.erc20Factory.deploy(name, symbol);
    // const { address, initialPrice, token } = tokenObj;
    const result = await this.uniswapFactory.methods.createPair(
      token.address,
      this.weth.options.address
    ).send({ from: this.from });
    const { pair } = result.events.PairCreated.returnValues;
    const tokenObj = {
      initialPrice,
      name,
      symbol,
      token,
      pair,
      address: token.address
    };
    const index = this.tokens.length;
    this.tokens.push(tokenObj);
    this.tokenIndices[symbol] = index;
    console.log(`Added ${symbol} to index ${index}`)
    await this.addTokenLiquidity(symbol, initialPrice, liquidity);
    return tokenObj;
  }
}

module.exports = UniswapHelper