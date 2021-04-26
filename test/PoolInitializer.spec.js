const { BigNumber } = require('ethers');
const { controllerFixture } = require('./fixtures/controller.fixture');
const { zero, zeroAddress, fastForward, toWei, oneE18, verifyRejection, getFakerContract, expect, sqrt, fromWei } = require("./utils");
const { calcRelativeDiff } = require('./lib/calc_comparisons');

const errorDelta = 10 ** -8;
const ethValue = toWei(10);

describe('PoolInitializer.sol', async () => {
  let pool, initializer, controller, wrappedTokens, sortedWrappedTokens;
  let verifyRevert, liquidityManager;
  let updatePrices, uniswapOracle, addLiquidityAll;
  let signer1, signer2, signer3, signer4;
  let addresses;
  let tokens, desiredAmounts;
  let from;

  const getMarketCapSqrts = async (_tokens) => {
    const actualMarketCaps = await Promise.all(
      _tokens.map(async ({ token }) => liquidityManager.getTokenValue(token, await token.totalSupply()))
    );
    const capSqrts = actualMarketCaps.map(sqrt);
    const sqrtSum = capSqrts.reduce((total, capSqrt) => total.add(capSqrt), BigNumber.from(0));
    return [capSqrts, sqrtSum];
  }

  const getExpectedTokensAndBalances = async () => {
    await updatePrices(sortedWrappedTokens);
    await fastForward(7200);
    await addLiquidityAll();
    const [capSqrts, sqrtSum] = await getMarketCapSqrts(sortedWrappedTokens);
    const weightedEthValues = capSqrts.map((rt) => rt.mul(ethValue).div(sqrtSum));
    const expectedBalances = weightedEthValues.map((val, i) => liquidityManager.getEthValue(tokens[i], val));
    return [
      sortedWrappedTokens.map(t => t.address),
      expectedBalances
    ];
  };

  async function mintAndApprove(tokens, amounts, signer) {
    if (!signer) signer = signer1;
    const address = await signer.getAddress();
    for (let i = 0; i < tokens.length; i++) {
      const {token} = tokens[i];
      await token.connect(signer).getFreeTokens(address, amounts[i]);
      await token.connect(signer).approve(initializer.address, amounts[i]);
    }
  }

  const finish = async () => {
    const desiredTokens = await initializer.getDesiredTokens();
    const desiredAmounts = await initializer.getDesiredAmounts(desiredTokens);
    for (let i = 0; i < desiredTokens.length; i++) {
      const token = await ethers.getContractAt('MockERC20', desiredTokens[i]);
      await token.getFreeTokens(addresses[0], desiredAmounts[i]);
      await token.approve(initializer.address, desiredAmounts[i]);
    }
    await initializer['contributeTokens(address[],uint256[],uint256)'](desiredTokens, desiredAmounts, 0);
    await initializer.finish();
  }

  before(async () => {
    let signers = await ethers.getSigners();
    [signer1, signer2, signer3, signer4] = signers;
    addresses = await Promise.all(signers.map(s => s.getAddress()));
  });

  const setupTests = () => {
    before(async () => {
      await deployments.createFixture(async () => {
        ({
          wrappedTokens, controller, updatePrices, from,
          addLiquidityAll, uniswapOracle, liquidityManager
        } = await deployments.createFixture(controllerFixture)());
        wrappedTokens = wrappedTokens.slice(0, 5);
        sortedWrappedTokens = [...wrappedTokens].sort((a, b) => {
          if (a.marketcap < b.marketcap) return 1;
          if (a.marketcap > b.marketcap) return -1;
          return 0;
        });
        tokens = sortedWrappedTokens.map(t => t.address);
        await controller.setDefaultExitFeeRecipient(from);
        await controller.createCategory(`0x${'ff'.repeat(32)}`);
        await controller.addTokens(1, tokens);
        await fastForward(3600 * 48);
        await addLiquidityAll();
        await controller.orderCategoryTokensByMarketCap(1);
        await updatePrices(wrappedTokens);
        await fastForward(7200);
        await addLiquidityAll();
        const { events } = await controller.prepareIndexPool(1, 5, ethValue, 'Test Index Pool', 'TIP').then(tx => tx.wait());
        const { args: { pool: poolAddress, initializer: initializerAddress } } = events.filter(e => e.event == 'NewPoolInitializer')[0];
        pool = await ethers.getContractAt('IndexPool', poolAddress);
        initializer = await ethers.getContractAt('PoolInitializer', initializerAddress);
        verifyRevert = (...args) => verifyRejection(initializer, ...args);
      })();
    });
  };

  describe('initialize()', async () => {
    before(async () => {
      let PoolInitializer = await ethers.getContractFactory('PoolInitializer');
      initializer = await PoolInitializer.deploy(zeroAddress, addresses[0]);
    });

    it('Reverts if not called by controller', async () => {
      await verifyRejection(initializer.connect(signer2), 'initialize', /ERR_NOT_CONTROLLER/g, zeroAddress, [], []);
    });

    it('Reverts if array lengths do not match', async () => {
      await verifyRejection(initializer, 'initialize', /ERR_ARR_LEN/g, zeroAddress, [], [zero]);
    });

    it('Succeeds with valid inputs on first call', async () => {
      const poolAddress = `0x${'ff'.repeat(20)}`;
      await initializer.initialize(
        poolAddress,
        [`0x${'aa'.repeat(20)}`, `0x${'bb'.repeat(20)}`],
        [toWei(2), toWei(2)]
      );
    });

    it('Reverts if already initialized', async () => {
      await verifyRejection(initializer, 'initialize', /ERR_INITIALIZED/g, `0x${'ff'.repeat(20)}`, [], []);
    });
  });

  describe('_finished_', async () => {
    setupTests();

    it('All functions with _finished_ modifier revert if the initializer is not finished', async () => {
      let faker = getFakerContract(initializer);
      let allFinishedFns = ['claimTokens', 'claimTokens(address)', 'claimTokens(address[])'];
      for (let fn of allFinishedFns) {
        await verifyRejection(faker, fn, /ERR_NOT_FINISHED/g);
      }
    });
  });

  describe('_not_finished_', async () => {
    setupTests();

    it('All functions with _not_finished_ modifier revert if the initializer is finished', async () => {
      await finish();
      let faker = getFakerContract(initializer);
      let allFinishedFns = ['finish', 'contributeTokens', 'contributeTokens(address[],uint256[],uint256)'];
      for (let fn of allFinishedFns) await verifyRejection(faker, fn, /ERR_FINISHED/g);
    });
  });

  describe('isFinished()', async () => {
    setupTests();

    it('Returns false before finished', async () => {
      expect(await initializer.isFinished()).to.be.false;
    });

    it('Returns true after finished', async () => {
      await finish();
      expect(await initializer.isFinished()).to.be.true;
    });
  })

  describe('getDesiredTokens()', async () => {
    setupTests();

    it('Returns expected tokens', async () => {
      const actual = await initializer.getDesiredTokens();
      expect(actual).to.deep.eq(tokens);
    });
  });

  describe('getDesiredAmounts()', async () => {
    setupTests();
    
    it('Returns remaining desired amounts', async () => {
      let [,expected] = await getExpectedTokensAndBalances();
      let amounts = await initializer.getDesiredAmounts(tokens);
      for (let i = 0; i < 5; i++) {
        expect(+calcRelativeDiff(fromWei(expected[i]), fromWei(amounts[i]))).to.be.lte(errorDelta);
      }
      expected = new Array(5).fill(zero);
      await finish();
      amounts = await initializer.getDesiredAmounts(tokens);
      for (let i = 0; i < 5; i++) expect(amounts[i].eq(expected[i])).to.be.true;
    });
  });

  describe('getDesiredAmount()', async () => {
    setupTests();

    it('Returns expected desired amount', async () => {
      const [expectedTokens, expectedAmounts] = await getExpectedTokensAndBalances();
      for (let i = 0; i < 5; i++) {
        const expected = expectedAmounts[i];
        let actual = await initializer.getDesiredAmount(expectedTokens[i]);
        expect(+calcRelativeDiff(fromWei(actual), fromWei(expected))).to.be.lte(errorDelta);
        const { token } = sortedWrappedTokens[i];
        await token.getFreeTokens(addresses[0], expected.div(2));
        await token.approve(initializer.address, expected.div(2));
        await initializer['contributeTokens(address,uint256,uint256)'](expectedTokens[i], expected.div(2), 0);
        actual = await initializer.getDesiredAmount(expectedTokens[i]);
        expect(+calcRelativeDiff(fromWei(expected.div(2)), fromWei(actual))).to.be.lte(errorDelta);
      }
    });
  });

  describe('getCreditForTokens()', async () => {
    setupTests();

    it('Returns the eth value of the token', async () => {
      const [, desiredAmounts] = await getExpectedTokensAndBalances();
      for (let i = 0; i < 5; i++) {
        const expected = liquidityManager.getTokenValue(tokens[i], desiredAmounts[i]);
        const actual = await initializer.getCreditForTokens(tokens[i], desiredAmounts[i]);
        expect(+calcRelativeDiff(fromWei(expected), fromWei(actual))).to.be.lte(errorDelta);
      }
    });

    it('Reverts if the token is not desired', async () => {
      await finish();
      await verifyRevert('getCreditForTokens', /ERR_NOT_NEEDED/g, tokens[0], 1);
    });
  });

  describe('getTotalCredit()', async () => {
    setupTests();

    it('Returns total credited value', async () => {
      expect((await initializer.getTotalCredit()).eq(zero)).to.be.true;
      const amount = await initializer.getDesiredAmount(tokens[0]);
      const {token} = sortedWrappedTokens[0];
      await token.getFreeTokens(addresses[0], amount);
      await token.approve(initializer.address, amount);
      const credit = await initializer.callStatic['contributeTokens(address,uint256,uint256)'](tokens[0], amount, 0);
      await initializer['contributeTokens(address,uint256,uint256)'](tokens[0], amount, 0);
      expect((await initializer.getTotalCredit()).eq(credit)).to.be.true;
    });
  });

  describe('getCreditOf()', async () => {
    setupTests();

    it('Returns credited value for account', async () => {
      expect((await initializer.getCreditOf(addresses[0])).eq(zero)).to.be.true;
      const amount = await initializer.getDesiredAmount(tokens[0]);
      const {token} = sortedWrappedTokens[0];
      await token.getFreeTokens(addresses[0], amount);
      await token.approve(initializer.address, amount);
      const credit = await initializer.callStatic['contributeTokens(address,uint256,uint256)'](tokens[0], amount, 0);
      await initializer['contributeTokens(address,uint256,uint256)'](tokens[0], amount, 0);
      expect((await initializer.getCreditOf(addresses[0])).eq(credit)).to.be.true;
    });
  });

  describe('contributeTokens(address,uint256,uint256)', async () => {
    setupTests();

    it('Returns credited value', async () => {
      const [, desiredAmounts] = await getExpectedTokensAndBalances();
      for (let i = 0; i < 5; i++) {
        const { token } = sortedWrappedTokens[i];
        await token.getFreeTokens(addresses[0], desiredAmounts[i]);
        await token.approve(initializer.address, desiredAmounts[i]);
        const expected = liquidityManager.getTokenValue(tokens[i], desiredAmounts[i]);
        const actual = await initializer.callStatic['contributeTokens(address,uint256,uint256)'](tokens[i], desiredAmounts[i], 0);
        expect(+calcRelativeDiff(fromWei(expected), fromWei(actual))).to.be.lte(errorDelta);
      }
    });

    it('Reverts if credit < minCredit', async () => {
      const [, desiredAmounts] = await getExpectedTokensAndBalances();
      for (let i = 0; i < 5; i++) {
        const { token } = sortedWrappedTokens[i];
        await token.getFreeTokens(addresses[0], desiredAmounts[i]);
        await token.approve(initializer.address, desiredAmounts[i]);
        const expected = liquidityManager.getTokenValue(tokens[i], desiredAmounts[i]);
        await verifyRevert('contributeTokens(address,uint256,uint256)', /ERR_MIN_CREDIT/g, tokens[i], desiredAmounts[i], expected.mul(2));
      }
    });

    it('Reverts if amountIn = 0', async () => {
      for (let i = 0; i < 5; i++) {
        await verifyRevert('contributeTokens(address,uint256,uint256)', /ERR_ZERO_AMOUNT/g, tokens[i], zero, zero);
      }
    });

    it('Reverts if token not needed', async () => {
      for (let i = 0; i < 5; i++) {
        const { token } = sortedWrappedTokens[i];
        const amount = await initializer.getDesiredAmount(tokens[i]);
        await token.getFreeTokens(addresses[0], amount);
        await token.approve(initializer.address, amount);
        await initializer['contributeTokens(address,uint256,uint256)'](tokens[i], amount, 0);
        await verifyRevert('contributeTokens(address,uint256,uint256)', /ERR_NOT_NEEDED/g, tokens[i], 1, zero);
      }
    });
  });

  describe('contributeTokens(address[],uint256[],uint256)', async () => {
    setupTests();

    it('Returns credited value', async () => {
        const [, desiredAmounts] = await getExpectedTokensAndBalances();
        let expectedCredit = BigNumber.from(0);
        for (let i = 0; i < 5; i++) {
          const { token } = sortedWrappedTokens[i];
          await token.getFreeTokens(addresses[0], desiredAmounts[i]);
          await token.approve(initializer.address, desiredAmounts[i]);
          const expected = liquidityManager.getTokenValue(tokens[i], desiredAmounts[i]);
          expectedCredit = expectedCredit.add(expected);
        }
        const actualCredit = await initializer.callStatic['contributeTokens(address[],uint256[],uint256)'](tokens, desiredAmounts, 0);
        expect(+calcRelativeDiff(fromWei(expectedCredit), fromWei(actualCredit))).to.be.lte(errorDelta);
    });

    it('Reverts if array lengths do not match', async () => {
      await verifyRevert('contributeTokens(address[],uint256[],uint256)', /ERR_ARR_LEN/g, [zeroAddress], [zero, zero], zero);
    });

    it('Reverts if credit < minCredit', async () => {
      let expectedCredit = BigNumber.from(0);
      const amounts = await initializer.getDesiredAmounts(tokens);
      for (let i = 0; i < 5; i++) {
        const { token } = sortedWrappedTokens[i];
        await token.getFreeTokens(addresses[0], amounts[i]);
        await token.approve(initializer.address, amounts[i]);
        const expected = liquidityManager.getTokenValue(tokens[i], amounts[i]);
        expectedCredit = expectedCredit.add(expected);
      }
      await verifyRevert('contributeTokens(address[],uint256[],uint256)', /ERR_MIN_CREDIT/g, tokens, amounts, expectedCredit.mul(2));
    });

    it('Reverts if amountIn = 0', async () => {
      for (let i = 0; i < 5; i++) {
        await verifyRevert('contributeTokens(address[],uint256[],uint256)', /ERR_ZERO_AMOUNT/g, tokens, new Array(5).fill(zero), zero);
      }
    });

    it('Reverts if token not needed', async () => {
      const amounts = await initializer.getDesiredAmounts(tokens);
      for (let i = 0; i < 5; i++) {
        const { token } = sortedWrappedTokens[i];
        await token.getFreeTokens(addresses[0], amounts[i].mul(2));
        await token.approve(initializer.address, amounts[i].mul(2));
      }
      await initializer['contributeTokens(address[],uint256[],uint256)'](tokens, amounts, zero);
      await verifyRevert('contributeTokens(address[],uint256[],uint256)', /ERR_NOT_NEEDED/g, tokens, amounts, zero);
    });
  });

  describe('claimTokens()', async () => {
    setupTests();

    it('Claims tokens for the caller proportional to their credits', async () => {
      const amounts = await initializer.getDesiredAmounts(tokens);
      for (let i = 0; i < 5; i++) {
        const { token } = sortedWrappedTokens[i];
        await token.getFreeTokens(addresses[0], amounts[i]);
        await token.approve(initializer.address, amounts[i]);
      }
      await initializer['contributeTokens(address[],uint256[],uint256)'](tokens, amounts, zero);
      await initializer.finish();
      await initializer['claimTokens()']();
      expect((await initializer.getCreditOf(addresses[0])).eq(zero)).to.be.true;
      expect((await pool.balanceOf(addresses[0])).eq(toWei(100))).to.be.true;
    });
  });
  
  describe('claimTokens(address)', async () => {
    setupTests();

    it('Claims tokens for the provided account proportional to their credits', async () => {
      const amounts = await initializer.getDesiredAmounts(tokens);
      for (let i = 0; i < 5; i++) {
        const { token } = sortedWrappedTokens[i];
        await token.connect(signer2).getFreeTokens(addresses[1], amounts[i]);
        await token.connect(signer2).approve(initializer.address, amounts[i]);
      }
      await initializer.connect(signer2)['contributeTokens(address[],uint256[],uint256)'](tokens, amounts, zero);
      await initializer.finish();
      await initializer['claimTokens(address)'](addresses[1]);
      expect((await initializer.getCreditOf(addresses[1])).eq(zero)).to.be.true;
      expect((await pool.balanceOf(addresses[1])).eq(toWei(100))).to.be.true;
    });
  });

  describe('claimTokens(address[])', async () => {
    setupTests();

    it('Claims tokens for the provided accounts proportional to their credits', async () => {
      let amounts = await initializer.getDesiredAmounts(tokens);
      await mintAndApprove(sortedWrappedTokens, amounts.map(a => a.div(2)), signer2);
      await initializer.connect(signer2)['contributeTokens(address[],uint256[],uint256)'](tokens, amounts.map(a => a.div(2)), zero);
      amounts = await initializer.getDesiredAmounts(tokens);
      await mintAndApprove(sortedWrappedTokens, amounts, signer3);
      await initializer.connect(signer3)['contributeTokens(address[],uint256[],uint256)'](tokens, amounts, zero);
    
      const totalCredit = await initializer.getTotalCredit();
      await initializer.finish();
      await initializer['claimTokens(address[])']([addresses[1], addresses[2]]);
      expect((await initializer.getCreditOf(addresses[1])).eq(zero)).to.be.true;
      expect((await initializer.getCreditOf(addresses[2])).eq(zero)).to.be.true;
      expect(+calcRelativeDiff(50, fromWei(await pool.balanceOf(addresses[1])))).to.be.lte(errorDelta);
      expect(+calcRelativeDiff(50, fromWei(await pool.balanceOf(addresses[2])))).to.be.lte(errorDelta);
      expect((await initializer.getTotalCredit()).eq(totalCredit)).to.be.true;
    });
  });

  describe('finish()', async () => {
    setupTests();

    it('Reverts if there are remaining desired amounts for any tokens', async () => {
      const inTokens = sortedWrappedTokens.slice(0, 4);
      const amounts = await initializer.getDesiredAmounts(tokens.slice(0, 4));
      await mintAndApprove(inTokens, amounts);
      await initializer['contributeTokens(address[],uint256[],uint256)'](tokens.slice(0, 4), amounts, zero);
      await verifyRevert('finish', /ERR_PENDING_TOKENS/g);
    });

    it('Sets finished to true', async () => {
      const amount = await initializer.getDesiredAmount(tokens[4]);
      await mintAndApprove([sortedWrappedTokens[4]], [amount]);
      await initializer['contributeTokens(address,uint256,uint256)'](tokens[4], amount, zero);
      await initializer.finish();
      expect(await initializer.isFinished()).to.be.true;
    });
  });
});