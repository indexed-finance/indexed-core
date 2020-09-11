const chai = require("chai");
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);

const UniswapHelper = require('./lib/uniswap-helper');
const createKeccakHash = require('keccak');
const BN = require('bn.js');
const Decimal = require('decimal.js');

const { nTokens, nTokensHex, oneToken } = require('./lib/tokens');
const { wrapped_tokens: wrappedTokens } = require('./testData/categories.json');
const { calcRelativeDiff } = require('./lib/calc_comparisons');
const PoolHelper = require("./lib/pool-helper");

const { expect } = chai;
const keccak256 = (data) => `0x${createKeccakHash('keccak256').update(data).digest().toString('hex')}`;

const toBN = (bn) => BN.isBN(bn) ? bn : bn._hex ? new BN(bn._hex.slice(2), 'hex') : new BN(bn);

const exitFee = 0;
const swapFee = 0.025;
const errorDelta = 10 ** -8;


describe("Pool Controller", () => {
  let uniswapHelper, from, marketOracle, weth, poolController, indexPool, erc20Factory;
  let timestampAddition = 0;

  const getTimestamp = () => Math.floor(new Date().getTime() / 1000) + timestampAddition;
  const increaseTimeByDays = (days = 1) => {
    timestampAddition += days * 24 * 60 * 60;
    const timestamp = getTimestamp();
    return web3.currentProvider._sendJsonRpcRequest({
      method: "evm_setNextBlockTimestamp",
      params: [timestamp],
      jsonrpc: "2.0",
      id: new Date().getTime()
    });
  }
  const fromWei = (_bn) => web3.utils.fromWei(toBN(_bn).toString(10));
  const toWei = (_bn) => web3.utils.toWei(toBN(_bn).toString(10));

  before(async () => {
    [from] = await web3.eth.getAccounts();
    erc20Factory = await ethers.getContractFactory("MockERC20");
    uniswapHelper = new UniswapHelper(web3, from, erc20Factory, getTimestamp);
    await uniswapHelper.init();
    weth = uniswapHelper.weth;
    const oracleFactory = await ethers.getContractFactory("MarketOracle");
    marketOracle = await oracleFactory.deploy(
      uniswapHelper.uniswapFactory.options.address,
      weth.options.address,
      from
    );
  });

  it('Should deploy the Pool Controller', async () => {
    const poolFactory = await ethers.getContractFactory("BPool");
    console.log('poolfactory', !!poolFactory);
    const pool = await poolFactory.deploy();
    console.log('pool', !!pool.address);
    const controllerFactory = await ethers.getContractFactory("PoolController");
    poolController = await controllerFactory.deploy(marketOracle.address, pool.address);
  });

  describe('Initialize Markets', async () => {
    it('Should deploy the wrapped token market pairs', async () => {
      for (let i = 0; i < wrappedTokens.length; i++) {
        const { name, symbol, initialPrice } = wrappedTokens[i];
        const token = await uniswapHelper.deployTokenAndMarket(name, symbol, initialPrice, 251);
        wrappedTokens[i] = token;
        await token.token.getFreeTokens(from, nTokensHex(5000));
      }
    });
  });

  describe('Initialize Oracle', async () => {
    it('Should create a wrapped tokens category', async () => {
      const metadata = {
        name: 'Wrapped Tokens',
        description: 'Category for wrapped tokens.'
      };
      const metadataHash = keccak256(JSON.stringify(metadata));
      const receipt = await marketOracle.createCategory(metadataHash);
      const { events } = await receipt.wait();
      expect(events.length).to.eql(1);
      const [event] = events;
      expect(event.event).to.eql('CategoryAdded');
      expect(event.args.metadataHash).to.eql(metadataHash);
      expect(event.args.categoryID.toNumber()).to.eql(1);
    });

    it('Should add tokens to the wrapped tokens category', async () => {
      const opts = {
        categoryID: 1,
        tokens: wrappedTokens.map(t => t.address)
      };
      await marketOracle.addTokens([opts]).then(r => r.wait());
    });

    it('Should update the block timestamp', async () => {
      await increaseTimeByDays();
    });

    it('Should return the correct market caps', async () => {
      const caps = [];
      for (let i = 0; i < wrappedTokens.length; i++) {
        const { symbol, address, initialPrice } = wrappedTokens[i];
        // In order to update the cumulative prices on the market pairs,
        // we need to add some more liquidity (could also execute trades)
        await uniswapHelper.addTokenLiquidity(symbol, initialPrice, 255);
        const expectedMarketCap = nTokens(5506).muln(initialPrice);
        const realMarketCap = await marketOracle.computeAverageMarketCap(address)
          .then(toBN);
        const pct = realMarketCap.div(expectedMarketCap);
        expect(pct.eqn(1)).to.be.true;
        caps.push(realMarketCap.toString('hex'));
      }
      const categoryCaps = await marketOracle.getCategoryMarketCaps(1);
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
      const tokens = await marketOracle.getCategoryTokens(id);
      const marketCaps = await marketOracle.getCategoryMarketCaps(id);
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
      const marketCaps = [10, 1, 2].map(n => nTokens(5506).muln(n));
      expect(
        mapToHex(category.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCaps));
      const categorySorted = sortArr(category);
      const marketCapsSorted = [10, 2, 1].map(n => nTokens(5506).muln(n));
      expect(
        mapToHex(categorySorted.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCapsSorted));
      const receipt = await marketOracle.orderCategoryTokensByMarketCap(
        1, categorySorted.map((t) => t.token)
      ).then((r) => r.wait());
      const categoryAfterSort = await getCategoryData(1);
      expect(
        mapToHex(categoryAfterSort.map((t) => t.marketCap))
      ).to.deep.equal(mapToHex(marketCapsSorted));
      console.log(`Cost To Sort Tokens: ${toBN(receipt.cumulativeGasUsed).toNumber()}`)
    });
  });

  describe('Pool Deployment', async () => {
    let sortedTokens = [];
    let normalizedWeights_real = [], denormalizedWeights_real = [], balances_real = [];

    before(async () => {
      const sortedTokenAddresses = await marketOracle.getTopCategoryTokens(1, 3);
      sortedTokens = sortedTokenAddresses.map(addr => uniswapHelper.getTokenByAddress(addr));
      let sum_qrts = 0;
      for (let token of sortedTokens) {
        const mkt_cap = Math.sqrt(5506 * token.initialPrice);
        sum_qrts += mkt_cap;
      }
      const totalValue = nTokens(20);
      const max_weight = nTokens(50);
      for (let token of sortedTokens) {
        const mkt_cap = Math.sqrt(5506 * token.initialPrice);
        const weight = mkt_cap / sum_qrts;
        normalizedWeights_real.push(weight);
        denormalizedWeights_real.push(max_weight.muln(weight));
        balances_real.push(totalValue.muln(weight).divn(token.initialPrice));
      }
    });

    const diffAsPct = (a, b) => {
      const diff = a.sub(b);
      const expandedDiff = a.div(diff).toNumber();
      return 100 / expandedDiff;
    }

    it('Computes the correct balances and denormalized weights', async () => {
      const { balances, denormalizedWeights } = await poolController.getInitialTokenWeightsAndBalances(1, 3, nTokensHex(20));
      for (let i = 0; i < balances.length; i++) {
        const balance = toBN(balances[i]);
        const denormalizedWeight = toBN(denormalizedWeights[i]);
        const balanceReal = balances_real[i];
        const denormalizedWeight_real = denormalizedWeights_real[i];
        const balPctDiff = diffAsPct(balance, balanceReal);
        const weightPctDiff = diffAsPct(denormalizedWeight, denormalizedWeight_real);
        expect(balPctDiff < 0.1);
        expect(weightPctDiff < 0.1);
      }
    });
    
    it('Gives tokens to the pool controller', async () => {
      const { tokens, balances } = await poolController.getInitialTokenWeightsAndBalances(1, 3, nTokensHex(20));
      const controllerAddress = poolController.address;
      for (let i = 0; i < balances.length; i++) {
        const token = await ethers.getContractAt('MockERC20', tokens[i]);
        await token.transfer(controllerAddress, balances[i]);
        const controllerBalance = await token.balanceOf(controllerAddress);
        expect(controllerBalance).to.equal(balances[i]);
      }
    });

    it('Fails to deploy an index for a category that does not exist', async () => {
      expect(
        poolController.deployIndexPool(
          2,
          3,
          "Invalid category index",
          "BADC2",
          nTokensHex(100000)
        ).then(r => r.wait())
      ).to.be.rejectedWith(/Category does not exist/g);
    });

    it('Deploys the category index pool', async () => {
      const expectedAddress = await poolController.computePoolAddress(1, 3);
      const receipt = await poolController.deployIndexPool(
        1,
        3,
        "Top 3 Wrapped Tokens Index",
        "WTI3",
        nTokensHex(20)
      );
      const { events, gasUsed } = await receipt.wait();
      console.log(`Pool Deployment Cost: ${gasUsed}`);
      const event = events.filter(e => e.event == 'LOG_NEW_POOL')[0]
      const {
        pool,
        categoryID,
        indexSize
      } = event.args;
      expect(pool).to.equal(expectedAddress);
      expect(categoryID).to.equal(categoryID);
      expect(indexSize).to.equal(indexSize);
      indexPool = await ethers.getContractAt('BPool', expectedAddress);
    });

    it('Sets the controller address on deployment', async () => {
      const controllerAddress = await indexPool.getController();
      expect(controllerAddress).to.equal(poolController.address);
    });

    it('Enables public swapping', async () => {
      const isPublicSwap = await indexPool.isPublicSwap();
      expect(isPublicSwap).to.be.true;
    });

    it('Sets the correct token name and symbol', async () => {
      const name = await indexPool.name();
      expect(name).to.equal("Top 3 Wrapped Tokens Index");
      const symbol = await indexPool.symbol();
      expect(symbol).to.equal("WTI3");
    });
  });

  describe('Pool Initialization', async () => {
    let tokens, balances, denormalizedWeights;

    before(async () => {
      ({ tokens, balances, denormalizedWeights } = await poolController.getInitialTokenWeightsAndBalances(1, 3, nTokensHex(20)))
    });

    it('Set the correct tokens', async () => {
      const currentTokens = await indexPool.getCurrentTokens();
      expect(currentTokens).to.deep.equal(tokens);
    });

    it('Pulled the correct balances', async () => {
      const poolBalances = await Promise.all(tokens.map(token => indexPool.getBalance(token)));
      expect(poolBalances).to.deep.equal(balances);
    });

    it('Set the correct denormalized weights', async () => {
      const poolWeights = await Promise.all(tokens.map(token => indexPool.getDenormalizedWeight(token)));
      expect(poolWeights).to.deep.equal(denormalizedWeights);
    });

    it('Minted the correct amount of tokens for the controller', async () => {
      const expectedBalance = nTokensHex(100);
      const balance = await indexPool.balanceOf(poolController.address);
      expect(balance).to.equal(expectedBalance);
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

  async function swapDataFromReceipt(receipt) {
    const { events } = receipt.wait ? await receipt.wait() : receipt;
    return events.filter(e => e.event == 'LOG_SWAP')[0].args;
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
      const {token} = uniswapHelper.getTokenByAddress(tokenAddress);
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
        const {token} = uniswapHelper.getTokenByAddress(tokenIn);
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
    let poolHelper, tokens, balances, normalizedWeights;
    let newToken, newTokenAddress;

    const updateTokenPrices = async () => {
      for (let token of wrappedTokens) {
        await uniswapHelper.addTokenLiquidity(token.symbol, token.initialPrice, 5);
        if (await marketOracle.canUpdatePrice(token.address)) {
          await marketOracle.updatePrice(token.address);
        }
        token.totalSupply = +fromWei(await token.token.totalSupply());
        poolHelper.records[token.address].totalSupply = token.totalSupply;
      }
    }

    const addLiquidityToAll = async () => {
      for (let token of wrappedTokens) {
        await uniswapHelper.addTokenLiquidity(token.symbol, token.initialPrice, 5);
        token.totalSupply = +fromWei(await token.token.totalSupply());
      }
    }

    const sortCategory = async () => {
      const category = await getCategoryData(1);
      const categorySorted = sortArr(category);
      const receipt = await marketOracle.orderCategoryTokensByMarketCap(
        1, categorySorted.map((t) => t.token)
      ).then((r) => r.wait());
    }

    before(async () => {
      poolHelper = await getPoolHelper();
      ({
        token: newToken,
        address: newTokenAddress
      } = await uniswapHelper.deployTokenAndMarket('NewToken', 'NTK', 5, 251));
      await newToken.getFreeTokens(from, nTokensHex(10000));
      const t = {
        initialPrice: 5,
        price: 5,
        token: newToken,
        address: newTokenAddress,
        totalSupply: 10251,
        symbol: 'NTK'
      };
      await marketOracle.addToken(newTokenAddress, 1);
      wrappedTokens.push(t);
      poolHelper.addToken(t);
      ({ tokens, balances, normalizedWeights } = await getPoolData());
      console.log(wrappedTokens[3].totalSupply)
      await increaseTimeByDays();
      await updateTokenPrices()
    });

    
    const mapToHex = (arr) => arr.map((i) => i.toString('hex'));
    const sortArr = (arr) => arr.sort((a, b) => {
      if (a.marketCap.lt(b.marketCap)) return 1;
      if (a.marketCap.gt(b.marketCap)) return -1;
      return 0;
    });

    async function getCategoryData(id) {
      const tokens = await marketOracle.getCategoryTokens(id);
      const marketCaps = await marketOracle.getCategoryMarketCaps(id);
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
      await increaseTimeByDays(14);
      await updateTokenPrices();
      await poolController.reweighPool(indexPool.address);
      await increaseTimeByDays(14);
      await updateTokenPrices();
      await poolController.reweighPool(indexPool.address);
      await increaseTimeByDays(14);
      await updateTokenPrices();
      await poolController.reweighPool(indexPool.address);
      await increaseTimeByDays(14);
      await updateTokenPrices();
      await addLiquidityToAll();
      await sortCategory();
      await poolController.reindexPool(1, 3);
    });

    it('Marked the lowest token for removal', async () => {
      const lastToken = await marketOracle.getCategoryTokens(1).then(arr => arr[3]);
      const oldRecord = await indexPool.getTokenRecord(lastToken);
      expect(oldRecord.bound).to.be.true;
      expect(oldRecord.ready).to.be.true;
      expect(oldRecord.desiredDenorm).to.eq(0);
    });

    it('Added the new token to the pool', async () => {
      const newRecord = await indexPool.getTokenRecord(newTokenAddress);
      expect(newRecord.bound).to.be.true;
      expect(newRecord.ready).to.be.false;
    });
  });
});