const { BN, toBN } = require('./bn');
const { abi: IPoolABI } = require('../artifacts/BPool.json');
const { abi: Erc20ABI } = require('../artifacts/IERC20.json');

module.exports = class IndexFund {
  constructor(web3, address) {
    this.web3 = web3;
    this.pool = new web3.eth.Contract(IPoolABI, address);
    this.fromWei = (_bn) => web3.utils.fromWei(toBN(_bn).toString(10));
    this.toWei = (_bn) => web3.utils.toWei(toBN(_bn).toString(10));
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
      arr.push({ address, balance, contract, desiredWeight, weight });
    }
    return arr;
  }
}