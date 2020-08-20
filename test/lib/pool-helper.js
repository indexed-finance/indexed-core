const { calcSpotPrice, calcOutGivenIn, calcSingleInGivenPoolOut, calcInGivenOut } = require("./calc_comparisons");
const { default: Decimal } = require("decimal.js");

module.exports = class PoolHelper {
  /* token objects should have { address, price, totalSupply, balance } */
  /* numbers should be js numbers in standard format, i.e. 10 instead of 1e19 */
  constructor(token_objects, swapFee, blockTimestamp) {
    this.swapFee = swapFee;
    this.timestamp = blockTimestamp;
    this.tokens = [];
    this.records = {};
    this.marketCaps = {};
    this.poolSupply = Decimal(100);
    for (let token of token_objects) {
      const { address, price, totalSupply, balance } = token;
      this.tokens.push(address);
      this.records[address] = {
        balance,
        marketCap: totalSupply * price,
        lastDenormUpdate: blockTimestamp,
        totalSupply: Decimal(totalSupply),
        price
      }
    }
    this.setDesiredWeights();
    for (let token of this.tokens) {
      const record = this.records[token];
      record.denorm = record.desiredDenorm;
    }
  }

  setDesiredWeights() {
    const marketCaps = this.tokens.map(a => {
      const { totalSupply, price } = this.records[a];
      return (this.records[a].marketCap = totalSupply.mul(price));
    });
    const marketCapSqrts = marketCaps.map(m => Math.sqrt(m));
    const sqrtSum = marketCapSqrts.reduce((a, b) => a + b, 0);
    let weights = marketCapSqrts.map(m => 25 * m / sqrtSum);
    this.totalWeight = weights.reduce((a, b) => a+b, 0);
    for (let i = 0; i < marketCaps.length; i++) {
      this.records[this.tokens[i]].desiredDenorm = weights[i];
    }
  }

  updateWeights() {
    for (let address of this.tokens) this.updateWeight(address)
  }

  calcUpdatedWeight(address) {
    const record = this.records[address];
    let oldWeight = record.denorm;
    let desiredDenorm = record.desiredDenorm;
    if (oldWeight == desiredDenorm) return;
    const maxDiff = oldWeight * this.swapFee;
    let denorm = desiredDenorm;
    const realDiff = desiredDenorm - oldWeight;

    if (Math.abs(realDiff) > maxDiff) {
      if (realDiff > 0) denorm = oldWeight + maxDiff;
      else denorm = oldWeight - maxDiff;
    }
    return denorm;
  }

  updateWeight(address) {
    this.records[address].denorm = this.calcUpdatedWeight(address)
  }

  setBlockTimestamp(blockTimestamp) {
    this.timestamp = blockTimestamp;
  }

  calcSpotPrice(tokenIn, tokenOut) {
    const { denorm: dI, balance: bI } = this.records[tokenIn];
    const { denorm: dO, balance: bO } = this.records[tokenOut];
    return calcSpotPrice(bI, dI, bO, dO, this.swapFee);
  }

  calcOutGivenIn(tokenIn, tokenOut, tokenAmountIn, updateWeightAfter = false) {
    let { denorm: dI, balance: bI } = this.records[tokenIn];
    let { denorm: dO, balance: bO } = this.records[tokenOut];
    const amountOut = calcOutGivenIn(bI, dI, bO, dO, tokenAmountIn, this.swapFee);
    if (updateWeightAfter) {
      dI = this.calcUpdatedWeight(tokenIn);
      dO = this.calcUpdatedWeight(tokenOut);
    }
    const spotPriceAfter = calcSpotPrice(
      Decimal(bI).plus(Decimal(tokenAmountIn)),
      dI,
      Decimal(bO).sub(Decimal(amountOut)),
      dO,
      this.swapFee
    );
    return [amountOut, spotPriceAfter];
  }

  calcInGivenOut(tokenIn, tokenOut, tokenAmountOut, updateWeightAfter = false) {
    let { denorm: dI, balance: bI } = this.records[tokenIn];
    let { denorm: dO, balance: bO } = this.records[tokenOut];
    const amountIn = calcInGivenOut(bI, dI, bO, dO, tokenAmountOut, this.swapFee);
    if (updateWeightAfter) {
      dI = this.calcUpdatedWeight(tokenIn);
      dO = this.calcUpdatedWeight(tokenOut);
    }
    const spotPriceAfter = calcSpotPrice(
      Decimal(bI).plus(Decimal(amountIn)),
      dI,
      Decimal(bO).sub(Decimal(tokenAmountOut)),
      dO,
      this.swapFee
    );
    return [amountIn, spotPriceAfter];
  }
  
  calcPoolOutGivenSingleIn(tokenIn, tokenAmountIn) {
    const { denorm: dI, balance: bI } = this.records[tokenIn];
    return calcPoolOutGivenSingleIn(bI, dI, this.poolSupply, this.totalWeight, tokenAmountIn, this.swapFee);
  }

  calcSingleInGivenPoolOut(tokenIn, poolAmountOut) {
    const { denorm: dI, balance: bI } = this.records[tokenIn];
    return calcSingleInGivenPoolOut(bI, dI, this.poolSupply, this.totalWeight, poolAmountOut, this.swapFee);
  }
}