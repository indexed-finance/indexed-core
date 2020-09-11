const { BN, toBN } = require('./bn');
const { abi: IPoolABI } = require('../artifacts/BPool.json');
const { abi: Erc20ABI } = require('../artifacts/IERC20.json');
const { getERC20 } = require('./erc20');

module.exports = class IndexFund {
  constructor(web3, from, poolAddress, uniswap) {
    this.web3 = web3;
    this.from = from;
    this.pool = new web3.eth.Contract(IPoolABI, poolAddress);
    this.fromWei = (_bn) => web3.utils.fromWei(toBN(_bn).toString(10));
    this.toWei = (_bn) => web3.utils.toWei(toBN(_bn).toString(10));
    this.uniswap = uniswap;
  }

  /**
   * Amount should be a normalized (i.e. actual / 1e18) js number.
   */
  async mintFreeTokens(amount) {
    const totalSupply = this.fromWei(
      await this.pool.methods.totalSupply().call()
    );
    const ratio = amount / totalSupply;
    const underlying = await this.getTokensAndWeights();
    const maxAmountsIn = [];
    for (let t of underlying) {
      let bal = t.ready ? t.balance : t.minimumBalance;
      const maxAmount = this.toWei(bal * ratio);
      const token = getERC20(this.web3, t.address);
      await token.methods.getFreeTokens(maxAmount).send({ from: this.from });
      maxAmountsIn.push(maxAmount);
    }
    await this.pool.methods.joinPool(
      this.toWei(amount),
      maxAmountsIn
    ).send({ from: this.from });
  }

  async addUniswapWethLiquidity(price, liquidity) {
    const address = this.pool.options.address;
    const pair = await this.uniswap.getWethPair(address);
    let exists = await this.web3.eth.getCode(pair);
    exists = exists && exists != '0x';
    if (!exists) await this.uniswap.deployMarket(address);
    await this.mintFreeTokens(liquidity);
    await this.uniswap.addPoolMarketLiquidity(poolAddress, price, liquidity);
  }

  async getTokenAddresses() {
    const tokens = await this.pool.methods.getCurrentTokens().call();
    this.tokens = tokens;
    const arr = [];
    for (let token of tokens) {
      arr.push({
        address: token,
        contract: new this.web3.eth.Contract(Erc20ABI, token)
      });
    }
    return arr;
  }

  async getTokensAndWeights() {
    if (!this.tokens) await this.getTokenAddresses();
    const records = await Promise.all(
      this.tokens.map(
        token => this.pool.methods.getTokenRecord(token).call()
      )
    );
    let totalWeight = await this.pool.methods.getTotalDenormalizedWeight().call();
    totalWeight = this.fromWei(totalWeight);
    const arr = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const address = this.tokens[i];
      const contract = new this.web3.eth.Contract(Erc20ABI, address);
      let { balance, denorm, desiredDenorm } = record;
      balance = this.fromWei(balance);
      const weight = this.fromWei(denorm) / totalWeight;
      const desiredWeight = this.fromWei(desiredDenorm) / totalWeight;
      let minimumBalance = 0;
      if (!record.ready) {
        minimumBalance = this.fromWei(
          await this.pool.methods.getMinimumBalance(address).call()
        );
      }
      arr.push({
        address,
        balance,
        contract,
        desiredWeight,
        weight,
        ready: record.ready,
        minimumBalance
      });
    }
    return arr;
  }
}