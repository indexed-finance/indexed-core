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
        price,
        ready: true
      }
    }
    this.setDesiredWeights();
    for (let token of this.tokens) {
      const record = this.records[token];
      record.denorm = record.desiredDenorm;
    }
  }

  getTotalValue() {
    const [token] = this.tokens;
    const { balance, price, denorm } = this.records[token];
    return (this.totalWeight / denorm) * balance * price;
  }

  addToken(tokenObj) {
    const { totalSupply, address, price } = tokenObj;
    this.tokens.push(address);
    this.records[address] = {
      balance: 0,
      marketCap: totalSupply * price,
      totalSupply,
      price,
      ready: false
    };
    this.setDesiredWeights();
    const totalValue = this.getTotalValue();
    this.records[address].minimumBalance = Decimal((totalValue / 25) / price);
  }

  setDesiredWeights() {
    const marketCaps = this.tokens.map(a => {
      const { totalSupply, price } = this.records[a];
      return (this.records[a].marketCap = Decimal(totalSupply).mul(price));
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

  calcWeightIncrease(address) {
    const record = this.records[address];
    let oldWeight = record.denorm;
    let desiredDenorm = record.desiredDenorm;
    if (oldWeight >= desiredDenorm) return oldWeight;
    let denorm = desiredDenorm;
    const maxDiff = oldWeight * this.swapFee / 2;
    let diff = desiredDenorm - oldWeight;
    if (diff > maxDiff) denorm = oldWeight + maxDiff;
    return denorm;
  }

  calcWeightDecrease(address) {
    const record = this.records[address];
    const oldWeight = record.denorm;
    const desiredDenorm = record.desiredDenorm;
    if (oldWeight <= desiredDenorm) return oldWeight;
    let denorm = desiredDenorm;
    const maxDiff = oldWeight * this.swapFee / 2;
    const diff = oldWeight - desiredDenorm;
    if (diff > maxDiff) denorm = oldWeight - maxDiff;
    return denorm;
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
    let { denorm: dI, balance: bI, ready: rI, minimumBalance: mbI } = this.records[tokenIn];
    let rbI = bI;
    if (!rI) {
      dI = this.totalWeight / 25;
      bI = mbI;
    }
    let { denorm: dO, balance: bO, ready: rO } = this.records[tokenOut];
    if (!rO) throw new Error('Out token not ready.');
    const amountOut = calcOutGivenIn(bI, dI, bO, dO, tokenAmountIn, this.swapFee);
    if (tokenAmountIn > bI / 2) throw new Error('Exceeds max in ratio');
    if (amountOut > bO / 3) throw new Error('Exceeds max out ratio');
    if (updateWeightAfter) {
      if (!rI) {
        if (rbI + tokenAmountIn >= mbI) {
          bI = Decimal(rbI).plus(Decimal(tokenAmountIn))
          dI += dI * this.swapFee / 2;
        }
      } else {
        dI = this.calcWeightIncrease(tokenIn);
        bI = Decimal(rbI).plus(Decimal(tokenAmountIn))
      }
      dO = this.calcWeightDecrease(tokenOut);
    } else {
      bI = Decimal(rbI).plus(Decimal(tokenAmountIn));
    }
    bO = Decimal(bO).sub(Decimal(amountOut))
    const spotPriceAfter = calcSpotPrice(
      Decimal(bI),
      dI,
      bO,
      dO,
      this.swapFee
    );
    return [amountOut, spotPriceAfter];
  }

  calcInGivenOut(tokenIn, tokenOut, tokenAmountOut, updateWeightAfter = false) {
    let { denorm: dI, balance: bI, ready: rI, minimumBalance: mbI } = this.records[tokenIn];
    let rbI = bI;
    if (!rI) {
      dI = this.totalWeight / 25;
      bI = mbI;
    }
    let { denorm: dO, balance: bO, ready: rO } = this.records[tokenOut];
    if (!rO) throw new Error('Out token not ready.');
    const amountIn = calcInGivenOut(bI, dI, bO, dO, tokenAmountOut, this.swapFee);
    if (updateWeightAfter) {
      if (!rI) {
        if (rbI + amountIn >= mbI) {
          bI = Decimal(rbI).plus(Decimal(amountIn));
          dI += dI * this.swapFee / 2;
        }
      } else {
        dI = this.calcWeightIncrease(tokenIn);
        bI = Decimal(rbI).plus(Decimal(amountIn))
      }
      dO = this.calcWeightDecrease(tokenOut);
    } else {
      bI = Decimal(rbI).plus(Decimal(amountIn));
    }
    bO = Decimal(bO).sub(Decimal(tokenAmountOut));
    
    const spotPriceAfter = calcSpotPrice(
      Decimal(bI),
      dI,
      bO,
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