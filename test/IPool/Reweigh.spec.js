const { expect } = require('chai').use(require('chai-as-promised'));
const { poolFixture } = require("../fixtures/pool.fixture");
const { calcRelativeDiff } = require('../lib/calc_comparisons');
const { expandTo18Decimals, toWei, fromWei, fastForward, maxUint256: maxPrice, verifyRejection, zero, zeroAddress } = require("../utils");

const errorDelta = 10 ** -8;

describe('reweighTokens()', async () => {
  let wrappedTokens, indexPool, unbindTokenHandler, poolHelper;
  let getPoolData, mintAndApprove, callAndSend;
  let tokens, balances, denormalizedWeights, normalizedWeights;
  let verifyRevert, erc20Factory, newToken;
  let from;

  before(async () => {
    erc20Factory = await ethers.getContractFactory("MockERC20");
    newToken = await erc20Factory.deploy('New Token', 'NTT');
  });

  const setupTests = () => {
    before(async () => {
      ({
        wrappedTokens,
        indexPool,
        unbindTokenHandler,
        poolHelper,
        getPoolData,
        mintAndApprove,
        callAndSend,
        verifyRevert,
        from
      } = await deployments.createFixture(poolFixture)());
      await updateData();
    });
  }

  const updateData = async () => {
    ({ tokens, balances, denormalizedWeights, normalizedWeights } = await getPoolData());
  };

  const testPoolTokens = () => {
    describe('Pool records match expected', async () => {
      let records = {};
      let poolTokens, desiredTokens;

      before(async () => {
        poolTokens = await indexPool.getCurrentTokens();
        desiredTokens = await indexPool.getCurrentDesiredTokens();
        await Promise.all(poolTokens.map(async (t) => {
          records[t] = await indexPool.getTokenRecord(t)
        }));
      });

      it('getCurrentTokens()', async () => {
        expect(poolTokens).to.deep.eq(poolHelper.tokens);
      });

      it('getCurrentDesiredTokens()', async () => {
        const expected = poolTokens.filter(t => poolHelper.records[t].desiredDenorm > 0);
        expect(desiredTokens).to.deep.eq(expected);
      });

      it('all::record.denorm', async () => {
        for (let t of poolTokens) {
          const expected = poolHelper.records[t].denorm;
          const actual = fromWei(records[t].denorm);

          expect(+calcRelativeDiff(expected, actual)).to.be.lte(errorDelta);
        }
      });

      it('all::record.desiredDenorm', async () => {
        for (let t of poolTokens) {
          const expected = toWei(poolHelper.records[t].desiredDenorm);
          const actual = records[t].desiredDenorm;
          expect(expected.eq(actual)).to.be.true;
        }
      });

      it('all::record.ready', async () => {
        for (let t of poolTokens) {
          const expected = poolHelper.records[t].ready;
          const actual = records[t].ready;
          expect(expected).to.eq(actual);
        }
      });
    });
  }

  describe('reweighTokens(): fail', async () => {
    setupTests();

    it('Reverts if caller is not controller', async () => {
      const [_, notController] = await ethers.getSigners();
      await verifyRejection(
        indexPool.connect(notController),
        'reweighTokens',
        /ERR_NOT_CONTROLLER/g,
        [poolHelper.tokens[0]],
        [1]
      );
    });

    it('Reverts if invalid array length is given', async () => {
      const tokens = poolHelper.tokens;
      await expect(indexPool.reweighTokens(tokens, [0])).to.be.rejectedWith(/ERR_ARR_LEN/g);
    });

    it('Reverts if a token is not bound', async () => {
      await expect(indexPool.reweighTokens([`0x${'00'.repeat(20)}`], [0])).to.be.rejectedWith(/ERR_NOT_BOUND/g);
    });

    it('Reverts if desiredDenorm < MIN_WEIGHT', async () => {
      await expect(indexPool.reweighTokens([poolHelper.tokens[0]], [1])).to.be.rejectedWith(/ERR_MIN_WEIGHT/g);
    });

    it('Reverts if desiredDenorm > MAX_WEIGHT', async () => {
      await expect(indexPool.reweighTokens([poolHelper.tokens[0]], [expandTo18Decimals(51)])).to.be.rejectedWith(/ERR_MAX_WEIGHT/g);
    });
  });

  describe('reweighTokens(): Set one target to 0', async () => {
    setupTests();

    it('Allows desired weight to be set to 0', async () => {
      const tokenOut = poolHelper.tokens[2]
      poolHelper.records[tokenOut].desiredDenorm = 0;
      const tokens = poolHelper.tokens;
      const denorms = tokens.map(t => toWei(poolHelper.records[t].desiredDenorm));
      await indexPool.reweighTokens(tokens, denorms);
    });

    testPoolTokens();
  });

  describe('reweighTokens(): success', async () => {
    setupTests();

    it('reweighTokens()', async () => {
      const [wbtc, wltc, wtkn] = poolHelper.tokens;
      poolHelper.records[wbtc].price = 9;
      poolHelper.records[wltc].price = 4;
      poolHelper.records[wtkn].price = 6;
      poolHelper.setDesiredWeights();
      const tokens = poolHelper.tokens;
      const denorms = tokens.map(t => toWei(poolHelper.records[t].desiredDenorm));
      await fastForward(3600);
      await indexPool.reweighTokens(tokens, denorms);
    });

    describe('Adjust weights during swaps and joins', async () => {
      let tokens, balances;
  
      before(async () => {
        ({ tokens, balances } = await getPoolData());
      });

      const verifyWeightChanges = async (tokenIn, tokenOut, fn) => {
        let denormInitial_in, denormInitial_out;
        let postDenorm_in, postDenorm_out;
        if (tokenIn) {
          denormInitial_in = await indexPool.getDenormalizedWeight(tokenIn);
        }
        if (tokenOut) {
          denormInitial_out = await indexPool.getDenormalizedWeight(tokenOut);
        }
        const res = await fn();
        if (tokenIn) {
          postDenorm_in = await indexPool.getDenormalizedWeight(tokenIn);
          expect(postDenorm_in.gte(denormInitial_in)).to.be.true;
          expect(+calcRelativeDiff(poolHelper.records[tokenIn].denorm, fromWei(postDenorm_in))).to.be.lte(errorDelta);
        }
        if (tokenOut) {
          postDenorm_out = await indexPool.getDenormalizedWeight(tokenOut);
          expect(postDenorm_out.lte(denormInitial_out)).to.be.true;
          expect(+calcRelativeDiff(poolHelper.records[tokenOut].denorm, fromWei(postDenorm_out))).to.be.lte(errorDelta);
        }
        return res;
      }
    
      it('swapExactAmountIn', async () => {
        for (let i = 0; i < tokens.length; i++) {
          const tokenIn = tokens[i];
          const tokenAmountIn = balances[i].div(50);
          await mintAndApprove(tokenIn, tokenAmountIn.mul(2));
          for (let o = 0; o < tokens.length; o++) {
            await fastForward(3600);
            const tokenOut = tokens[o];
            if (tokenOut == tokenIn) continue;
            const computed = poolHelper.calcOutGivenIn(tokenIn, tokenOut, fromWei(tokenAmountIn), true, true);
            const output = await verifyWeightChanges(
              tokenIn,
              tokenOut,
              () => callAndSend('swapExactAmountIn', tokenIn, tokenAmountIn, tokenOut, 0, maxPrice)
            )
            let expected = computed[0];
            let actual = fromWei(output[0]);

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
        for (let i = 0; i < tokens.length; i++) {
          const tokenIn = tokens[i];
          const maxAmountIn = maxPrice;
          for (let o = 0; o < tokens.length; o++) {
            await fastForward(3600);
            const tokenOut = tokens[o];
            if (tokenOut == tokenIn) continue;
            const tokenAmountOut = balances[o].div(50);
            const computed = poolHelper.calcInGivenOut(tokenIn, tokenOut, fromWei(tokenAmountOut), true, true);
            // increase the approved tokens by 1% because the math on the decimal -> bn
            // has minor rounding errors
            await mintAndApprove(tokenIn, toWei(computed[0].mul(1.01)));
            const output = await verifyWeightChanges(
              tokenIn,
              tokenOut,
              () => callAndSend('swapExactAmountOut', tokenIn, maxAmountIn, tokenOut, tokenAmountOut, maxPrice)
            );
            // Check the token input amount
            let expected = computed[0];
            let actual = fromWei(output[0]);
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

      it('joinswapExternAmountIn', async () => {
        await fastForward(3600);
        ({ balances } = await getPoolData());
        for (let i = 0; i < tokens.length; i++) {
          const tokenIn = tokens[i];
          const tokenAmountIn = balances[i].div(50);
          const computed = poolHelper.calcPoolOutGivenSingleIn(tokenIn, fromWei(tokenAmountIn), true);
          await mintAndApprove(tokenIn, tokenAmountIn);
          const output = await verifyWeightChanges(
            tokenIn,
            undefined,
            () => callAndSend('joinswapExternAmountIn', tokenIn, tokenAmountIn, 0)
          );
          const relDiff = calcRelativeDiff(computed, fromWei(output));
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
        }
      });

      it('joinswapPoolAmountOut', async () => {
        await fastForward(3600);
        ({ balances } = await getPoolData());
        for (let i = 0; i < tokens.length; i++) {
          const tokenIn = tokens[i];
          const poolAmountOut = toWei(2);
          const computed = poolHelper.calcSingleInGivenPoolOut(tokenIn, fromWei(poolAmountOut), true);
          await mintAndApprove(tokenIn, toWei(computed).mul(2));
          const output = await verifyWeightChanges(
            tokenIn,
            undefined,
            () => callAndSend('joinswapPoolAmountOut', tokenIn, poolAmountOut, maxPrice)
          );
          const relDiff = calcRelativeDiff(computed, fromWei(output));
          expect(relDiff.toNumber()).to.be.lte(errorDelta);
        }
      });
    });

    testPoolTokens();
  });

  describe('reindexTokens(): fail', async () => {
    setupTests();

    it('Reverts if caller is not controller', async () => {
      const [, signer2] = await ethers.getSigners();
      await expect(indexPool.connect(signer2).reindexTokens([zeroAddress], [zero], [zero])).to.be.rejectedWith(/ERR_NOT_CONTROLLER/g);
    });

    it('Reverts if array lengths do not match', async () => {
      await verifyRevert(
        'reindexTokens',
        /ERR_ARR_LEN/g,
        [tokens[0]],
        [denormalizedWeights[0], denormalizedWeights[1]],
        [balances[0]]
      );
      await verifyRevert(
        'reindexTokens',
        /ERR_ARR_LEN/g,
        [tokens[0], tokens[1]],
        [denormalizedWeights[0]],
        [balances[0]]
      );
      await verifyRevert(
        'reindexTokens',
        /ERR_ARR_LEN/g,
        [tokens[0]],
        [denormalizedWeights[0]],
        [balances[0], balances[1]]
      );
    });

    it('Reverts if minimumBalance < MIN_BALANCE', async () => {
      await verifyRevert(
        'reindexTokens',
        /ERR_MIN_BALANCE/g,
        [newToken.address],
        [denormalizedWeights[0]],
        [zero]
      );
    });

    it('Reverts if desiredDenorm > MAX_WEIGHT', async () => {
      await verifyRevert(
        'reindexTokens',
        /ERR_MAX_WEIGHT/g,
        [newToken.address],
        [toWei(100)],
        [zero]
      );
    });
  });

  describe('reindexTokens(): success', async () => {
    before(async () => {
      newToken = await erc20Factory.deploy('New Token', 'NTT');
      const IPool = await ethers.getContractFactory('IndexPool');
      indexPool = await IPool.deploy();
      await indexPool.configure(from, 'pool', 'pool symbol', from);
      for (let i = 0; i < tokens.length; i++) {
        const token = await ethers.getContractAt('MockERC20', tokens[i]);
        await token.getFreeTokens(from, toWei(1));
        await token.approve(indexPool.address, toWei(1));
      }
      denormalizedWeights = new Array(3).fill(toWei('0.3'));
      balances = new Array(3).fill(toWei(1));
      await indexPool.initialize(
        tokens,
        balances,
        denormalizedWeights,
        from,
        unbindTokenHandler.address
      );
    });

    it('Sets desiredDenorm to MIN_WEIGHT if 0 is provided', async () => {
      await indexPool.reindexTokens(
        [tokens[0], tokens[1], tokens[2]],
        [denormalizedWeights[0], zero, zero],
        [balances[0], balances[1], balances[2]]
      );
      const record1 = await indexPool.getTokenRecord(tokens[1]);
      const record2 = await indexPool.getTokenRecord(tokens[2]);
      expect(record1.desiredDenorm.eq(toWei('0.25'))).to.be.true;
      expect(record2.desiredDenorm.eq(toWei('0.25'))).to.be.true;
    });

    it('Sets desiredDenorm of tokens not included in the call to zero', async () => {
      const [tokenToRemove, ...includedTokens] = tokens;
      const [, ...includedDenorms] = denormalizedWeights;
      poolHelper.records[tokenToRemove].desiredDenorm = 0;
      poolHelper.tokens.push(newToken.address);
      poolHelper.records[newToken.address] = {
        minimumBalance: 1,
        balance: 0,
        desiredDenorm: 1,
        ready: false,
        totalSupply: 5
      };
      await indexPool.reindexTokens(
        [...includedTokens, newToken.address],
        [...includedDenorms, toWei(1)],
        balances
      );
      const record0 = await indexPool.getTokenRecord(tokens[0]);
      expect(record0.desiredDenorm.eq(0)).to.be.true;
      const recordNew = await indexPool.getTokenRecord(newToken.address);
      expect(recordNew.desiredDenorm.eq(toWei(1))).to.be.true;
      expect(recordNew.ready).to.be.false;
    });

    it('Swaps new token in until it is initialized', async () => {
      const amountIn = toWei('0.24');
      const amtTotal = toWei(2);
      await newToken.getFreeTokens(from, amtTotal);
      await newToken.approve(indexPool.address, toWei(2));
      for (let i = 0; i < 5; i++) {
        await indexPool.swapExactAmountIn(newToken.address, amountIn, tokens[1], zero, maxPrice);
      }
      const denorm = await indexPool.getDenormalizedWeight(newToken.address);
      expect(+calcRelativeDiff(0.3, fromWei(denorm))).to.be.lte(errorDelta)
    });

    it('Swaps old token out until it is removed', async () => {
      const record0 = await indexPool.getTokenRecord(tokens[0]);
      const current = +fromWei(record0.denorm);
      const iterations = Math.ceil((Math.log(0.01) - Math.log(current / 25)) / Math.log(0.99));
      const amountIn = toWei(0.1);
      console.log(`Should take ${iterations} steps to remove`);
      const totalAmountIn = amountIn.mul(iterations);
      await newToken.getFreeTokens(from, totalAmountIn);
      await newToken.approve(indexPool.address, totalAmountIn);
      for (let i = 0; i < iterations; i++) {
        await fastForward(3600);
        await indexPool.swapExactAmountIn(newToken.address, amountIn, tokens[0], zero, maxPrice);
      }
      expect(await indexPool.isBound(tokens[0])).to.be.false;
    });
  });

  describe('MAX_TOTAL_WEIGHT', () => {
    let pool, token0, token1;
    async function prepare(denorms) {
      const IPoolFactory = await ethers.getContractFactory("IndexPool");
      pool = await IPoolFactory.deploy();
      const ERC20 =  await ethers.getContractFactory("MockERC20");
      await pool.configure(from, 'n', 's', from);
      token0 = await ERC20.deploy('a','a');
      token1 = await ERC20.deploy('b','b');
      await token0.getFreeTokens(from, toWei(20));
      await token1.getFreeTokens(from, toWei(20));
      await token0.approve(pool.address, toWei(20));
      await token1.approve(pool.address, toWei(20));
      await pool.initialize(
        [token0.address, token1.address],
        [toWei(10), toWei(10)],
        denorms,
        from,
        from
      );
    }

    it('Input weight update fails gracefully if it would exceed maximum', async () => {
      await prepare([toWei(13.5), toWei(13.5)])
      await pool.reweighTokens(
        [token0.address, token1.address],
        [toWei(14), toWei(13)],
      );
      await fastForward(3600);
      await pool.swapExactAmountIn(token0.address, toWei(1), token1.address, zero, maxPrice);
      expect((await pool.getTotalDenormalizedWeight()).toString()).to.eq(toWei(27).toString())
    })

    it('Input weight update succeeds if reduction in output weight makes room', async () => {
      await prepare([toWei(13.5), toWei(13.5)])
      await pool.reweighTokens(
        [token0.address, token1.address],
        [toWei(14), toWei(10)],
      );
      await fastForward(3600);
      await pool.swapExactAmountIn(token0.address, toWei(1), token1.address, zero, maxPrice);
      expect((await pool.getTotalDenormalizedWeight()).toString()).to.eq(toWei(27).toString())
    })
  })
});