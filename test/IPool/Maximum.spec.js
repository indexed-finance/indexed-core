const Decimal = require('decimal.js');
const { calcRelativeDiff } = require('../lib/calc_comparisons');
const { poolFixtureWithMaxTokens } = require("../fixtures/pool.fixture");
const { toWei, fromWei, zero, zeroAddress, expect, maxUint256: maxPrice, getTransactionTimestamp, verifyRejection, getFakerContract, fastForward } = require('../utils');
const { BigNumber } = require('ethers');
const { defaultAbiCoder } = require('ethers/lib/utils');

const errorDelta = 10 ** -8;

describe('IndexPool.sol', async () => {
  let poolHelper, indexPool, erc20Factory, nonOwnerFaker;
  let getPoolData, verifyRevert, mintAndApprove, wrappedTokens;
  let tokens, balances, denormalizedWeights, normalizedWeights;
  let newToken;
  let from, feeRecipient;
  let lastDenormUpdate;

  const setupTests = () => {
    before(async () => {
      erc20Factory = await ethers.getContractFactory("MockERC20");
      ({
        wrappedTokens,
        indexPool,
        poolHelper,
        getPoolData,
        mintAndApprove,
        from,
        lastDenormUpdate,
        verifyRevert,
        nonOwnerFaker,
        feeRecipient
      } = await deployments.createFixture(poolFixtureWithMaxTokens)());
      await updateData();
    });
  }

  const updateData = async () => {
    ({ tokens, balances, denormalizedWeights, normalizedWeights } = await getPoolData());
  };
  
  const triggerReindex = async (denorm = 1, minimumBalance = 5) => {
    newToken = await erc20Factory.deploy('Test Token', 'TT');
    const newWrappedTokens = [ ...wrappedTokens.slice(0, wrappedTokens.length - 1) ];
    newWrappedTokens.push({
      name: 'Test Token',
      symbol: 'TT',
      token: newToken,
      address: newToken.address,
    });

    const newTokens = tokens.slice(0, tokens.length - 1);
    newTokens.push(newToken.address);

    const newDenorms = denormalizedWeights.slice(0, denormalizedWeights.length - 1);
    newDenorms.push(toWei(denorm))
    const newBalances = balances.slice(0, balances.length - 1);
    newBalances.push(toWei(minimumBalance));
    const tx = await indexPool.reindexTokens(newTokens, newDenorms, newBalances);
    lastDenormUpdate = await getTransactionTimestamp(tx);
    const lastToken = poolHelper.tokens[poolHelper.tokens.length - 1];
    poolHelper.tokens.push(newToken.address);
    poolHelper.records[lastToken].desiredDenorm = 0;
    poolHelper.records[newToken.address] = {
      minimumBalance,
      balance: 0,
      denorm: 0,
      desiredDenorm: denorm,
      ready: false,
      totalSupply: 5
    };
    await updateData();
  }

  describe('getTokenRecord()', async () => {
    setupTests();

    it('Returns expected record for bound token', async () => {
      const expected = [
        true,
        true,
        lastDenormUpdate,
        denormalizedWeights[0],
        denormalizedWeights[0],
        0,
        balances[0]
      ]
      const record = await indexPool.getTokenRecord(tokens[0]);
      expect(record).to.deep.eq(expected);
    });

    it('Reverts if token is not bound', async () => {
      await verifyRevert('getTokenRecord', /ERR_NOT_BOUND/g, zeroAddress);
    });
  });

  describe('getSpotPrice()', async () => {
    setupTests();

    it('Reverts if either token is unbound', async () => {
      await verifyRevert('getSpotPrice', /ERR_NOT_BOUND/g, tokens[0], zeroAddress);
      await verifyRevert('getSpotPrice', /ERR_NOT_BOUND/g, zeroAddress, tokens[0]);
    });

    it('Prices initialized tokens normally', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenOut == tokenIn) continue;
          const expected = poolHelper.calcSpotPrice(tokenIn, tokenOut);
          const actual = fromWei(await indexPool.getSpotPrice(tokenIn, tokenOut));
          const relDiff = calcRelativeDiff(expected, actual);
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
        }
      }
    });

    it('Reverts if tokenOut is not ready', async () => {
      await triggerReindex();
      const tokenOut = newToken.address;
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        await verifyRevert('getSpotPrice', /ERR_OUT_NOT_READY/g, tokenIn, tokenOut);
      }
    });

    it('Uses the minimum balance and weight to price uninitialized tokens', async () => {
      const tokenIn = newToken.address;
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
    });
  });

  describe('swapExactAmountIn()', async () => {
    setupTests();

    it('Reverts if either token is unbound', async () => {
      await verifyRevert('swapExactAmountIn', /ERR_NOT_BOUND/g, tokens[0], zero, zeroAddress, zero, zero);
      await verifyRevert('swapExactAmountIn', /ERR_NOT_BOUND/g, zeroAddress, zero, tokens[0], zero, zero);
    });
  
    it('Reverts if input amount > 1/2 of balance', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const amountIn = balances[i].div(2).add(1);
        await verifyRevert('swapExactAmountIn', /MAX_IN_RATIO/g, tokens[i], amountIn, tokens[i-1] || tokens[i+1], zero, zero);
      }
    });

    it('Reverts if spotPriceBefore is lower than maxPrice', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const tokenOut = tokens[i-1] || tokens[i+1];
        const spotPrice = await indexPool.getSpotPrice(tokens[i], tokenOut);
        const amountIn = balances[i].div(4);
        await verifyRevert('swapExactAmountIn', /ERR_BAD_LIMIT_PRICE/g, tokens[i], amountIn, tokenOut, zero, spotPrice.div(2));
      }
    });

    it('Reverts if spotPriceAfter is lower than maxPrice', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        const tokenOut = tokens[i-1] || tokens[i+1];
        const amountIn = balances[i].div(10);
        const [, spotPriceAfter] = await indexPool.callStatic.swapExactAmountIn(tokenIn, amountIn, tokenOut, zero, maxPrice);
        await verifyRevert('swapExactAmountIn', /ERR_LIMIT_PRICE/g, tokenIn, amountIn, tokenOut, zero, spotPriceAfter.sub(1e3));
      }
    });

    it('Reverts if tokenAmountOut < minAmountOut', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        const tokenOut = tokens[i-1] || tokens[i+1];
        const amountIn = toWei(1);
        const minAmountOut = toWei(poolHelper.calcOutGivenIn(tokenIn, tokenOut, 1)[0]);
        await verifyRevert('swapExactAmountIn', /ERR_LIMIT_OUT/g, tokenIn, amountIn, tokenOut, minAmountOut.sub(1e3), maxPrice);
      }
    });

    it('Prices initialized tokens normally', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        const tokenAmountIn = balances[i].div(50);
        await mintAndApprove(tokenIn, tokenAmountIn);
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenIn == tokenOut) continue;
          const [expectedAmountOut, expectedSpotPrice] = poolHelper.calcOutGivenIn(tokenIn, tokenOut, fromWei(tokenAmountIn), true);
          const [actualAmountOut, actualSpotPrice] = await indexPool.callStatic.swapExactAmountIn(
            tokenIn, tokenAmountIn, tokenOut, 0, maxPrice
          );
          expect(+calcRelativeDiff(expectedAmountOut, fromWei(actualAmountOut))).to.be.lte(errorDelta);
          expect(+calcRelativeDiff(expectedSpotPrice, fromWei(actualSpotPrice))).to.be.lte(errorDelta);
        }
      }
    });

    it('Uses the minimum balance and weight to price uninitialized tokens, and uses updated weight for spotPriceAfter', async () => {
      await triggerReindex();
      await fastForward(3600)
      const tokenIn = newToken.address;
      for (let o = 0; o < tokens.length; o++) {
        const tokenOut = tokens[o];
        if (tokenOut.toLowerCase() == newToken.address.toLowerCase()) continue;
        const tokenAmountIn = toWei(1);
        await mintAndApprove(tokenIn, tokenAmountIn);
        const [expectedAmountOut, expectedSpotPrice] = poolHelper.calcOutGivenIn(tokenIn, tokenOut, 1, true);
        const [actualAmountOut, actualSpotPrice] = await indexPool.callStatic.swapExactAmountIn(
          tokenIn, tokenAmountIn, tokenOut, 0, maxPrice
        );
        expect(+calcRelativeDiff(expectedAmountOut, fromWei(actualAmountOut))).to.be.lte(errorDelta);
        expect(+calcRelativeDiff(expectedSpotPrice, fromWei(actualSpotPrice))).to.be.lte(errorDelta);
      }
    });

    it('Reverts if tokenOut is uninitialized', async () => {
      await triggerReindex();
      const tokenOut = newToken.address;
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        if (tokenIn  == tokenOut) continue;
        await verifyRevert('swapExactAmountIn', /ERR_OUT_NOT_READY/g, tokenIn, zero, tokenOut, 0, maxPrice);
      }
    });
  });

  describe('swapExactAmountOut()', async () => {
    setupTests();

    it('Reverts if either token is unbound', async () => {
      await verifyRevert('swapExactAmountOut', /ERR_NOT_BOUND/g, tokens[0], zero, zeroAddress, zero, zero);
      await verifyRevert('swapExactAmountOut', /ERR_NOT_BOUND/g, zeroAddress, zero, tokens[0], zero, zero);
    });
  
    it('Reverts if output amount > 1/3 of balance', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const amountout = balances[i].div(3).add(10000);
        await verifyRevert('swapExactAmountOut', /MAX_OUT_RATIO/g, tokens[i-1] || tokens[i+1], maxPrice, tokens[i], amountout, maxPrice);
      }
    });

    it('Reverts if spot price is lower than maxPrice', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const tokenOut = tokens[i];
        const tokenIn = tokens[i-1] || tokens[i+1];
        const spotPrice = await indexPool.getSpotPrice(tokenIn, tokenOut);
        const amountOut = balances[i].div(4);
        await verifyRevert('swapExactAmountOut', /ERR_BAD_LIMIT_PRICE/g, tokenIn, maxPrice, tokenOut, amountOut, spotPrice.div(2));
      }
    });

    it('Prices initialized tokens normally', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenIn == tokenOut) continue;
          const tokenAmountOut = balances[o].div(10);
          const [expectedAmountIn, expectedSpotPrice] = poolHelper.calcInGivenOut(tokenIn, tokenOut, fromWei(tokenAmountOut), true);
          await mintAndApprove(tokenIn, toWei(expectedAmountIn).mul(2));
          const [actualAmountIn, actualSpotPrice] = await indexPool.callStatic.swapExactAmountOut(
            tokenIn, maxPrice, tokenOut, tokenAmountOut, maxPrice
          );
          expect(+calcRelativeDiff(expectedAmountIn, fromWei(actualAmountIn))).to.be.lte(errorDelta);
          expect(+calcRelativeDiff(expectedSpotPrice, fromWei(actualSpotPrice))).to.be.lte(errorDelta);
        }
      }
    });

    it('Uses the minimum balance and weight to price uninitialized tokens, and uses updated weight for spotPriceAfter', async () => {
      await triggerReindex();
      await fastForward(3600)
      const tokenIn = newToken.address;
      for (let o = 0; o < tokens.length; o++) {
        const tokenOut = tokens[o];
        if (tokenIn == tokenOut) continue;
        const tokenAmountOut = balances[o].div(100);
        const [expectedAmountIn, expectedSpotPrice] = poolHelper.calcInGivenOut(tokenIn, tokenOut, fromWei(tokenAmountOut), true);
        await mintAndApprove(tokenIn, toWei(expectedAmountIn).mul(2));
        const [actualAmountIn, actualSpotPrice] = await indexPool.callStatic.swapExactAmountOut(
          tokenIn, maxPrice, tokenOut, tokenAmountOut, maxPrice
        );
        expect(+calcRelativeDiff(expectedAmountIn, fromWei(actualAmountIn))).to.be.lte(errorDelta);
        expect(+calcRelativeDiff(expectedSpotPrice, fromWei(actualSpotPrice))).to.be.lte(errorDelta);
      }
    });

    it('Reverts if tokenOut is uninitialized', async () => {
      const tokenOut = newToken.address;
      for (let i = 0; i < tokens.length; i++) {
        const tokenIn = tokens[i];
        if (tokenIn  == tokenOut) continue;
        await verifyRevert('swapExactAmountOut', /ERR_OUT_NOT_READY/g, tokenIn, zero, tokenOut, 0, maxPrice);
      }
    });
  });

  describe('joinswapExternAmountIn()', async () => {
    setupTests();

    it('Reverts if tokenAmountIn = 0', async () => {
      await verifyRevert('joinswapExternAmountIn', /ERR_ZERO_IN/g, tokens[0], zero, zero);
    });

    it('Reverts if tokenAmountIn > balanceIn / 2', async () => {
      await verifyRevert('joinswapExternAmountIn', /ERR_MAX_IN_RATIO/g, tokens[0], balances[0].div(2).add(1e3), zero);
    });

    it('Reverts if poolAmountOut < minPoolAmountOut', async () => {
      const expectedAmountOut = poolHelper.calcPoolOutGivenSingleIn(tokens[0], 1);
      await verifyRevert('joinswapExternAmountIn', /ERR_LIMIT_OUT/g, tokens[0], toWei(1), toWei(expectedAmountOut).mul(2));
    });

    it('Prices initialized tokens normally', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const expectedAmountOut = poolHelper.calcPoolOutGivenSingleIn(tokens[0], 0.1);
        const actualAmountOut = await indexPool.callStatic.joinswapExternAmountIn(tokens[0], toWei('0.1'), 0);
        expect(+calcRelativeDiff(expectedAmountOut, fromWei(actualAmountOut))).to.be.lte(errorDelta);
      }
    });

    it('Prices uninitialized tokens using minimum balance and weight', async () => {
      await triggerReindex();
      await mintAndApprove(newToken.address, toWei(1));
      const expectedAmountOut = poolHelper.calcPoolOutGivenSingleIn(newToken.address, 1);
      const actualAmountOut = await indexPool.callStatic.joinswapExternAmountIn(newToken.address, toWei(1), zero);
      expect(+calcRelativeDiff(expectedAmountOut, fromWei(actualAmountOut))).to.be.lte(errorDelta);
    });
  });

  describe('joinswapPoolAmountOut()', async () => {
    setupTests();

    it('Reverts if tokenAmountIn > balanceIn / 2', async () => {
      const poolAmountOut = poolHelper.calcPoolOutGivenSingleIn(tokens[0], fromWei(balances[0]));
      await verifyRevert('joinswapPoolAmountOut', /ERR_MAX_IN_RATIO/g, tokens[0], toWei(poolAmountOut), maxPrice);
    });

    it('Reverts if tokenAmountIn > maxAmountIn', async () => {
      const amountIn = poolHelper.calcSingleInGivenPoolOut(tokens[0], 1);
      await verifyRevert('joinswapPoolAmountOut', /ERR_LIMIT_IN/g, tokens[0], toWei(1), toWei(amountIn).div(2));
    });

    it('Prices initialized tokens normally', async () => {
      const expectedAmountIn = poolHelper.calcSingleInGivenPoolOut(tokens[0], 1);
      await mintAndApprove(tokens[0], toWei(expectedAmountIn).mul(2));
      const actualAmountIn = await indexPool.callStatic.joinswapPoolAmountOut(tokens[0], toWei(1), toWei(expectedAmountIn).mul(2));
      expect(+calcRelativeDiff(expectedAmountIn, fromWei(actualAmountIn))).to.be.lte(errorDelta);
    });

    it('Prices uninitialized tokens using minimum balance and weight', async () => {
      await triggerReindex();
      const expectedAmountIn = poolHelper.calcSingleInGivenPoolOut(newToken.address, 0.1);
      await mintAndApprove(newToken.address, toWei(expectedAmountIn).mul(2));
      const actualAmountIn = await indexPool.callStatic.joinswapPoolAmountOut(newToken.address, toWei(0.1), toWei(expectedAmountIn).mul(2));
      expect(+calcRelativeDiff(expectedAmountIn, fromWei(actualAmountIn))).to.be.lte(errorDelta);
    });
  });

  describe('joinPool()', async () => {
    setupTests();

    it('Reverts if invalid array length is given', async () => {
      await verifyRevert('joinPool', /ERR_ARR_LEN/g, toWei(100), []);
    });

    it('Reverts if zero tokens are requested', async () => {
      await verifyRevert('joinPool', /ERR_MATH_APPROX/g, zero, new Array(tokens.length).fill(maxPrice));
    });

    it('Reverts if tokenAmountIn > maxAmountIn', async () => {
      const maxPrices = new Array(tokens.length).fill(maxPrice);
      maxPrices[0] = 0;
      await verifyRevert('joinPool', /ERR_LIMIT_IN/g, toWei(1), maxPrices);
    });

    it('Prices initialized tokens normally', async () => {
      let previousPoolBalance = 100;
      let poolAmountOut = 1;
      for (let token of wrappedTokens) {
        await token.token.approve(indexPool.address, maxPrice)
      }
      await indexPool.joinPool(toWei(poolAmountOut), new Array(tokens.length).fill(maxPrice));
      const amountsIn = poolHelper.calcAllInGivenPoolOut(poolAmountOut, true);
      for (let i = 0; i < tokens.length; i++) {
        const previousTokenBalance = fromWei(balances[i]);
        const expected = Decimal(previousTokenBalance).plus(Decimal(amountsIn[i]));
        const actual = await indexPool.getBalance(tokens[i]).then(b => Decimal(fromWei(b)));
        const relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
      const actualSupply = await indexPool.totalSupply().then(s => Decimal(fromWei(s)));
      const expectedSupply = Decimal(previousPoolBalance).plus(Decimal(1));
      expect(actualSupply.equals(expectedSupply)).to.be.true;
      ({tokens, balances, denormalizedWeights, normalizedWeights} = await getPoolData());
    });

    it('Prices uninitialized tokens using minimum balance and weight', async () => {
      await triggerReindex();
      let previousPoolBalance = 101;
      let poolAmountOut = 1;
      const amountsIn = poolHelper.calcAllInGivenPoolOut(poolAmountOut, true);
      for (let i = 0; i < tokens.length; i++) {
        await mintAndApprove(tokens[i], toWei(amountsIn[i]).mul(2));
      }
      await indexPool.joinPool(toWei(poolAmountOut), new Array(tokens.length).fill(maxPrice));
      for (let i = 0; i < tokens.length; i++) {
        const previousTokenBalance = fromWei(balances[i]);
        const expected = Decimal(previousTokenBalance).plus(Decimal(amountsIn[i]));
        const actual = await indexPool.getBalance(tokens[i]).then(b => Decimal(fromWei(b)));
        const relDiff = calcRelativeDiff(expected, actual);
        expect(relDiff.toNumber()).to.be.lte(errorDelta);
      }
      const actualSupply = await indexPool.totalSupply().then(s => Decimal(fromWei(s)));
      const expectedSupply = Decimal(previousPoolBalance).plus(Decimal(1));
      expect(actualSupply.equals(expectedSupply)).to.be.true;
      ({tokens, balances, denormalizedWeights, normalizedWeights} = await getPoolData());
    });
  });

  describe('exitswapPoolAmountIn()', async () => {
    setupTests();

    it('Prices initialized tokens normally', async () => {
      const poolAmountIn = toWei(1);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const expectedAmountOut = poolHelper.calcSingleOutGivenPoolIn(token, fromWei(poolAmountIn), false);
        const actualAmountOut = await indexPool.callStatic.exitswapPoolAmountIn(token, poolAmountIn, 0);
        expect(+calcRelativeDiff(expectedAmountOut, Decimal(fromWei(actualAmountOut)))).to.be.lte(errorDelta);
      }
    });

    it('Reverts if unbound token is given', async () => {
      await verifyRevert('exitswapPoolAmountIn', /ERR_NOT_BOUND/g, zeroAddress, zero, zero);
    });

    it('Reverts if tokenAmountOut < minAmountOut', async () => {
      const poolAmountIn = toWei(1);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const expectedAmountOut = poolHelper.calcSingleOutGivenPoolIn(token, fromWei(poolAmountIn), false);
        await verifyRevert('exitswapPoolAmountIn', /ERR_LIMIT_OUT/g, token, poolAmountIn, toWei(expectedAmountOut).add(1e4));
      }
    });

    it('Reverts if tokenAmountOut > balanceOut / 3', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const tokenAmountOut = balances[i].div(2);
        const poolAmountIn = poolHelper.calcPoolInGivenSingleOut(token, fromWei(tokenAmountOut), false);
        await verifyRevert('exitswapPoolAmountIn', /ERR_MAX_OUT_RATIO/g, token, toWei(poolAmountIn), zero);
      }
    });

    it('Reverts if uninitialized token is given', async () => {
      await triggerReindex();
      await verifyRevert('exitswapPoolAmountIn', /ERR_OUT_NOT_READY/g, newToken.address, zero, zero);
    });
  });

  describe('exitswapExternAmountOut()', async () => {
    setupTests();

    it('Prices initialized tokens normally', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const tokenAmountOut = balances[i].div(10);
        const expectedAmountIn = poolHelper.calcPoolInGivenSingleOut(token, fromWei(tokenAmountOut), false);
        const actualAmountIn = await indexPool.callStatic.exitswapExternAmountOut(token, tokenAmountOut, maxPrice);
        expect(+calcRelativeDiff(expectedAmountIn, Decimal(fromWei(actualAmountIn)))).to.be.lte(errorDelta);
      }
    });

    it('Reverts if unbound token is given', async () => {
      await verifyRevert('exitswapExternAmountOut', /ERR_NOT_BOUND/g, zeroAddress, zero, zero);
    });

    it('Reverts if poolRatio = 0', async () => {
      await verifyRevert('exitswapExternAmountOut', /ERR_MATH_APPROX/g, tokens[0], 1, maxPrice);
    });

    it('Reverts if tokenAmountOut > balanceOut / 3', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const tokenAmountOut = balances[i].div(2);
        await verifyRevert('exitswapExternAmountOut', /ERR_MAX_OUT_RATIO/g, token, tokenAmountOut, maxPrice);
      }
    });

    it('Reverts if uninitialized token is given', async () => {
      await triggerReindex();
      await verifyRevert('exitswapExternAmountOut', /ERR_OUT_NOT_READY/g, newToken.address, zero, zero);
    });
  });

  describe('exitPool()', async () => {
    setupTests();

    it('Prices initialized tokens normally', async () => {
      const poolAmountIn = 1;
      const expectedAmountsOut = poolHelper.calcAllOutGivenPoolIn(poolAmountIn, true);
      const previousRecipientBalance = await indexPool.balanceOf(feeRecipient);
      const previousPoolBalance = await indexPool.totalSupply();
      const amounts = new Array(tokens.length).fill(0);
      await indexPool.exitPool(toWei(poolAmountIn), amounts);
      const currentPoolBalance = await indexPool.totalSupply();
      const poolSupplyDiff = previousPoolBalance.sub(currentPoolBalance);
      expect(+calcRelativeDiff(0.995, fromWei(poolSupplyDiff))).to.be.lte(errorDelta);
      const newRecipientBalance = await indexPool.balanceOf(feeRecipient);
      const feesGained = fromWei(newRecipientBalance.sub(previousRecipientBalance));
      expect(+calcRelativeDiff(0.005, feesGained)).to.be.lte(errorDelta)
      for (let i = 0; i < tokens.length; i++) {
        const previousTokenBalance = balances[i];
        const currentTokenBalance = await indexPool.getBalance(tokens[i]);
        const realDiff = previousTokenBalance.sub(currentTokenBalance);
        const expectedDiff = expectedAmountsOut[i];
        expect(+calcRelativeDiff(expectedDiff, fromWei(realDiff))).to.be.lte(errorDelta);
      }
    });

    it('Reverts if poolRatio = 0', async () => {
      await verifyRevert('exitPool', /ERR_MATH_APPROX/g, 1, new Array(tokens.length).fill(0));
    });

    it('Reverts if invalid array length is given', async () => {
      await verifyRevert('exitPool', /ERR_ARR_LEN/g, toWei(1), new Array(tokens.length - 1).fill(0));
    });

    it('Reverts if tokenAmountOut < minAmountOut', async () => {
      const minOut = new Array(tokens.length).fill(maxPrice);
      await verifyRevert('exitPool', /ERR_LIMIT_OUT/g, toWei(1), minOut);
    });

    it('Reverts if minAmountOut is not zero for uninitialized tokens', async () => {
      await triggerReindex();
      const minOut = new Array(tokens.length).fill(0);
      minOut[minOut.length - 1] = 1;
      await verifyRevert('exitPool', /ERR_OUT_NOT_READY/g, toWei(1), minOut);
    });

    it('Gives 0 for uninitialized tokens', async () => {
      await indexPool.exitPool(toWei(1), new Array(tokens.length).fill(0));
      const bal = await indexPool.getBalance(newToken.address);
      expect(bal.eq(0)).to.be.true;
    });
  });
});