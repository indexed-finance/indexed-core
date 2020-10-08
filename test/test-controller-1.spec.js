const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);

const { soliditySha3 } = require('web3-utils');
const bre = require("@nomiclabs/buidler");
const { ethers } = bre;

const BN = require('bn.js');
const Decimal = require('decimal.js');

const { nTokens, nTokensHex, toHex } = require('./lib/tokens');
const { calcRelativeDiff } = require('./lib/calc_comparisons');
const PoolHelper = require("./lib/pool-helper");
const { deployTokenMarket, addLiquidity } = require("./lib/uniswap");

const { expect } = chai;
const keccak256 = (data) => soliditySha3(data);

const toBN = (bn) => BN.isBN(bn) ? bn : bn._hex ? new BN(bn._hex.slice(2), 'hex') : new BN(bn);

const exitFee = 0;
const swapFee = 0.025;
const errorDelta = 10 ** -8;


describe("MarketCapSqrtController.sol", () => {
  let wrappedTokens;
  let from, poolController, marketOracle;
  let shortOracle;
  let indexPool;
  let initializer;
  let sortedTokenAddresses;
  let sortedTokens = [];

  const fromWei = (_bn) => web3.utils.fromWei(toBN(_bn).toString(10));
  const toWei = (_bn) => web3.utils.toWei(toBN(_bn).toString(10));

  before(async () => {
    await bre.deployments.fixture(['Core', 'Mocks']);
    marketOracle = await ethers.getContract('WeeklyTWAPUniSwapV2Oracle');
    shortOracle = await ethers.getContract('HourlyTWAPUniswapV2Oracle');
    poolController = await ethers.getContract('controller');
    weth = await ethers.getContract('weth');
    uniswapFactory = await ethers.getContract('uniswapFactory');
    uniswapRouter = await ethers.getContract('uniswapRouter');
    ([from] = await web3.eth.getAccounts());
    wrappedTokens = [...bre.config.wrappedTokens];
    for (let token of wrappedTokens) {
      await token.token.getFreeTokens(from, nTokensHex(5000));
    }
  });

  describe('Initialize Oracle', async () => {
    it('Creates a wrapped tokens category', async () => {
      const metadata = {
        name: 'Wrapped Tokens',
        description: 'Category for wrapped tokens.'
      };
      const metadataHash = keccak256(JSON.stringify(metadata));
      const receipt = await poolController.createCategory(metadataHash);
      const { events } = await receipt.wait();
      expect(events.length).to.eql(1);
      const [event] = events;
      expect(event.event).to.eql('CategoryAdded');
      expect(event.args.metadataHash).to.eql(metadataHash);
      expect(event.args.categoryID.toNumber()).to.eql(1);
    });

    it('Adds tokens to the wrapped tokens category', async () => {
      for (let token of wrappedTokens) {
        await addLiquidity(token.address, token.initialPrice, 5000);
      }
      await poolController.addTokens(1, wrappedTokens.map(t => t.address)).then(r => r.wait());
    });

    it('Returns the correct market caps', async () => {
      await bre.run('increaseTime', { days: 3.5 });
      const caps = [];
      for (let token of wrappedTokens) {
        // In order to update the cumulative prices on the market pairs,
        // we need to add some more liquidity (could also execute trades)
        await addLiquidity(token.address, token.initialPrice, 5000);
        const expectedMarketCap = nTokens(15000).muln(token.initialPrice);
        const realMarketCap = await poolController.computeAverageMarketCap(token.address).then(toBN);
        expect(realMarketCap.toString('hex')).to.eq(expectedMarketCap.toString('hex'));
        caps.push(realMarketCap.toString('hex'));
      }
      const categoryCaps = await poolController.getCategoryMarketCaps(1);
      expect(categoryCaps.map(toBN).map(c => c.toString('hex'))).to.deep.equal(caps);
    });
  });

  describe('Sort Tokens', async () => {
    const mapToHex = (arr) => arr.map((i) => i.toString('hex'));
    const sortArr = (arr) => arr.sort((a, b) => {
      if (a.marketCap.lt(b.marketCap)) return 1;
      if (a.marketCap.gt(b.marketCap)) return -1;
      return 0;
    });

    async function getCategoryData(id) {
      const tokens = await poolController.getCategoryTokens(id);
      const marketCaps = await poolController.getCategoryMarketCaps(id);
      const arr = [];
      for (let i = 0; i < tokens.length; i++) {
        arr.push({
          token: tokens[i],
          marketCap: toBN(marketCaps[i])
        });
      }
      return arr;
    }

    it('Should sort the tokens and update the category', async () => {
      const category = await getCategoryData(1);
      const marketCaps = [10, 1, 2].map(n => nTokens(15000).muln(n));
      expect(
        mapToHex(category.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCaps));
      const categorySorted = sortArr(category);
      const marketCapsSorted = [10, 2, 1].map(n => nTokens(15000).muln(n));
      expect(
        mapToHex(categorySorted.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCapsSorted));
      await poolController.orderCategoryTokensByMarketCap(
        1, categorySorted.map((t) => t.token)
      ).then((r) => r.wait());
      const categoryAfterSort = await getCategoryData(1);
      expect(
        mapToHex(categoryAfterSort.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCapsSorted));
    });
  });

  describe('Pool Deployment', async () => {
    let expectedBalances = [], expectedWeights = [];

    before(async () => {
      // Sort the tokens
      sortedTokens = [...wrappedTokens];
      sortedTokens.sort((a, b) => a.initialPrice > b.initialPrice ? -1 : 1);
      sortedTokenAddresses = sortedTokens.map(t => t.address);
      // Compute the weights and balances
      let sum_qrts = 0;
      for (let token of sortedTokens) {
        const mkt_cap = Math.sqrt(15000 * token.initialPrice);
        sum_qrts += mkt_cap;
      }
      for (let token of sortedTokens) {
        const mkt_cap = Math.sqrt(15000 * token.initialPrice);
        const weight = mkt_cap / sum_qrts;
        expectedWeights.push(weight);
        const expectedBalance = (20 * weight) / token.initialPrice;
        expectedBalances.push(expectedBalance);
      }
    });

    it('getInitialTokensAndBalances', async () => {
      const { tokens, balances } = await poolController.getInitialTokensAndBalances(1, 3, nTokensHex(20));
      expect(tokens).to.deep.eq(sortedTokenAddresses);
      for (let i = 0; i < 3; i++) {
        const balance = fromWei(balances[i]);
        const balanceReal = expectedBalances[i];
        const diff = calcRelativeDiff(balanceReal, balance);
        expect(+diff).to.be.lte(errorDelta);
      }
    });

    it('Fails to deploy an index for a category that does not exist', async () => {
      expect(
        poolController.prepareIndexPool(
          2,
          3,
          nTokensHex(100000),
          "Invalid category index",
          "BADC2",
        ).then(r => r.wait())
      ).to.be.rejectedWith(/ERR_CATEGORY_ID/g);
    });

    it('Deploys the category index pool', async () => {
      const expectedAddress = await poolController.computePoolAddress(1, 3);
      const receipt = await poolController.prepareIndexPool(
        1,
        3,
        nTokensHex(20),
        "Top 3 Wrapped Tokens Index",
        "WTI3",
      );
      const { events, gasUsed } = await receipt.wait();
      const event = events.filter(e => e.event == 'NewPoolInitializer')[0]
      const {
        pool,
        categoryID,
        indexSize
      } = event.args;
      initializer = await ethers.getContractAt('PoolInitializer', event.args.initializer);
      const expectedInitializerAddress = await poolController.computeInitializerAddress(pool);
      expect(pool).to.equal(expectedAddress);
      expect(event.args.initializer).to.equal(expectedInitializerAddress);
      expect(categoryID).to.equal(categoryID);
      expect(indexSize).to.equal(indexSize);
      indexPool = await ethers.getContractAt('IPool', expectedAddress);
    });

    it('Sets the controller address on deployment', async () => {
      const controllerAddress = await indexPool.getController();
      expect(controllerAddress).to.equal(poolController.address);
    });

    it('Sets the correct token name and symbol', async () => {
      const name = await indexPool.name();
      expect(name).to.equal("Top 3 Wrapped Tokens Index");
      const symbol = await indexPool.symbol();
      expect(symbol).to.equal("WTI3");
    });

    describe('Pool Initialization', async () => {
      let tokens, balances;
  
      it('Joins the pool', async () => {
        ({ tokens, balances } = await poolController.getInitialTokensAndBalances(1, 3, nTokensHex(20)));
        await shortOracle.updatePrices(tokens);
        await bre.run('increaseTime', { hours: 1 });
        for (let token of wrappedTokens) {
          await addLiquidity(token.address, token.initialPrice, 5000);
        }
  
        for (let i = 0; i < 3; i++) {
          await sortedTokens[i].token.approve(initializer.address, balances[i]);
        }
        await initializer['contributeTokens(address[],uint256[],uint256)'](tokens, balances.map(b => toHex(toBN(b))), 0);
        const expectCredit = balances.reduce((t, b, i) => t.add(toBN(b).muln(sortedTokens[i].initialPrice)), new BN(0));
        const actualCredit = await initializer.getCreditOf(from);
        const relDiff = calcRelativeDiff(fromWei(expectCredit), fromWei(actualCredit));
        expect(+relDiff).to.be.lte(errorDelta);
      });
  
      it('Finishes the pool and claims tokens', async () => {
        await initializer.finish();
        await initializer['claimTokens()']();
        const credit = fromWei(await initializer.getCreditOf(from));
        expect(+credit).to.eq(0);
        const bal = fromWei(await indexPool.balanceOf(from));
        expect(+bal).to.eq(100);
      });
  
      it('Enables public swapping', async () => {
        const isPublicSwap = await indexPool.isPublicSwap();
        expect(isPublicSwap).to.be.true;
      });
  
      it('Set the correct tokens', async () => {
        const currentTokens = await indexPool.getCurrentTokens();
        expect(currentTokens).to.deep.equal(sortedTokenAddresses);
      });
  
      it('Pulled the correct balances', async () => {
        const poolBalances = await Promise.all(tokens.map(token => indexPool.getBalance(token)));
        expect(poolBalances).to.deep.equal(balances);
      });
  
      it('Set the correct denormalized weights', async () => {
        const actualWeights = await Promise.all(tokens.map(token => indexPool.getDenormalizedWeight(token)));
        for (let i = 0; i < 3; i++) {
          const actual = actualWeights[i];
          const expected = expectedWeights[i] * 25;
          const relDiff = calcRelativeDiff(expected, fromWei(actual));
          expect(+relDiff).to.be.lte(errorDelta);
        }
      });
    });
  });

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
    return web3.utils.toWei(str).toString('hex');
  }

  async function getPoolHelper() {
    const tokens = [];
    for (let tokenObj of wrappedTokens) {
      const { initialPrice, token, address } = tokenObj;
      const totalSupply = Decimal(fromWei(await token.totalSupply()));
      const balance = Decimal(fromWei(await indexPool.getBalance(address)));
      tokens.push({
        price: initialPrice,
        totalSupply,
        balance,
        address
      });
    }
    return new PoolHelper(tokens, swapFee, 0);
  }

  describe('Pool Swap & Join', async () => {
    let poolHelper, tokens, balances, normalizedWeights;
    before(async () => {
      ({ tokens, balances, normalizedWeights } = await getPoolData());
      poolHelper = await getPoolHelper();
    })

    async function mintAndApprove(tokenAddress, amountHex) {
      const token = await ethers.getContractAt('MockERC20', tokenAddress);
      await token.getFreeTokens(from, amountHex);
      await token.approve(indexPool.address, amountHex);
      const amountDec = Decimal(fromWei(new BN(amountHex.slice(2), 'hex')));
      poolHelper.records[tokenAddress].totalSupply = poolHelper.records[tokenAddress].totalSupply.add(amountDec);
    }

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
        const token = await ethers.getContractAt('MockERC20', tokenIn);
        for (let o = 0; o < tokens.length; o++) {
          const tokenOut = tokens[o];
          if (tokenOut == tokenIn) continue;
          const tokenAmountOut = balances[o].divn(50);
          const computed = poolHelper.calcInGivenOut(tokenIn, tokenOut, fromWei(tokenAmountOut));
          // increase the approved tokens by 1% because the math on the decimal -> bn
          // has minor rounding errors
          await mintAndApprove(tokenIn, decToWeiHex(computed[0].mul(1.01)));
          // await token.getFreeTokens(from, decToWeiHex(computed[0].mul(1.01)))
          // await token.approve(indexPool.address, decToWeiHex(computed[0].mul(1.01)))
          // poolHelper.records[tokenIn].totalSupply += computed[0];
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
      for (let _token of tokens) {
        const token = await ethers.getContractAt('MockERC20', _token);
        await token.approve(indexPool.address, maxPrice).then(r => r.wait);
      }
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

  describe('Add token to a category', async () => {
    let poolHelper;
    let newToken, newTokenAddress;

    const updateTokenPrices = async () => {
      for (let token of wrappedTokens) {
        await addLiquidity(token.address, token.initialPrice, 5);
        if (await marketOracle.canUpdatePrice(token.address)) {
          await marketOracle.updatePrice(token.address);
        }
        token.totalSupply = +fromWei(await token.token.totalSupply());
        poolHelper.records[token.address].totalSupply = token.totalSupply;
      }
    }

    const addLiquidityToAll = async () => {
      for (let token of wrappedTokens) {
        await addLiquidity(token.address, token.initialPrice, 5);
        token.totalSupply = +fromWei(await token.token.totalSupply());
      }
    }

    const sortCategory = async () => {
      const category = await getCategoryData(1);
      const categorySorted = sortArr(category);
      const receipt = await poolController.orderCategoryTokensByMarketCap(
        1, categorySorted.map((t) => t.token)
      ).then((r) => r.wait());
    }

    before(async () => {
      poolHelper = await getPoolHelper();
      const MockERC20 = await ethers.getContractFactory('MockERC20');

      newToken = await MockERC20.deploy('NewToken', 'NTK');
      newTokenAddress = newToken.address;
      await deployTokenMarket(newToken.address);
      await addLiquidity(newToken.address, 5, 5000);

      await newToken.getFreeTokens(from, nTokensHex(10000));
      const t = {
        initialPrice: 5,
        price: 5,
        token: newToken,
        address: newToken.address,
        totalSupply: 15000,
        symbol: 'NTK'
      };
      await poolController.addToken(newTokenAddress, 1);
      wrappedTokens.push(t);
      poolHelper.addToken(t);
      ({ tokens, balances, normalizedWeights } = await getPoolData());
      await bre.run('increaseTime', { days: 3.5 })
      await updateTokenPrices()
    });

    
    const mapToHex = (arr) => arr.map((i) => i.toString('hex'));
    const sortArr = (arr) => arr.sort((a, b) => {
      if (a.marketCap.lt(b.marketCap)) return 1;
      if (a.marketCap.gt(b.marketCap)) return -1;
      return 0;
    });

    async function getCategoryData(id) {
      const tokens = await poolController.getCategoryTokens(id);
      const marketCaps = await poolController.getCategoryMarketCaps(id);
      const arr = [];
      for (let i = 0; i < tokens.length; i++) {
        arr.push({
          token: tokens[i],
          marketCap: toBN(marketCaps[i])
        });
      }
      return arr;
    }

    it('Re-indexes the pool', async () => {
      await bre.run('increaseTime', { days: 11 });
      await updateTokenPrices();
      await bre.run('increaseTime', { days: 3 });
      await poolController.reweighPool(indexPool.address);
      await bre.run('increaseTime', { days: 11 });
      await updateTokenPrices();
      await bre.run('increaseTime', { days: 3 });
      await poolController.reweighPool(indexPool.address);
      await bre.run('increaseTime', { days: 11 });
      await updateTokenPrices();
      await bre.run('increaseTime', { days: 3 });
      await poolController.reweighPool(indexPool.address);
      await bre.run('increaseTime', { days: 11 });
      await updateTokenPrices();
      await bre.run('increaseTime', { days: 3 });
      await addLiquidityToAll();
      await sortCategory();
      await poolController.reindexPool(indexPool.address);
    });

    it('Marked the lowest token for removal', async () => {
      const lastToken = await poolController.getCategoryTokens(1).then(arr => arr[3]);
      const oldRecord = await indexPool.getTokenRecord(lastToken);
      expect(oldRecord.bound).to.be.true;
      expect(oldRecord.ready).to.be.true;
      expect(+fromWei(oldRecord.desiredDenorm)).to.eq(0);
    });

    it('Added the new token to the pool', async () => {
      const newRecord = await indexPool.getTokenRecord(newTokenAddress);
      expect(newRecord.bound).to.be.true;
      expect(newRecord.ready).to.be.false;
    });
  });
});