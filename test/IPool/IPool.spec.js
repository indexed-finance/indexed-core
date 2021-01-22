const Decimal = require('decimal.js');
const { calcRelativeDiff } = require('../lib/calc_comparisons');
const { poolFixture } = require("../fixtures/pool.fixture");
const { toWei, fromWei, zero, zeroAddress, expect, maxUint256: maxPrice, getTransactionTimestamp, verifyRejection, getFakerContract } = require('../utils');
const { BigNumber } = require('ethers');
const { defaultAbiCoder } = require('ethers/lib/utils');

const errorDelta = 10 ** -8;

describe('IndexPool.sol', async () => {
  let poolHelper, indexPool, erc20Factory, nonOwnerFaker;
  let getPoolData, verifyRevert, mintAndApprove, wrappedTokens;
  let tokens, balances, denormalizedWeights, normalizedWeights;
  let newToken;
  let from;
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
        nonOwnerFaker
      } = await deployments.createFixture(poolFixture)());
      await updateData();
    });
  }

  const updateData = async () => {
    ({ tokens, balances, denormalizedWeights, normalizedWeights } = await getPoolData());
  };
  
  const triggerReindex = async (denorm = 1, minimumBalance = 5) => {
    newToken = await erc20Factory.deploy('Test Token', 'TT');
    wrappedTokens.push({
      name: 'Test Token',
      symbol: 'TT',
      token: newToken,
      address: newToken.address,
    });
    const tx = await indexPool.reindexTokens(
      [...tokens, newToken.address],
      [...denormalizedWeights, toWei(denorm)],
      [...balances, toWei(minimumBalance)]
    );
    lastDenormUpdate = await getTransactionTimestamp(tx);
    poolHelper.tokens.push(newToken.address);
    poolHelper.records[newToken.address] = {
      minimumBalance: 5,
      balance: 0,
      desiredDenorm: 1,
      ready: false,
      totalSupply: 5
    };
  }

  describe('Constructor & Settings', async () => {
    setupTests();

    it('isPublicSwap()', async () => {
      const isPublicSwap = await indexPool.isPublicSwap();
      expect(isPublicSwap).to.be.true;
    });

    it('getSwapFee()', async () => {
      const swapFee = await indexPool.getSwapFee();
      expect(swapFee.eq(toWei('0.025'))).to.be.true;
    });

    it('getController()', async () => {
      const controllerAddress = await indexPool.getController();
      expect(controllerAddress).to.eq(from)
    });

    it('getMaxPoolTokens()', async () => {
      const maxPoolTokens = await indexPool.getMaxPoolTokens();
      expect(maxPoolTokens.eq(0)).to.be.true;
    });
  });

  describe('Control & Public', async () => {
    it('Functions with _control_ role are only callable by controller', async () => {
      const controllerOnlyFunctions = [
        'initialize',
        'setMaxPoolTokens',
        'setSwapFee',
        'reweighTokens',
        'reindexTokens',
        'setMinimumBalance',
      ];
      for (let fn of controllerOnlyFunctions) {
        await verifyRejection(nonOwnerFaker, fn, /ERR_NOT_CONTROLLER/g);
      }
    });

    it('Functions with _public_ modifier are only callable after initialization', async () => {
      const IPool = await ethers.getContractFactory('IndexPool');
      indexPool = await IPool.deploy();
      const faker = getFakerContract(indexPool);
      const controllerOnlyFunctions = [
        'joinPool',
        'joinswapExternAmountIn',
        'joinswapPoolAmountOut',
        'swapExactAmountIn',
        'swapExactAmountOut'
      ];
      for (let fn of controllerOnlyFunctions) {
        await verifyRejection(faker, fn, /ERR_NOT_PUBLIC/g);
      }
    });
  });

  describe('configure(): fail', async () => {
    it('Reverts if controller is already set', async () => {
      await verifyRevert('configure', /ERR_CONFIGURED/g, zeroAddress, 'name', 'symbol');
    });

    it('Reverts if provided controller address is zero', async () => {
      const IPool = await ethers.getContractFactory("IndexPool");
      const pool = await IPool.deploy();
      await verifyRejection(pool, 'configure', /ERR_NULL_ADDRESS/g, zeroAddress, 'name', 'symbol');
    });
  });

  describe('initialize(): fail', async () => {
    let pool;

    setupTests();

    it('Reverts if the pool is already initialized', async () => {
      await verifyRevert('initialize', /ERR_INITIALIZED/g, [], [], [], zeroAddress, zeroAddress);
    });
    
    it('Reverts if array lengths do not match', async () => {
      const IPool = await ethers.getContractFactory("IndexPool");
      pool = await IPool.deploy();
      await pool.configure(from, 'pool', 'pl');
      for (let i = 0; i < tokens.length; i++) {
        const token = await ethers.getContractAt('MockERC20', tokens[i]);
        await token.getFreeTokens(from, balances[i]);
        await token.approve(pool.address, balances[i]);
      }
      await verifyRejection(pool, 'initialize', /ERR_ARR_LEN/g, tokens, [zero, zero], denormalizedWeights, zeroAddress, zeroAddress);
      await verifyRejection(pool, 'initialize', /ERR_ARR_LEN/g, tokens, balances, [zero, zero], zeroAddress, zeroAddress);
      await verifyRejection(pool, 'initialize', /ERR_ARR_LEN/g, [zeroAddress, zeroAddress], balances, denormalizedWeights, zeroAddress, zeroAddress);
    });

    it('Reverts if less than 2 tokens are provided', async () => {
      await verifyRejection(
        pool,
        'initialize',
        /ERR_MIN_TOKENS/g,
        [zeroAddress],
        [zero],
        [zero],
        zeroAddress,
        zeroAddress
      );
    });

    it('Reverts if more than 10 tokens are provided', async () => {
      await verifyRejection(
        pool,
        'initialize',
        /ERR_MAX_TOKENS/g,
        new Array(11).fill(zeroAddress),
        new Array(11).fill(zero),
        new Array(11).fill(zero),
        zeroAddress,
        zeroAddress
      );
    });
    
    it('Reverts if any denorm < MIN_WEIGHT', async () => {
      const _denorms = [toWei(12), toWei(12), zero];
      await verifyRejection(pool, 'initialize', /ERR_MIN_WEIGHT/g, tokens, balances, _denorms, from, zeroAddress);
    });
    
    it('Reverts if any denorm > MAX_WEIGHT', async () => {
      const _denorms = [toWei(12), toWei(12), toWei(100)];
      await verifyRejection(pool, 'initialize', /ERR_MAX_WEIGHT/g, tokens, balances, _denorms, from, zeroAddress);
    });
    
    it('Reverts if any balance < MIN_BALANCE', async () => {
      await verifyRejection(pool, 'initialize', /ERR_MIN_BALANCE/g, tokens, [zero, zero, zero], denormalizedWeights, from, zeroAddress);
    });

    it('Reverts if total weight > maximum', async () => {
      const _denorms = [toWei(12), toWei(12), toWei(12)];
      await verifyRejection(pool, 'initialize', /ERR_MAX_TOTAL_WEIGHT/g, tokens, balances, _denorms, from, zeroAddress);
    });
  });

  describe('gulp()', async () => {
    let from, pool, handler;
    let tokenA, tokenB, tokenC;
  
    before(async () => {
      ({ deployer: from } = await getNamedAccounts());
      const erc20Factory = await ethers.getContractFactory('MockERC20');
      tokenA = await erc20Factory.deploy('TokenA', 'A');
      tokenB = await erc20Factory.deploy('TokenB', 'B');
      tokenC = await erc20Factory.deploy('TokenC', 'C');
      await tokenA.getFreeTokens(from, toWei(100));
      await tokenB.getFreeTokens(from, toWei(100));
      const IPool = await ethers.getContractFactory('IndexPool');
      pool = await IPool.deploy();
      await tokenA.approve(pool.address, toWei(100));
      await tokenB.approve(pool.address, toWei(100));
      await pool.configure(from, "Gulper Pool", "GLPL");
      const MockUnbindTokenHandler = await ethers.getContractFactory('MockUnbindTokenHandler');
      handler = await MockUnbindTokenHandler.deploy();
      await pool.initialize(
        [tokenA.address, tokenB.address],
        [toWei(100), toWei(100)],
        [toWei(12.5), toWei(12.5)],
        from,
        handler.address
      );
    });
  
    it('Sends unbound tokens to handler', async () => {
      // const randToken = await erc20Factory.deploy('GulpToken', 'GLP');
      await tokenC.getFreeTokens(pool.address, toWei(100));
      await pool.gulp(tokenC.address);
      const unbindPoolBal = await handler.getReceivedTokens(tokenC.address);
      expect(unbindPoolBal.eq(toWei(100))).to.be.true;
    });
  
    it('Updates balance for bound tokens', async () => {
      await tokenA.getFreeTokens(pool.address, toWei(1));
      const balPre = await pool.getBalance(tokenA.address);
      await pool.gulp(tokenA.address);
      const balPost = await pool.getBalance(tokenA.address);
      expect(balPost.gt(balPre)).to.be.true;
      const diff = balPost.sub(balPre);
      expect(diff.eq(toWei(1))).to.be.true;
    });
  
    it('Updates balance for uninitialized tokens', async () => {
      await pool.reindexTokens(
        [tokenA.address, tokenC.address],
        [toWei(20), toWei(5)],
        [0, toWei(10)]
      );
      await tokenC.getFreeTokens(pool.address, toWei(1));
      const balPre = await pool.getBalance(tokenC.address);
      await pool.gulp(tokenC.address);
      const balPost = await pool.getBalance(tokenC.address);
      expect(balPost.gt(balPre)).to.be.true;
      const diff = balPost.sub(balPre);
      expect(diff.eq(toWei(1))).to.be.true;
  
    });
  
    it('Initializes token if minimumm balance is hit', async () => {
      const denormPre = await pool.getDenormalizedWeight(tokenC.address);
      expect(denormPre.eq(0)).to.be.true;
      await tokenC.getFreeTokens(pool.address, toWei(9));
      await pool.gulp(tokenC.address);
      const balPost = await pool.getBalance(tokenC.address);
      expect(balPost.eq(toWei(10))).to.be.true;
      const denormPost = await pool.getDenormalizedWeight(tokenC.address);
      const minWeight = toWei('0.25');
      expect(denormPost.eq(minWeight)).to.be.true;
    });
  });

  describe('flashBorrow()', async () => {
    let mockBorrower, pool, from;
    let unboundToken, tokenA, tokenB;
  
    const borrowAmount = BigNumber.from(100).mul(BigNumber.from(10).pow(18));
    const denorm = BigNumber.from(8).mul(BigNumber.from(10).pow(18));
  
    before(async () => {
      ({ deployer: from } = await getNamedAccounts());
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      unboundToken = await MockERC20.deploy('Unbound', 'UB');
      tokenA = await MockERC20.deploy('TokenA', 'A');
      tokenB = await MockERC20.deploy('TokenB', 'B');
      const IPool = await ethers.getContractFactory('IndexPool');
      pool = await IPool.deploy();
      await pool.configure(
        from,
        "Test Pool",
        "TPI"
      );
      await tokenA.getFreeTokens(from, borrowAmount);
      await tokenB.getFreeTokens(from, borrowAmount);
  
      await tokenA.approve(pool.address, borrowAmount);
      await tokenB.approve(pool.address, borrowAmount);
  
      await pool.initialize(
        [tokenA.address, tokenB.address],
        [borrowAmount, borrowAmount],
        [denorm, denorm],
        from,
        `0x${'00'.repeat(20)}`
      );
      const MockBorrower = await ethers.getContractFactory('MockBorrower');
      mockBorrower = await MockBorrower.deploy();
    });
  
    it('Reverts when requested token is not bound', async () => {
      await expect(
        pool.flashBorrow(mockBorrower.address, unboundToken.address, borrowAmount, '0x')
      ).to.be.rejectedWith(/ERR_NOT_BOUND/g);
    });
  
    it('Reverts when requested amount exceeds balance', async () => {
      await expect(
        pool.flashBorrow(mockBorrower.address, tokenA.address, borrowAmount.add(1), '0x')
      ).to.be.rejectedWith(/ERR_INSUFFICIENT_BAL/g);
    });
  
    it('Reverts when the fee is not paid', async () => {
      
      const testScenarioBytes = defaultAbiCoder.encode(['uint256'], [1]);
      await expect(
        pool.flashBorrow(mockBorrower.address, tokenA.address, borrowAmount, testScenarioBytes)
      ).to.be.rejectedWith(/ERR_INSUFFICIENT_PAYMENT/g);
    });
  
    it('Reverts if reentry is attempted', async () => {
      const testScenarioBytes = defaultAbiCoder.encode(['uint256'], [2]);
      await expect(
        pool.flashBorrow(mockBorrower.address, tokenA.address, borrowAmount, testScenarioBytes)
      ).to.be.rejectedWith(/ERR_REENTRY/g);
    });
  
    it('Succeeds when the full amount due is paid, and sets the correct balance in the token record', async () => {
      const testScenarioBytes = defaultAbiCoder.encode(['uint256'], [0]);
      const amountDue = borrowAmount.mul(1025).div(1000);
      await pool.flashBorrow(mockBorrower.address, tokenA.address, borrowAmount, testScenarioBytes);
      const newBalance = await pool.getBalance(tokenA.address);
      expect(newBalance.eq(amountDue)).to.be.true;
    });
  
    it('Only increases the balance of an uninitialized token if it is still below the minimum', async () => {
      await pool.reindexTokens(
        [tokenA.address, tokenB.address, unboundToken.address],
        [denorm, denorm, denorm],
        [borrowAmount, borrowAmount, borrowAmount.add(toWei(5))]
      );
      const amountDue = borrowAmount.mul(1025).div(1000);
      await unboundToken.getFreeTokens(pool.address, borrowAmount);
      const testScenarioBytes = defaultAbiCoder.encode(['uint256'], [0]);
      await pool.flashBorrow(mockBorrower.address, unboundToken.address, borrowAmount, testScenarioBytes);
      const newBalance = await pool.getBalance(tokenA.address);
      expect(newBalance.eq(amountDue)).to.be.true;
      const record = await pool.getTokenRecord(unboundToken.address);
      expect(record.ready).to.be.false;
    });
  
    it('Initializes the borrowed token if its balance is brought above the minimum', async () => {
      unboundToken = await erc20Factory.deploy('Unbound2', 'UB2');
      await unboundToken.getFreeTokens(pool.address, borrowAmount);
      await pool.reindexTokens(
        [tokenA.address, tokenB.address, unboundToken.address],
        [denorm, denorm, denorm],
        [borrowAmount, borrowAmount, borrowAmount]
      );
      const testScenarioBytes = defaultAbiCoder.encode(['uint256'], [0]);
      const amountDue = borrowAmount.mul(1025).div(1000);
      await pool.flashBorrow(mockBorrower.address, unboundToken.address, borrowAmount, testScenarioBytes);
      const newBalance = await pool.getBalance(tokenA.address);
      expect(newBalance.eq(amountDue)).to.be.true;
      const record = await pool.getTokenRecord(unboundToken.address);
      expect(record.ready).to.be.true;
      const excessBalance = amountDue.sub(borrowAmount);
      const minimumWeight = toWei('0.25');
      const weightAdded = minimumWeight.mul(excessBalance).div(borrowAmount);
      expect(record.denorm.eq(minimumWeight.add(weightAdded))).to.be.true;
    });
  });

  describe('setSwapFee()', async () => {
    setupTests();

    it('Reverts if caller is not controller', async () => {
      const [, signer2] = await ethers.getSigners();
      await expect(indexPool.connect(signer2).setSwapFee(0)).to.be.rejectedWith(/ERR_NOT_CONTROLLER/g);
    });

    it('Reverts if swapFee < 0.0001%', async () => {
      await verifyRevert('setSwapFee', /ERR_INVALID_FEE/g, toWei('0.00000099'));
    });

    it('Reverts if swapFee > 10%', async () => {
      await verifyRevert('setSwapFee', /ERR_INVALID_FEE/g, toWei(0.11));
    });

    it('Sets swap fee between min and max', async () => {
      const fee = toWei(0.05);
      await indexPool.setSwapFee(fee);
      const retFee = await indexPool.getSwapFee();
      expect(retFee.eq(fee)).to.be.true;
    });
  });

  describe('setMinimumBalance()', async () => {
    setupTests();

    it('Reverts if caller is not controller', async () => {
      const [, signer2] = await ethers.getSigners();
      await expect(indexPool.connect(signer2).setMinimumBalance(zeroAddress, zero)).to.be.rejectedWith(/ERR_NOT_CONTROLLER/g);
    });

    it('Reverts if token is not bound', async () => {
      await verifyRevert('setMinimumBalance', /ERR_NOT_BOUND/g, zeroAddress, zero);
    });

    it('Reverts if token is initialized', async () => {
      await verifyRevert('setMinimumBalance', /ERR_READY/g, tokens[0], zero);
    });

    it('Sets minimum balance of uninitialized token', async () => {
      await triggerReindex();
      await indexPool.setMinimumBalance(newToken.address, toWei(10));
      const minimumBalance = await indexPool.getMinimumBalance(newToken.address);
      expect(minimumBalance.eq(toWei(10))).to.be.true;
    });
  });

  describe('Token Queries', async () => {
    setupTests();

    it('isBound()', async () => {
      for (let token of tokens) {
        expect(await indexPool.isBound(token)).to.be.true;
      }
    });

    it('getNumTokens()', async () => {
      const num = await indexPool.getNumTokens();
      expect(num.eq(tokens.length)).to.be.true;
    });

    it('getCurrentTokens()', async () => {
      const _tokens = await indexPool.getCurrentTokens();
      expect(_tokens).to.deep.eq(tokens);
    });

    it('getCurrentDesiredTokens()', async () => {
      newToken = await erc20Factory.deploy('Test Token', 'TT');
      await indexPool.reindexTokens(
        [tokens[1], tokens[2], newToken.address],
        denormalizedWeights,
        balances
      );
      const desiredTokens = await indexPool.getCurrentDesiredTokens();
      expect(desiredTokens).to.deep.eq([tokens[1], tokens[2], newToken.address]);
    });

    it('getDenormalizedWeight(): success', async () => {
      const weight = await indexPool.getDenormalizedWeight(tokens[1]);
      expect(weight.eq(denormalizedWeights[1])).to.be.true;
    });

    it('getDenormalizedWeight(): fail', async () => {
      await verifyRevert('getDenormalizedWeight', /ERR_NOT_BOUND/g, zeroAddress);
    });

    it('getTotalDenormalizedWeight()', async () => {
      const expected = denormalizedWeights.reduce((total, v) => total.add(v), BigNumber.from(0));
      const total = await indexPool.getTotalDenormalizedWeight();
      expect(total.eq(expected)).to.be.true;
    });

    it('getBalance(): success', async () => {
      const balance = await indexPool.getBalance(tokens[0]);
      expect(balance.eq(balances[0])).to.be.true;
    });

    it('getBalance(): reverts if token is not bound', async () => {
      await verifyRevert('getBalance', /ERR_NOT_BOUND/g, zeroAddress);
    });

    it('getMinimumBalance(): reverts if token is not bound', async () => {
      await verifyRevert('getMinimumBalance', /ERR_NOT_BOUND/g, zeroAddress);
    });

    it('getMinimumBalance(): reverts if token is ready', async () => {
      await verifyRevert('getMinimumBalance', /ERR_READY/g, tokens[0]);
    });

    it('getUsedBalance(): returns actual balance for initialized token', async () => {
      const balance = await indexPool.getUsedBalance(tokens[0]);
      expect(balance.eq(balances[0])).to.be.true;
    });

    it('getUsedBalance(): returns minimum balance for uninitialized token', async () => {
      await triggerReindex();
      const balance = await indexPool.getUsedBalance(newToken.address);
      expect(balance.eq(toWei(5))).to.be.true;
    });

    it('getUsedBalance(): reverts if token is not bound', async () => {
      await verifyRevert('getUsedBalance', /ERR_NOT_BOUND/g, zeroAddress);
    });
  });

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

  describe('extrapolatePoolValueFromToken()', async () => {
    setupTests();

    it('Succeeds if any token is ready and desired', async () => {
      const [token, extrapolatedValue] = await indexPool.extrapolatePoolValueFromToken();
      expect(token).to.eq(tokens[0]);
      const total = await indexPool.getTotalDenormalizedWeight();
      const expected = total.mul(balances[0]).div(denormalizedWeights[0]);
      expect(+calcRelativeDiff(fromWei(expected), fromWei(extrapolatedValue))).to.be.lte(errorDelta);
    });

    it('Reverts if no tokens are both ready and desired', async () => {
      await indexPool.reweighTokens(
        tokens,
        [zero, zero, zero]
      );
      await verifyRevert('extrapolatePoolValueFromToken', /ERR_NONE_READY/g);
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
      const tokenIn = newToken.address;
      for (let o = 0; o < tokens.length; o++) {
        const tokenOut = tokens[o];
        if (tokenIn  == tokenOut) continue;
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
      const tokenIn = newToken.address;
      for (let o = 0; o < tokens.length; o++) {
        const tokenOut = tokens[o];
        if (tokenIn  == tokenOut) continue;
        const tokenAmountOut = balances[o].div(1000);
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

    it('Reverts if totalSupply + pAO > maxPoolTokens', async () => {
      await indexPool.setMaxPoolTokens(await indexPool.totalSupply());
      await verifyRevert('joinswapExternAmountIn', /ERR_MAX_POOL_TOKENS/g, tokens[0], toWei(1), zero);
      await indexPool.setMaxPoolTokens(0);
    });

    it('Allows tokens to be minted up to maxPoolTokens', async () => {
      await indexPool.setMaxPoolTokens((await indexPool.totalSupply()).add(toWei(1)));
      await indexPool.callStatic.joinswapExternAmountIn(tokens[0], toWei(1), zero);
      await indexPool.setMaxPoolTokens(0);
    });

    it('Reverts if poolAmountOut < minPoolAmountOut', async () => {
      const expectedAmountOut = poolHelper.calcPoolOutGivenSingleIn(tokens[0], 1);
      await verifyRevert('joinswapExternAmountIn', /ERR_LIMIT_OUT/g, tokens[0], toWei(1), toWei(expectedAmountOut).mul(2));
    });

    it('Prices initialized tokens normally', async () => {
      const expectedAmountOut = poolHelper.calcPoolOutGivenSingleIn(tokens[0], 1);
      const actualAmountOut = await indexPool.callStatic.joinswapExternAmountIn(tokens[0], toWei(1), toWei(expectedAmountOut));
      expect(+calcRelativeDiff(expectedAmountOut, fromWei(actualAmountOut))).to.be.lte(errorDelta);
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

    it('Reverts if totalSupply + pAO > maxPoolTokens', async () => {
      await indexPool.setMaxPoolTokens(await indexPool.totalSupply());
      await verifyRevert('joinswapPoolAmountOut', /ERR_MAX_POOL_TOKENS/g, tokens[0], toWei(1), zero);
      await indexPool.setMaxPoolTokens(0);
    });

    it('Allows tokens to be minted up to maxPoolTokens', async () => {
      await indexPool.setMaxPoolTokens((await indexPool.totalSupply()).add(toWei(1)));
      await indexPool.callStatic.joinswapPoolAmountOut(tokens[0], toWei(1), maxPrice);
      await indexPool.setMaxPoolTokens(0);
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
      await verifyRevert('joinPool', /ERR_MATH_APPROX/g, zero, [maxPrice, maxPrice, maxPrice]);
    });

    it('Reverts if tokenAmountIn > maxAmountIn', async () => {
      await verifyRevert('joinPool', /ERR_LIMIT_IN/g, toWei(1), [maxPrice, 0, maxPrice]);
    });

    it('Reverts if totalSupply + pAO > maxPoolTokens', async () => {
      await indexPool.setMaxPoolTokens(await indexPool.totalSupply());
      await verifyRevert('joinPool', /ERR_MAX_POOL_TOKENS/g, toWei(1), [maxPrice, maxPrice, maxPrice]);
      await indexPool.setMaxPoolTokens(0);
    });

    it('Allows tokens to be minted up to maxPoolTokens', async () => {
      await indexPool.setMaxPoolTokens((await indexPool.totalSupply()).add(toWei(1)));
      await indexPool.callStatic.joinPool(toWei(1), [maxPrice, maxPrice, maxPrice]);
      await indexPool.setMaxPoolTokens(0);
    });

    it('Prices initialized tokens normally', async () => {
      let previousPoolBalance = 100;
      let poolAmountOut = 1;
      for (let token of wrappedTokens) {
        await token.token.approve(indexPool.address, maxPrice)
      }
      await indexPool.joinPool(toWei(poolAmountOut), [maxPrice, maxPrice, maxPrice]);
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
      for (let i = 0; i < poolHelper.tokens.length; i++) {
        await mintAndApprove(poolHelper.tokens[i], toWei(amountsIn[i]).mul(2));
      }
      await indexPool.joinPool(toWei(poolAmountOut), [maxPrice, maxPrice, maxPrice, maxPrice]);
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
        await verifyRevert('exitswapPoolAmountIn', /ERR_LIMIT_OUT/g, token, poolAmountIn, toWei(expectedAmountOut).sub(1e5));
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

    it('Reverts if poolAmountIn > maxPoolAmountIn', async () => {
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const tokenAmountOut = balances[i].div(10);
        const expectedAmountOut = poolHelper.calcPoolInGivenSingleOut(token, fromWei(tokenAmountOut), false);
        await verifyRevert('exitswapExternAmountOut', /ERR_LIMIT_IN/g, token, tokenAmountOut, toWei(expectedAmountOut).div(2));
      }
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
      const previousPoolBalance = await indexPool.totalSupply();
      await indexPool.exitPool(toWei(poolAmountIn), [0, 0, 0]);
      const currentPoolBalance = await indexPool.totalSupply();
      const poolSupplyDiff = previousPoolBalance.sub(currentPoolBalance);
      expect(+calcRelativeDiff(1, fromWei(poolSupplyDiff))).to.be.lte(errorDelta);
      for (let i = 0; i < tokens.length; i++) {
        const previousTokenBalance = balances[i];
        const currentTokenBalance = await indexPool.getBalance(tokens[i]);
        const realDiff = previousTokenBalance.sub(currentTokenBalance);
        const expectedDiff = expectedAmountsOut[i];
        expect(+calcRelativeDiff(expectedDiff, fromWei(realDiff))).to.be.lte(errorDelta);
      }
    });

    it('Reverts if poolRatio = 0', async () => {
      await verifyRevert('exitPool', /ERR_MATH_APPROX/g, 1, [zero, zero, zero]);
    });

    it('Reverts if invalid array length is given', async () => {
      await verifyRevert('exitPool', /ERR_ARR_LEN/g, toWei(1), [zero, zero]);
    });

    it('Reverts if tokenAmountOut < minAmountOut', async () => {
      await verifyRevert('exitPool', /ERR_LIMIT_OUT/g, toWei(1), [maxPrice, maxPrice, maxPrice]);
    });

    it('Reverts if minAmountOut is not zero for uninitialized tokens', async () => {
      await triggerReindex();
      await verifyRevert('exitPool', /ERR_OUT_NOT_READY/g, toWei(1), [0, 0, 0, 1]);
    });

    it('Gives 0 for uninitialized tokens', async () => {
      await indexPool.exitPool(toWei(1), [0, 0, 0, 0]);
      const bal = await indexPool.getBalance(newToken.address);
      expect(bal.eq(0)).to.be.true;
    });
  });
});