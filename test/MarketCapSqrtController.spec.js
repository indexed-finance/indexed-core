const { BigNumber } = require('ethers');
const { controllerFixture } = require('./fixtures/controller.fixture');
const { verifyRejection, expect, fastForward, fromWei, toWei, zero, zeroAddress, oneE18, sqrt, sha3, WEEK, toFP, fromFP } = require('./utils');

const { calcRelativeDiff } = require('./lib/calc_comparisons');
const errorDelta = 10 ** -8;

const WEIGHT_MULTIPLIER = toWei(25);

describe('MarketCapSqrtController.sol', async () => {
  let controller, notOwner, from, verifyRevert;
  let nonOwnerFaker, ownerFaker;
  let updatePrices, addLiquidityAll, liquidityManager;
  let sortedWrappedTokens;
  let wrappedTokens, tokens, initializerImplementation;
  let pool, initializer, tokenSeller;
  let poolSize;

  const setupTests = ({ init, pool, category, size, ethValue, setRecipient } = {}) => {
    before(async () => {
      if (setRecipient === undefined) {
        setRecipient = true;
      }
      ({
        poolFactory,
        proxyManager,
        wrappedTokens,
        controller,
        from,
        verifyRevert,
        nonOwnerFaker,
        updatePrices,
        addLiquidityAll,
        addLiquidity,
        ownerFaker,
        initializerImplementation,
        liquidityManager,
        notOwner
      } = await deployments.createFixture(controllerFixture)());
      tokens = wrappedTokens.map(t => t.address);
      sortedWrappedTokens = [...wrappedTokens].sort((a, b) => {
        if (a.marketcap < b.marketcap) return 1;
        if (a.marketcap > b.marketcap) return -1;
        return 0;
      });
      if (setRecipient) await controller.setDefaultExitFeeRecipient(from);
      if (category) await setupCategory();
      if (pool) await setupPool(size, ethValue);
      if (init) await finishInitializer();
    });
  }

  async function getTotalValue() {
    let totalValue = BigNumber.from(0);
    const _tokens = await pool.getCurrentTokens()
    for (const token of _tokens) {
      const balance = await pool.getBalance(token);
      const value = liquidityManager.getTokenValue(token.toLowerCase(), balance);
      totalValue = totalValue.add(value);
    }
    return totalValue;
  }

  const sortTokens = async () => {
    await updatePrices(wrappedTokens);
    const wrapped2 = [];
    for (let i = 0; i < wrappedTokens.length; i++) {
      const supply = await wrappedTokens[i].token.totalSupply();
      const marketcap = liquidityManager.getTokenValue(wrappedTokens[i].address, supply);
      wrapped2.push({
        ...wrappedTokens[i],
        marketcap: +fromWei(marketcap),
        price: +fromWei(marketcap) / +fromWei(supply)
      });
    }
    sortedWrappedTokens = wrapped2.sort((a, b) => {
      if (a.marketcap < b.marketcap) return 1;
      if (a.marketcap > b.marketcap) return -1;
      return 0;
    });
    await controller.orderCategoryTokensByMarketCap(1);
  }

  const getMarketCapSqrts = async (_tokens) => {
    const actualMarketCaps = await Promise.all(
      _tokens.map(async ({ token }) => liquidityManager.getTokenValue(token, await token.totalSupply()))
    );
    const capSqrts = actualMarketCaps.map(sqrt);
    const sqrtSum = capSqrts.reduce((total, capSqrt) => total.add(capSqrt), BigNumber.from(0));
    return [capSqrts, sqrtSum];
  }

  const getExpectedTokensAndBalances = async (numTokens, ethValue) => {
    await updatePrices(wrappedTokens);
    await fastForward(7200);
    await addLiquidityAll();
    const expectedTokens = sortedWrappedTokens.slice(0, numTokens);
    const [capSqrts, sqrtSum] = await getMarketCapSqrts(expectedTokens);
    const weightedEthValues = capSqrts.map((rt) => rt.mul(ethValue).div(sqrtSum));
    const expectedBalances = weightedEthValues.map((val, i) => {
      const _price = toWei(expectedTokens[i].price);
      return val.mul(oneE18).div(_price);
    });
    return [expectedTokens.map(t => t.address), expectedBalances];
  };

  const setupCategory = async () => {
    await controller.createCategory(`0x${'ff'.repeat(32)}`);
    const id = await controller.categoryIndex();
    await controller.addTokens(id, tokens);
    await fastForward(3600 * 48);
    await addLiquidityAll();
    await controller.orderCategoryTokensByMarketCap(id);
  };

  const getExpectedDenorms = async (numTokens) => {
    const expectedTokens = sortedWrappedTokens.slice(0, numTokens);
    const [capSqrts, sqrtSum] = await getMarketCapSqrts(expectedTokens);
    return capSqrts.map((rt) => fromFP(toFP(rt).div(sqrtSum).mul(WEIGHT_MULTIPLIER)));
  }

  const changePrices = async () => {
    const valuesBefore = [];
    const shouldMoves = [];
    for (let i = 0; i < sortedWrappedTokens.length; i++) {
      const {address} = sortedWrappedTokens[i];
      const movePriceUp = i >= poolSize;//Math.random() > 0.5;
      shouldMoves.push(movePriceUp);
      const valueBefore = liquidityManager.getTokenValue(address, toWei(1));
      valuesBefore.push(valueBefore);
      await liquidityManager[movePriceUp ? 'swapIncreasePrice' : 'swapDecreasePrice'](address);
    }
    await updatePrices(tokens);
    /* for (let i = 0; i < tokens.length; i++) {
      const valueAfter = liquidityManager.getTokenValue(tokens[i], toWei(1));
      const didMoveInRightDirection = shouldMoves[i] ? valueAfter.gt(valuesBefore[i]) : valuesBefore[i].gt(valueAfter);
      const diff = shouldMoves[i] ? valueAfter.sub(valuesBefore[i]) : valuesBefore[i].sub(valueAfter);
      const pctDiff = +fromWei(diff) / +fromWei(valuesBefore[i])
      console.log(`% mvmt ? ${pctDiff * 100}`);
    } */
  };

  const prepareReweigh = async (_changePrices = false) => {
    await updatePrices(tokens);
    await fastForward(WEEK * 2);
    if (_changePrices) {
      await changePrices();
    } else {
      await addLiquidityAll();
      await updatePrices(tokens)
    }
    await fastForward(3600 * 48);
    await addLiquidityAll();
  }

  const finishInitializer = async () => {
    await updatePrices(wrappedTokens);
    await fastForward(7200);
    await addLiquidityAll();
    const desiredTokens = await initializer.getDesiredTokens();
    const desiredAmounts = await initializer.getDesiredAmounts(desiredTokens);
    for (let i = 0; i < desiredTokens.length; i++) {
      const token = await ethers.getContractAt('MockERC20', desiredTokens[i]);
      await token.getFreeTokens(from, desiredAmounts[i]);
      await token.approve(initializer.address, desiredAmounts[i]);
    }
    await initializer['contributeTokens(address[],uint256[],uint256)'](desiredTokens, desiredAmounts, 0);
    const tx = await initializer.finish();
    await initializer['claimTokens()']();
    const myBal = await pool.balanceOf(from);
    expect(myBal.eq(toWei(100))).to.be.true;
    expect(await pool.isPublicSwap()).to.be.true;
    const defaultPremium = await controller.defaultSellerPremium();
    const sellerAddress = await controller.computeSellerAddress(pool.address);
    tokenSeller = await ethers.getContractAt('UnboundTokenSeller', sellerAddress);
    expect(await tokenSeller.getPremiumPercent()).to.eq(defaultPremium);
    return tx;
  }

  const setupPool = async (size = 5, ethValue = 1, id = 1) => {
    poolSize = size;
    if ((await controller.categoryIndex()).eq(0)) await setupCategory();
    const { events } = await controller.prepareIndexPool(id, size, toWei(ethValue), 'Test Index Pool', 'TIP').then(tx => tx.wait());
    const { args: { pool: poolAddress, initializer: initializerAddress } } = events.filter(e => e.event == 'NewPoolInitializer')[0];
    pool = await ethers.getContractAt('IndexPool', poolAddress);
    initializer = await ethers.getContractAt('PoolInitializer', initializerAddress);
    return { poolAddress, initializerAddress };
  }

  describe('Initializer & Settings', async () => {
    setupTests();

    it('defaultSellerPremium(): set to 2', async () => {
      const premium = await controller.defaultSellerPremium();
      expect(premium).to.eq(2);
    });

    it('owner()', async () => {
      expect(await controller.owner()).to.eq(from);
    });
  });

  describe('onlyOwner', async () => {
    setupTests();

    it('All functions with onlyOwner modifier revert if caller is not owner', async () => {
      const onlyOwnerFns = [
        'prepareIndexPool', 'setDefaultSellerPremium', 'updateSellerPremium',
        'delegateCompLikeTokenFromPool', 'setDefaultExitFeeRecipient',
      ];
      for (let fn of onlyOwnerFns) {
        await verifyRejection(nonOwnerFaker, fn, /Ownable: caller is not the owner/g);
      }
    });
  });

  describe('_havePool', async () => {
    setupTests();

    it('All functions with _havePool modifier revert if pool address not recognized', async () => {
      // reweighPool & reindexPool included even though there is no modifier because it uses the same validation
      const onlyOwnerFns = [
        'updateMinimumBalance', 'reweighPool', 'reindexPool', 'getPoolMeta'
      ];
      for (let fn of onlyOwnerFns) {
        await verifyRejection(ownerFaker, fn, /ERR_POOL_NOT_FOUND/g);
      }
    });
  });

  describe('getPoolMeta', async () => {
    setupTests({ category: true, pool: true, init: false, setRecipient: true, ethValue: 1, size: 5 });

    it('Returns expected struct before init', async () => {
      const {
        initialized,
        categoryID,
        indexSize,
        reweighIndex,
        lastReweigh
      } = await controller.getPoolMeta(pool.address);
      expect([
        initialized,
        categoryID,
        indexSize,
        reweighIndex,
        lastReweigh.toNumber()
      ]).to.deep.eq([
        false, // initialized
        1, // categoryID
        5, // indexSize
        0, // reweighIndex
        0 // lastReweigh
      ]);
    });

    it('Returns expected struct after init', async () => {
      const tx = await finishInitializer();
      const receipt = await tx.wait();
      const { timestamp } = await ethers.provider.getBlock(receipt.blockNumber);
      const {
        initialized,
        categoryID,
        indexSize,
        reweighIndex,
        lastReweigh
      } = await controller.getPoolMeta(pool.address);
      expect([
        initialized,
        categoryID,
        indexSize,
        reweighIndex,
        lastReweigh.toNumber()
      ]).to.deep.eq([
        true, // initialized
        1, // categoryID
        5, // indexSize
        0, // reweighIndex
        timestamp // lastReweigh
      ]);
    });
  });

  describe('setDefaultSellerPremium()', async () => {
    setupTests();

    it('Reverts if premium == 0', async () => {
      await verifyRevert('setDefaultSellerPremium', /ERR_PREMIUM/g, 0);
    });

    it('Reverts if premium >= 20', async () => {
      await verifyRevert('setDefaultSellerPremium', /ERR_PREMIUM/g, 20);
    });

    it('Sets allowed premium', async () => {
      await controller.setDefaultSellerPremium(1);
      const premium = await controller.defaultSellerPremium();
      expect(premium).to.eq(1);
    });
  });

  describe('setDefaultExitFeeRecipient()', () => {
    setupTests({ setRecipient: false });

    it('Reverts if address is null', async () => {
      await verifyRevert('setDefaultExitFeeRecipient', /ERR_NULL_ADDRESS/g, zeroAddress)
    })

    it('Sets default exit fee recipient', async () => {
      await controller.setDefaultExitFeeRecipient(from)
      expect(await controller.defaultExitFeeRecipient()).to.eq(from)
    })
  })

  describe('setExitFeeRecipient(address,address)', () => {
    setupTests({ category: true, pool: true, init: true });

    it('Reverts if not owner', async () => {
      await verifyRejection(
        controller.connect(notOwner),
        'setExitFeeRecipient(address,address)',
        /Ownable: caller is not the owner/g,
        pool.address, zeroAddress
      );
    })

    it('Reverts if pool does not exist', async () => {
      await verifyRejection(
        controller,
        'setExitFeeRecipient(address,address)',
        /ERR_POOL_NOT_FOUND/g,
        zeroAddress, zeroAddress
      );
    })

    it('Sets exit fee recipient on pool', async () => {
      const recipient = `0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF`;
      await controller['setExitFeeRecipient(address,address)'](pool.address, recipient);
      expect(await pool.getExitFeeRecipient()).to.eq(recipient);
    })
  })

  describe('setExitFeeRecipient(address[],address)', () => {
    setupTests({ category: true, pool: true, init: true });

    it('Reverts if not owner', async () => {
      await verifyRejection(
        await controller.connect(notOwner),
        'setExitFeeRecipient(address[],address)',
        /Ownable: caller is not the owner/g,
        [pool.address], zeroAddress
      )
    })

    it('Reverts if any of the pools do not exist', async () => {
      await verifyRejection(
        controller,
        'setExitFeeRecipient(address[],address)',
        /ERR_POOL_NOT_FOUND/g,
        [zeroAddress], `0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF`
      );
    })

    it('Sets exit fee recipient on pools', async () => {
      const recipient = `0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF`;
      const pool1 = pool.address;
      await setupCategory()
      const { poolAddress: pool2 } = await setupPool(5, 1, 2);
      await finishInitializer()
      await controller['setExitFeeRecipient(address[],address)']([pool1, pool2], recipient);
      expect(await (await ethers.getContractAt('IndexPool', pool1)).getExitFeeRecipient()).to.eq(recipient);
      expect(await (await ethers.getContractAt('IndexPool', pool2)).getExitFeeRecipient()).to.eq(recipient);
    })
  })

  describe('setSwapFee(address,uint256)', async () => {
    setupTests({ pool: true, init: true, size: 2, ethValue: 1 });

    it('Reverts if not owner', async () => {
      await verifyRejection(
        await controller.connect(notOwner),
        'setSwapFee(address,uint256)',
        /Ownable: caller is not the owner/g,
        pool.address, 0
      )
    })

    it('Reverts if any of the pools do not exist', async () => {
      await verifyRejection(
        controller,
        'setSwapFee(address,uint256)',
        /ERR_POOL_NOT_FOUND/g,
        zeroAddress, 0
      );
    })

    it('Sets swap fee on the pool', async () => {
      const fee = toWei('0.01');
      await controller['setSwapFee(address,uint256)'](pool.address, fee);
      const newFee = await pool.getSwapFee();
      expect(newFee.eq(fee)).to.be.true;
    });
  });

  describe('setSwapFee(address[],uint256)', async () => {
    setupTests({ pool: true, init: true, size: 2, ethValue: 1 });

    it('Reverts if not owner', async () => {
      await verifyRejection(
        await controller.connect(notOwner),
        'setSwapFee(address[],uint256)',
        /Ownable: caller is not the owner/g,
        [pool.address], 0
      )
    })

    it('Reverts if any of the pools do not exist', async () => {
      await verifyRejection(
        controller,
        'setSwapFee(address[],uint256)',
        /ERR_POOL_NOT_FOUND/g,
        [zeroAddress], 0
      );
    })

    it('Sets swap fee on the pool', async () => {
      const pool1 = pool.address;
      await setupCategory()
      const { poolAddress: pool2 } = await setupPool(5, 1, 2);
      await finishInitializer()
      const fee = toWei('0.01');
      await controller['setSwapFee(address[],uint256)']([pool1, pool2], fee);
      expect((await (await ethers.getContractAt('IndexPool', pool1)).getSwapFee()).eq(fee)).to.be.true;
      expect((await (await ethers.getContractAt('IndexPool', pool2)).getSwapFee()).eq(fee)).to.be.true;
    });
  });

  describe('getInitialTokensAndBalances()', async () => {
    setupTests();

    it('Returns the top n category tokens and target balances weighted by mcap sqrt', async () => {
      await setupCategory();
      const ethValue = toWei(1);
      const [expectedTokens, expectedBalances] = await getExpectedTokensAndBalances(2, ethValue);
      const [_tokens, balances] = await controller.getInitialTokensAndBalances(1, 2, ethValue);
      expect(_tokens).to.deep.eq(expectedTokens);
      expect(balances[0].eq(expectedBalances[0])).to.be.true;
      expect(balances[1].eq(expectedBalances[1])).to.be.true;
    });

    it('Reverts if any token has a target balance below the minimum', async () => {
      const ethValue = toWei(1).div(1e12);
      await verifyRevert('getInitialTokensAndBalances', /ERR_MIN_BALANCE/g, 1, 2, ethValue);
    });
  });

  describe('prepareIndexPool()', async () => {
    setupTests();

    it('Reverts if size > 10', async () => {
      await setupCategory();
      await verifyRevert('prepareIndexPool', /ERR_MAX_INDEX_SIZE/g, 1, 11, zero, 'a', 'b');
    });

    it('Reverts if size < 2', async () => {
      await verifyRevert('prepareIndexPool', /ERR_MIN_INDEX_SIZE/g, 1, 1, zero, 'a', 'b');
    });

    it('Reverts if initialWethValue >= 2^144', async () => {
      const ethValue = BigNumber.from(2).pow(144);
      await verifyRevert('prepareIndexPool', /ERR_MAX_UINT144/g, 1, 4, ethValue, 'a', 'b');
    });

    it('Succeeds with valid inputs', async () => {
      poolSize = 4;
      const { events } = await controller.prepareIndexPool(1, 4, toWei(10), 'Test Index Pool', 'TIP').then(tx => tx.wait());
      const { args: { pool: poolAddress, initializer: initializerAddress, categoryID, indexSize } } = events.filter(e => e.event == 'NewPoolInitializer')[0];
      pool = await ethers.getContractAt('IndexPool', poolAddress);
      initializer = await ethers.getContractAt('PoolInitializer', initializerAddress);
      expect(categoryID.eq(1)).to.be.true;
      expect(indexSize.eq(4)).to.be.true;
    });

    it('Deploys the pool and initializer to the correct addresses', async () => {
      expect(pool.address).to.eq(await controller.computePoolAddress(1, 4));
      expect(initializer.address).to.eq(await controller.computeInitializerAddress(pool.address));
    });

    it('Reverts if the pool params are duplicates', async () => {
      await verifyRevert(
        'prepareIndexPool',
        /Create2: Failed on deploy/g,
        1, 4, toWei(10), 'Test Index Pool', 'TIP'
      );
    });

    it('Sets expected desired tokens and balances on pool initializer', async () => {
      const ethValue = toWei(10);
      const [expectedTokens, expectedBalances] = await getExpectedTokensAndBalances(4, ethValue);
      const desiredTokens = await initializer.getDesiredTokens();
      const desiredBalances = await initializer.getDesiredAmounts(desiredTokens);
      expect(desiredTokens).to.deep.eq(expectedTokens);
      for (let i = 0; i < desiredTokens.length; i++) {
        expect(+calcRelativeDiff(fromWei(expectedBalances[i]), fromWei(desiredBalances[i]))).to.be.lte(errorDelta);
      }
      await finishInitializer();
    });
  });

  describe('finishPreparedIndexPool()', async () => {
    setupTests();

    it('Reverts if caller is not initializer', async () => {
      await verifyRejection(ownerFaker, 'finishPreparedIndexPool', /ERR_NOT_PRE_DEPLOY_POOL/g);
    });

    it('Reverts if array lengths do not match', async () => {
      await setupCategory();
      const InitializerErrorTrigger = await ethers.getContractFactory('InitializerErrorTrigger');
      const initializerErrorTrigger = await InitializerErrorTrigger.deploy();
      await proxyManager.setImplementationAddressManyToOne(sha3('PoolInitializer.sol'), initializerErrorTrigger.address);
      const { poolAddress, initializerAddress } = await setupPool(2, 1);
      initializer = await ethers.getContractAt('InitializerErrorTrigger', initializerAddress);
      await verifyRejection(initializer, 'triggerArrLenError', /ERR_ARR_LEN/g);
    });

    it('Reverts if pool is already initialized', async () => {
      await updatePrices(wrappedTokens);
      await fastForward(7200);
      await addLiquidityAll();
      await verifyRejection(initializer, 'triggerDuplicateInit', /ERR_INITIALIZED/g);
      await proxyManager.setImplementationAddressManyToOne(sha3('PoolInitializer.sol'), initializerImplementation);
    });
  });

  describe('updateSellerPremium()', async () => {
    setupTests({ pool: true, init: true, size: 2, ethValue: 1 });

    it('Reverts if premium == 0', async () => {
      await verifyRevert('updateSellerPremium', /ERR_PREMIUM/g, tokenSeller.address, 0);
    });

    it('Reverts if premium >= 20', async () => {
      await verifyRevert('updateSellerPremium', /ERR_PREMIUM/g, tokenSeller.address, 20);
    });

    it('Sets premium within allowed range', async () => {
      await controller.updateSellerPremium(tokenSeller.address, 3);
      const premium = await tokenSeller.getPremiumPercent();
      expect(premium).to.eq(3);
    });
  });

  describe('reweighPool()', async () => {
    setupTests({ pool: true, init: true, size: 5, ethValue: 1});

    it('Reverts if < 2 weeks have passed', async () => {
      await verifyRevert('reweighPool', /ERR_POOL_REWEIGH_DELAY/g, pool.address);
    });

    it('Reweighs the pool and sets desired weights proportional to mcap sqrts', async () => {
      await prepareReweigh(true);
      const expectedWeights = await getExpectedDenorms(5);
      await controller.reweighPool(pool.address);
      for (let i = 0; i < 5; i++) {
        const desiredDenorm = (await pool.getTokenRecord(sortedWrappedTokens[i].address)).desiredDenorm;
        expect(desiredDenorm.eq(expectedWeights[i])).to.be.true;
      }
    });

    it('Reverts if reweighIndex % 4 == 0', async () => {
      await prepareReweigh();
      await controller.reweighPool(pool.address);
      await prepareReweigh();
      await controller.reweighPool(pool.address);
      await prepareReweigh();
      await verifyRevert('reweighPool', /ERR_REWEIGH_INDEX/g, pool.address);
    });
  });

  describe('reindexPool()', async () => {
    setupTests({ pool: true, init: true, size: 5, ethValue: 10 });

    it('Reverts if < 2 weeks have passed', async () => {
      await verifyRevert('reindexPool', /ERR_POOL_REWEIGH_DELAY/g, pool.address);
    });

    it('Reverts if reweighIndex % 4 != 0', async () => {
      await prepareReweigh();
      await verifyRevert('reindexPool', /ERR_REWEIGH_INDEX/g, pool.address);
    });

    it('Reverts if category has not been sorted recently', async () => {
      await prepareReweigh();
      await controller.reweighPool(pool.address);
      await prepareReweigh();
      await controller.reweighPool(pool.address);
      await prepareReweigh();
      await controller.reweighPool(pool.address);
      await prepareReweigh(true);
      await verifyRevert('reindexPool', /ERR_CATEGORY_NOT_READY/g, pool.address);
    });

    it('Reindexes the pool with correct minimum balances and desired weights', async () => {
      const willBeIncluded = sortedWrappedTokens[5].address;
      await sortTokens();
      let totalValue = await getTotalValue();
      const expectedMinimumBalance = liquidityManager.getEthValue(willBeIncluded, totalValue).div(100);
      await controller.reindexPool(pool.address);
      const actualMinimumBalance = await pool.getMinimumBalance(willBeIncluded);
      expect(actualMinimumBalance.eq(expectedMinimumBalance)).to.be.true;
    });
  });

  describe('updateMinimumBalance()', async () => {
    setupTests({ pool: true, init: true, size: 4, ethValue: 10 });

    it('Reverts if token is initialized', async () => {
      await verifyRevert('updateMinimumBalance', /ERR_TOKEN_READY/g, pool.address, sortedWrappedTokens[0].address);
    });

    it('Updates minimum balance based on calculated pool value', async () => {
      for (let i = 0; i < 3; i++) {
        await prepareReweigh();
        await controller.reweighPool(pool.address);
      }
      await prepareReweigh();
      const willBeIncluded = sortedWrappedTokens[4].address;
      await sortedWrappedTokens[4].token.getFreeTokens(from, liquidityManager.getEthValue(willBeIncluded, toWei(1e7)));
      await sortTokens();
      await controller.reindexPool(pool.address);
      let totalValue = await getTotalValue()
      
      let previousMinimum = liquidityManager.getEthValue(willBeIncluded, totalValue).div(100);
      const token0 = sortedWrappedTokens[0].token;
      const addAmount = (await token0.balanceOf(pool.address)).div(10);
      await token0.getFreeTokens(pool.address, addAmount)
      const addValue = liquidityManager.getTokenValue(token0.address.toLowerCase(), addAmount);
      await fastForward(3600 * 7)
      await controller.updateMinimumBalance(pool.address, willBeIncluded);
      let expectedMinimumBalance = liquidityManager.getEthValue(willBeIncluded, totalValue.add(addValue)).div(100);
      let actualMinimumBalance = await pool.getMinimumBalance(willBeIncluded);
      expect(actualMinimumBalance.gt(previousMinimum)).to.be.true;
      expect(+calcRelativeDiff(fromWei(expectedMinimumBalance), fromWei(actualMinimumBalance))).to.be.lte(errorDelta);
    });
  });

  describe('delegateCompLikeTokenFromPool()', async () => {
    setupTests({ pool: true, init: true, size: 4, ethValue: 10 });

    it('Delegates a comp-like token in an index pool', async () => {
      const {token} = sortedWrappedTokens[0];
      const delegatee = sortedWrappedTokens[1].address;
      await controller.delegateCompLikeTokenFromPool(pool.address, token.address, delegatee);
      expect(await token.delegateeByAddress(pool.address)).to.eq(delegatee);
    });
  });
});