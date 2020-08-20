const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);

const createKeccakHash = require('keccak');
const BN = require('bn.js');
const Decimal = require('decimal.js');

const { nTokens, nTokensHex, oneToken } = require('./lib/tokens');
const { wrapped_tokens: wrappedTokens } = require('./testData/categories.json');
const { calcRelativeDiff } = require('./lib/calc_comparisons');
const PoolHelper = require('./lib/pool-helper');

const { expect } = chai;
const keccak256 = (data) => `0x${createKeccakHash('keccak256').update(data).digest().toString('hex')}`;

const toBN = (bn) => BN.isBN(bn) ? bn : bn._hex ? new BN(bn._hex.slice(2), 'hex') : new BN(bn);

const exitFee = 0;
const swapFee = 0.025;
const errorDelta = 10 ** -8;

describe('BPool', async () => {
  let poolHelper, from, indexPool, erc20Factory;
  let timestampAddition = 0;

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

  async function initializePool() {
    // deploy tokens and mint initial supply
    for (let i = 0; i < wrappedTokens.length; i++) {
      const { name, symbol, initialPrice } = wrappedTokens[i];
      const token = await erc20Factory.deploy(name, symbol);
      await token.getFreeTokens(from, nTokensHex(100000));
      const tokenObj = {
        initialPrice,
        name,
        symbol,
        token,
        address: token.address,
        totalSupply: 100000
      };
      wrappedTokens[i] = tokenObj;
    }

    const tokens = [];
    const denormWeights = [];
    const balances = [];
    for (let tokenObj of wrappedTokens) {
      const { initialPrice, token, address } = tokenObj;
      const totalSupply = Decimal(fromWei(await token.totalSupply()));
      const balance = 0;
      tokens.push({
        price: initialPrice,
        totalSupply,
        balance,
        address
      });
    }
    poolHelper = new PoolHelper(tokens, swapFee, 0);
    const totalValue = 100000;
    for (let token of tokens) {
      const { address } = token;
      const { denorm, price } = poolHelper.records[address];
      const balance = (totalValue * denorm) / price;
      denormWeights.push(decToWeiHex(denorm));
      balances.push(decToWeiHex(balance));
      poolHelper.records[address].balance = balance;
    }
    const BPoolFactory = await ethers.getContractFactory("BPool");
    indexPool = await BPoolFactory.deploy();
    for (let token of wrappedTokens) {
      await token.token.approve(indexPool.address, nTokensHex(100000))
    }
    await indexPool.initialize(
      from,
      "Test Pool",
      "TPI",
      wrappedTokens.map(t => t.address),
      balances,
      denormWeights
    );
  }

  async function getPoolData() {
    const tokens = await indexPool.getCurrentTokens();
    const denormalizedWeights = await Promise.all(tokens.map(t => indexPool.getDenormalizedWeight(t).then(toBN)));
    const balances = await Promise.all(tokens.map(t => indexPool.getBalance(t).then(toBN)));
    const denormTotal = await indexPool.getTotalDenormalizedWeight().then(toBN);
    const normalizedWeights = denormalizedWeights.map(
      (denorm) => Decimal(denorm.toString(10)).div(Decimal(denormTotal.toString(10)))
    );
    return {
      tokens,
      denormalizedWeights,
      balances,
      normalizedWeights
    };
  }

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

  before(async () => {
    [from] = await web3.eth.getAccounts();
    erc20Factory = await ethers.getContractFactory("MockERC20");
    await initializePool();
  });

  function getTokenByAddress(address) {
    for (let token of wrappedTokens) {
      if (token.address == address) return token;
    }
  }
  
  async function mintAndApprove(tokenAddress, amountHex) {
    const {token} = getTokenByAddress(tokenAddress);
    await token.getFreeTokens(from, amountHex);
    await token.approve(indexPool.address, amountHex);
    const amountDec = Decimal(fromWei(new BN(amountHex.slice(2), 'hex')));
    poolHelper.records[tokenAddress].totalSupply = poolHelper.records[tokenAddress].totalSupply.add(amountDec);
  }

  describe('Swap, Mint, Burn', async () => {
    let tokens, balances, normalizedWeights;
    before(async () => {
      ({ tokens, balances, normalizedWeights } = await getPoolData());
    })
  
    it('Returns the correct spot prices', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenOut == tokenIn) continue;
          const expected = poolHelper.calcSpotPrice(tokenIn, tokenOut);
          const actual = Decimal(
            fromWei(await indexPool.getSpotPrice(tokenIn, tokenOut))
          );
          const relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
        }
      }
    });
  
    it('swapExactAmountIn', async () => {
      const maxPrice = web3.utils.toTwosComplement(-1);
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        const tokenAmountIn = balances[i].divn(50);
        await mintAndApprove(tokenIn, '0x' + tokenAmountIn.toString('hex'));
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenOut == tokenIn) continue;
          const output = await indexPool.callStatic.swapExactAmountIn(
            tokenIn,
            `0x${tokenAmountIn.toString('hex')}`,
            tokenOut,
            0,
            maxPrice
          );
          const computed = poolHelper.calcOutGivenIn(tokenIn, tokenOut, fromWei(tokenAmountIn));
          let expected = computed[0];
          let actual = Decimal(fromWei(output[0]));
          let relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
          expected = computed[1];
          actual = fromWei(output[1]);
          relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
        }
      }
    });
  
    it('swapExactAmountOut', async () => {
      const maxPrice = web3.utils.toTwosComplement(-1);
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        const maxAmountIn = maxPrice;
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenOut == tokenIn) continue;
          const tokenAmountOut = balances[o].divn(50);
          const computed = poolHelper.calcInGivenOut(tokenIn, tokenOut, fromWei(tokenAmountOut));
          // increase the approved tokens by 1% because the math on the decimal -> bn
          // has minor rounding errors
          await mintAndApprove(tokenIn, decToWeiHex(computed[0].mul(1.01)));
          const output = await indexPool.callStatic.swapExactAmountOut(
            tokenIn,
            maxAmountIn,
            tokenOut,
            `0x${tokenAmountOut.toString('hex')}`,
            maxPrice,
          );
          // Check the token input amount
          let expected = computed[0];
          let actual = Decimal(fromWei(output[0]));
          let relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
          // Check the resulting spot price
          expected = computed[1];
          actual = fromWei(output[1]);
          relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
        }
      }
    });
  
    it('joinPool', async () => {
      let previousPoolBalance = '100';
      const maxPrice = web3.utils.toTwosComplement(-1);
      let poolAmountOut = '1';
      await indexPool.joinPool(toWei(poolAmountOut), [maxPrice, maxPrice, maxPrice]);
      let currentPoolBalance = Decimal(previousPoolBalance).plus(Decimal(poolAmountOut))
      for (let i = 0; i < tokens.length; i++) {
        const previousTokenBalance = fromWei(balances[i]);
        const balanceChange = (
          Decimal(poolAmountOut).div(Decimal(previousPoolBalance))
        ).mul(previousTokenBalance);
        const expected = Decimal(previousTokenBalance).plus(balanceChange);
        const actual = await indexPool.getBalance(tokens[i])
          .then(b => Decimal(fromWei(toBN(b))));
        const relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
      const poolBalance = await indexPool.totalSupply().then(s => Decimal(fromWei(s)));
      expect(poolBalance.equals(currentPoolBalance)).to.be.true;
      ({tokens, balances, denormalizedWeights, normalizedWeights} = await getPoolData());
      poolHelper.poolSupply = poolHelper.poolSupply.add(poolAmountOut);
    });
  
    it('exitPool', async () => {
      const pAi = 1 / (1 - exitFee);
      const pAiAfterExitFee = pAi * (1 - exitFee);
      await indexPool.exitPool(toWei(String(pAi)), [0, 0, 0]);
      const previousPoolBalance = '101';
      const currentPoolBalance = Decimal(previousPoolBalance).sub(Decimal(pAiAfterExitFee));
      for (let i = 0; i < tokens.length; i++) {
        const previousTokenBalance = fromWei(balances[i]);
        const balanceChange = (
          Decimal(pAiAfterExitFee).div(Decimal(previousPoolBalance))
        ).mul(previousTokenBalance);
        const expected = Decimal(previousTokenBalance).sub(balanceChange);
        const actual = await indexPool.getBalance(tokens[i])
          .then(b => Decimal(fromWei(toBN(b))));
        const relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
      const poolBalance = await indexPool.totalSupply().then(s => Decimal(fromWei(toBN(s))));
      expect(poolBalance.equals(currentPoolBalance)).to.be.true;
      ({tokens, balances, denormalizedWeights, normalizedWeights} = await getPoolData());
    });
  
    it('joinswapExternAmountIn', async () => {
      let currentPoolBalance = await indexPool.totalSupply().then(s => Decimal(fromWei(s)));
      const poolRatio = 1.05;
      ({ balances } = await getPoolData());
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        const previousTokenBalance = fromWei(balances[i]);
        const norm = normalizedWeights[i];
        // increase tbalance by 1.05^2 after swap fee
        let tAi = (1 / (1 - swapFee * (1 - norm))) * (previousTokenBalance * (poolRatio ** (1 / norm) - 1));
        tAi = Decimal(tAi);
        await mintAndApprove(tokenIn, decToWeiHex(tAi));
        const pAo = await indexPool.callStatic.joinswapExternAmountIn(
          tokens[i],
          decToWeiHex(tAi),
          0
        );
        // Execute txn called above
        await indexPool.joinswapExternAmountIn(tokens[i], decToWeiHex(tAi), 0);
        // Check token balance
        const currentTokenBalance = Decimal(previousTokenBalance).plus(tAi);
        const realTokenBalance = await indexPool.getBalance(tokens[i]).then(t => Decimal(fromWei(t)));
        poolHelper.records[tokenIn].balance = realTokenBalance;
        let relDiff = calcRelativeDiff(currentTokenBalance, realTokenBalance);
        // @TODO Work on the math to get this error down
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
  
        const previousPoolBalance = currentPoolBalance;
        currentPoolBalance = currentPoolBalance.mul(Decimal(poolRatio)); // increase by 1.05
  
        // Check pAo
        const expected = (currentPoolBalance.sub(previousPoolBalance)); // poolRatio = 1.05
        const actual = Decimal(fromWei(pAo));
        relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
      poolHelper.poolSupply = currentPoolBalance;
    });
  
    it('joinswapPoolAmountOut', async () => {
      const poolRatio = 1.05;
      const maxPrice = web3.utils.toTwosComplement(-1);
      for (let i = 0; i < tokens.length; i++) {
        let currentPoolBalance = await indexPool.totalSupply().then(s => fromWei(s));
        const pAo = currentPoolBalance * (poolRatio - 1);
        const token = tokens[i];
        const norm = normalizedWeights[i];
        let currentTokenBalance = await indexPool.getBalance(token).then(b => Decimal(fromWei(b)));
        const previousTokenBalance = currentTokenBalance;
        // (21% + swap fees) addition to current Rock supply ;
        const numer = (previousTokenBalance * ((poolRatio ** (1 / norm) - 1) * 1));
        const denom = (1 - swapFee * (1 - norm));
        let expected = currentTokenBalance.plus(Decimal(numer / denom));
        await mintAndApprove(token, decToWeiHex(expected));
        const tAi = await indexPool.callStatic.joinswapPoolAmountOut(
          token,
          decToWeiHex(pAo),
          maxPrice
        ); // 10% of current supply
        poolHelper.records[token].balance += fromWei(tAi);
        await indexPool.joinswapPoolAmountOut(token, toWei(pAo), maxPrice);
        // Update balance states
        currentPoolBalance = Decimal(currentPoolBalance).mul(Decimal(poolRatio)); // increase by 1.1
        
        let actual = currentTokenBalance.plus(Decimal(fromWei(tAi)))
        // await indexPool.getBalance(token).then(b => Decimal(fromWei(b)));
        let relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
    });
  
    it('exitswapPoolAmountIn', async () => {
      const poolRatioAfterExitFee = 0.98;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const norm = normalizedWeights[i];
        let currentTokenBalance = Decimal(fromWei(await indexPool.getBalance(token)));
        let currentPoolBalance = await indexPool.totalSupply().then(s => fromWei(s));
        const pAi = currentPoolBalance * (1 - poolRatioAfterExitFee) * (1 / (1 - exitFee));
        const tAo = await indexPool.callStatic.exitswapPoolAmountIn(token, decToWeiHex(pAi), 0);
  
        await indexPool.exitswapPoolAmountIn(token, decToWeiHex(pAi), toWei('0'));
        // Update balance states
        previousPoolBalance = currentPoolBalance;
        currentPoolBalance = currentPoolBalance.sub(Decimal(pAi).mul(Decimal(1).sub(Decimal(exitFee))));
        // let expectedTokenBalance = fromWei(currentTokenBalance).sub(tAo);
        const mult = (1 - poolRatioAfterExitFee ** (1 / norm)) * (1 - swapFee * (1 - norm));
        let previousTokenBalance = currentTokenBalance;
        currentTokenBalance = currentTokenBalance.sub(previousTokenBalance.mul(Decimal(mult)));
        const expected = previousTokenBalance.sub(currentTokenBalance); // 0.4641 -> 1.1^4 - 1 = 0.4641
        const actual = fromWei(tAo);
        const relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
    });
  
  
    it('exitswapExternAmountOut', async () => {
      // Call function
      const poolRatioAfterExitFee = 0.98;
      const MAX = web3.utils.toTwosComplement(-1);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const norm = normalizedWeights[i];
        const tokenRatioBeforeSwapFee = poolRatioAfterExitFee ** (1 / norm);
        let currentTokenBalance = Decimal(fromWei(await indexPool.getBalance(token)));
        let currentPoolBalance = await indexPool.totalSupply().then(s => fromWei(s));
        const tAo = currentTokenBalance * (1 - tokenRatioBeforeSwapFee) * (1 - swapFee * (1 - norm));
        const pAi = await indexPool.callStatic.exitswapExternAmountOut(token, decToWeiHex(tAo), MAX);
        await indexPool.exitswapExternAmountOut(token, decToWeiHex(tAo), MAX);
        currentTokenBalance = currentTokenBalance.sub(Decimal(tAo));
        let previousPoolBalance = Decimal(currentPoolBalance);
        const balanceChange = previousPoolBalance.mul(Decimal(1).sub(Decimal(poolRatioAfterExitFee)));
        currentPoolBalance = Decimal(currentPoolBalance).sub(balanceChange);
        const expected = (previousPoolBalance.sub(currentPoolBalance)).div(Decimal(1).sub(Decimal(exitFee)));
        const actual = fromWei(pAi);
        const relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
    });
  });

  describe('Weight Adjustment', async () => {
    let records = {};
    before(async () => {
      // Update the pool helper with the new total supplies and balances
      // after the previous tests
      for (let token of wrappedTokens) {
        const balance = await indexPool.getBalance(token.address).then(b => Decimal(fromWei(b)));
        const totalSupply = await token.token.totalSupply().then(t => Decimal(fromWei(t)));
        poolHelper.records[token.address].balance = balance;
        poolHelper.records[token.address].totalSupply = totalSupply;
      }
    });

    it('Sets the target weights', async () => {
      poolHelper.setDesiredWeights();
      const tokens = wrappedTokens.map(t => t.address);
      const denorms = tokens.map(t => decToWeiHex(poolHelper.records[t].desiredDenorm));
      await increaseTimeBySeconds(100 * 60);
      await indexPool.reweighTokens(tokens, denorms);
      for (let token of poolHelper.tokens) {
        records[token] = await indexPool.getTokenRecord(token);
      }
    });

    it('Sets the correct target weights', async () => {
      for (let token of poolHelper.tokens) {
        const record = records[token];
        const computedRecord = poolHelper.records[token];
        let actual = '0x' + toBN(record.desiredDenorm).toString('hex');
        let expected = decToWeiHex(computedRecord.desiredDenorm);
        expect(actual).to.equal(expected);
      }
    });

    it('Adjusts the weights when the targets are set', async () => {
      for (let token of poolHelper.tokens) {
        const record = records[token];
        const computedRecord = poolHelper.records[token];
        poolHelper.updateWeight(token);
        let actual = fromWei(record.denorm);
        let expected = computedRecord.denorm;
        const relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
    });
  });

  describe('Extreme Weight Adjustment', async () => {
    let records = {}, oldRecords = {};
    before(async () => {
      // Update the pool helper with a radically different market cap for the first token
      const { token, address } = wrappedTokens[0];
      const totalSupply = await token.totalSupply().then(t => Decimal(fromWei(t)));
      poolHelper.records[address].totalSupply = Decimal(totalSupply * 5);
      for (let token of poolHelper.tokens) {
        oldRecords[token] = await indexPool.getTokenRecord(token);
      }
    });

    it('Sets the target weights', async () => {
      poolHelper.setDesiredWeights();
      const tokens = wrappedTokens.map(t => t.address);
      const denorms = tokens.map(t => decToWeiHex(poolHelper.records[t].desiredDenorm));
      await increaseTimeBySeconds(100 * 60);
      await indexPool.reweighTokens(tokens, denorms);
      for (let token of poolHelper.tokens) {
        records[token] = await indexPool.getTokenRecord(token);
      }
    });

    it('Adjusts the weights by a maximum of swapFee', async () => {
      for (let token of poolHelper.tokens) {
        // const { denorm: oldWeight } = oldRecords[token];
        const oldWeight = toBN(oldRecords[token].denorm);
        const weight = toBN(records[token].denorm);
        let expected = fromWei(oldWeight.divn(40));
        let actual = fromWei(weight.sub(oldWeight).abs());
        let relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
        poolHelper.updateWeight(token);
        expected = poolHelper.records[token].denorm;
        actual = fromWei(weight);
        relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
    });
  });

  describe('Adjust weights during swaps', async () => {
    let tokens, balances, normalizedWeights;
    before(async () => {
      ({ tokens, balances, normalizedWeights } = await getPoolData());
    });

  
    it('swapExactAmountIn', async () => {
      const maxPrice = web3.utils.toTwosComplement(-1);
      await increaseTimeBySeconds(60 * 60);
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        const tokenAmountIn = balances[i].divn(50);
        await mintAndApprove(tokenIn, '0x' + tokenAmountIn.toString('hex'));
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenOut == tokenIn) continue;
          const output = await indexPool.callStatic.swapExactAmountIn(
            tokenIn,
            `0x${tokenAmountIn.toString('hex')}`,
            tokenOut,
            0,
            maxPrice
          );
          const computed = poolHelper.calcOutGivenIn(tokenIn, tokenOut, fromWei(tokenAmountIn), true);
          let expected = computed[0];
          let actual = Decimal(fromWei(output[0]));
          let relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
          expected = computed[1];
          actual = fromWei(output[1]);
          relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
        }
      }
    });
  
    it('swapExactAmountOut', async () => {
      const maxPrice = web3.utils.toTwosComplement(-1);
      await increaseTimeBySeconds(60 * 60);
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        const maxAmountIn = maxPrice;
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenOut == tokenIn) continue;
          const tokenAmountOut = balances[o].divn(50);
          const computed = poolHelper.calcInGivenOut(tokenIn, tokenOut, fromWei(tokenAmountOut), true);
          // increase the approved tokens by 1% because the math on the decimal -> bn
          // has minor rounding errors
          await mintAndApprove(tokenIn, decToWeiHex(computed[0].mul(1.01)));
          const output = await indexPool.callStatic.swapExactAmountOut(
            tokenIn,
            maxAmountIn,
            tokenOut,
            `0x${tokenAmountOut.toString('hex')}`,
            maxPrice,
          );
          // Check the token input amount
          let expected = computed[0];
          let actual = Decimal(fromWei(output[0]));
          let relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
          // Check the resulting spot price
          expected = computed[1];
          actual = fromWei(output[1]);
          relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
        }
      }
    });
  });
});