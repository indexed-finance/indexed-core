const { expect } = require("chai");
const { categoriesFixture } = require("./fixtures/categories.fixture");
const { verifyRejection, zero, toWei, sha3, zeroAddress, fastForward, fromWei, oneE18, getTransactionTimestamp, DAY, HOUR } = require("./utils");
const { calcRelativeDiff } = require('./lib/calc_comparisons');
const { BigNumber } = require("ethers");

const errorDelta = 10 ** -8;

describe('MarketCapSortedTokenCategories.sol', () => {
  let tokens, wrappedTokens, oracle;
  let updatePrices, addLiquidityAll, addLiquidity, deployTokenAndMarket;
  let categories;
  let owner, notOwner;
  let verifyRevert;
  let tokenIndex = 0;

  before(async () => {
    [owner, notOwner] = await ethers.getSigners();
  });

  const setupTests = () => {
    before(async () => {
      ({
        tokens: wrappedTokens,
        updatePrices,
        uniswapOracle: oracle,
        deployTokenAndMarket,
        addLiquidityAll,
        addLiquidity
      } = await deployments.createFixture(categoriesFixture)());
      tokens = wrappedTokens.map(t => t.address);
      
      const deploy = async (name, ...args) => (await ethers.getContractFactory(name)).deploy(...args);
      const proxyManager = await deploy('DelegateCallProxyManager');
      const proxyAddress = await proxyManager.computeProxyAddressOneToOne(await owner.getAddress(), sha3('MarketCapSortedTokenCategories.sol'));
      const categoriesImplementation = await deploy('MarketCapSortedTokenCategories', oracle.address);
      await proxyManager.deployProxyOneToOne(sha3('MarketCapSortedTokenCategories.sol'), categoriesImplementation.address);
      categories = await ethers.getContractAt('MarketCapSortedTokenCategories', proxyAddress);
      await categories.initialize();
      verifyRevert = (...args) => verifyRejection(categories, ...args);
    });
  }

  const makeCategory = () => categories.createCategory(`0x${'ff'.repeat(32)}`);

  const deployTestToken = async (liqA = 1, liqB = 1) => {
    const name = `Token${tokenIndex++}`;
    const symbol = `TK${tokenIndex++}`;
    const erc20 = await deployTokenAndMarket(name, symbol);
    await addLiquidity(erc20, toWei(liqA), toWei(liqB));
    return erc20;
  }

  describe('categoryIndex()', async () => {
    setupTests();

    it('Sets first category ID to 1', async () => {
      let index = await categories.categoryIndex();
      expect(index.eq(0)).to.be.true;
      await makeCategory();
      index = await categories.categoryIndex();
      expect(index.eq(1)).to.be.true;
      expect(await categories.hasCategory(1)).to.be.true;
    });
  });

  describe('updateCategoryPrices()', async () => {
    setupTests();

    it('Reverts if category does not exist', async () => {
      await verifyRevert('updateCategoryPrices', /ERR_CATEGORY_ID/g, 1);
    });

    it('Updates prices of tokens in category', async () => {
      await makeCategory();
      await categories.addTokens(1, tokens);
      await fastForward(3600);
      const {timestamp} = await ethers.provider.getBlock('latest');
      const priceKey = Math.floor(+timestamp / 3600);
      for (let token of tokens) {
        const hasPrice = await oracle.hasPriceObservationInWindow(token, priceKey);
        expect(hasPrice).to.be.false;
      }
      await addLiquidityAll();
      await categories.updateCategoryPrices(1);
      for (let token of tokens) {
        const hasPrice = await oracle.hasPriceObservationInWindow(token, priceKey);
        expect(hasPrice).to.be.true;
      }
    });
  })

  describe('hasCategory()', async () => {
    setupTests();

    it('Returns false if category does not exist', async () => {
      expect(await categories.hasCategory(0)).to.be.false;
      expect(await categories.hasCategory(1)).to.be.false;
    });

    it('Returns true if category exists', async () => {
      await makeCategory();
      expect(await categories.hasCategory(1)).to.be.true;
    });
  });

  describe('isTokenInCategory()', async () => {
    setupTests();

    it('Reverts if invalid category ID is given', async () => {
      await verifyRevert('isTokenInCategory', /ERR_CATEGORY_ID/g, 1, zeroAddress);
    });

    it('Returns false if token is not bound', async () => {
      await makeCategory();
      await categories.addTokens(1, tokens);
      expect(await categories.isTokenInCategory(1, zeroAddress)).to.be.false;
    });

    it('Returns true if token is bound', async () => {
      for (let token of tokens) {
        expect(await categories.isTokenInCategory(1, token)).to.be.true;
      }
    });

    it('Returns false if token is removed', async () => {
      for (let token of tokens) {
        await categories.removeToken(1, token);
        expect(await categories.isTokenInCategory(1, token)).to.be.false;
      }
    });
  });

  describe('createCategory()', async () => {
    setupTests();

    it('Reverts if caller is not owner', async () => {
      await verifyRejection(
        categories.connect(notOwner),
        'createCategory',
        /Ownable: caller is not the owner/g,
        `0x${'00'.repeat(32)}`
      );
    });

    it('Allows owner to create a category', async () => {
      const indexBefore = await categories.categoryIndex();
      await categories.createCategory(`0x${'ff'.repeat(32)}`);
      const indexAfter = await categories.categoryIndex();
      expect(indexAfter.eq(indexBefore.add(1))).to.be.true;
    });
  });

  describe('addToken()', async () => {
    setupTests();
    let newTokens = [];

    it('Reverts if caller is not owner', async () => {
      await verifyRejection(
        categories.connect(notOwner),
        'addToken',
        /Ownable: caller is not the owner/g,
        0,
        zeroAddress
      );
    });

    it('Reverts if categoryIndex is 0', async () => {
      await verifyRevert('addToken', /ERR_CATEGORY_ID/g, zero, zeroAddress);
    });

    it('Reverts if categoryID > categoryIndex', async () => {
      await makeCategory();
      await verifyRevert('addToken', /ERR_CATEGORY_ID/g, 2, zeroAddress);
    });

    it('Reverts if category is already at the maximum', async () => {
      for (let i = 0; i < 25; i++) {
        const token = await deployTestToken(1, 1);
        await categories.addToken(1, token.address);
      }
      await verifyRevert('addToken', /ERR_MAX_CATEGORY_TOKENS/g, 1, tokens[0]);
    });

    it('Reverts if token is already bound to same category', async () => {
      await makeCategory();
      const token = await deployTestToken();
      newTokens.push(token.address);
      await categories.addToken(2, token.address);
      await verifyRevert('addToken', /ERR_TOKEN_BOUND/g, 2, token.address);
    });

    it('Resets the lastCategoryUpdate time', async () => {
      const token = await deployTestToken();
      expect((await categories.getCategoryTokens(2)).length).to.eq(1);
      await categories.addToken(2, token.address);
      expect((await categories.getCategoryTokens(2)).length).to.eq(2);
      await categories.updateCategoryPrices(2)
      await fastForward(DAY * 2)
      await categories.orderCategoryTokensByMarketCap(2);
      const lastUpdate1 = await categories.getLastCategoryUpdate(2);
      expect(lastUpdate1.gt(0)).to.be.true;
      const token1 = await deployTestToken();
      await categories.addToken(2, token1.address);
      expect((await categories.getCategoryTokens(2)).length).to.eq(3);
      const lastUpdate2 = await categories.getLastCategoryUpdate(2);
      expect(lastUpdate2.eq(lastUpdate1.sub(DAY))).to.be.true;
      newTokens.push(token.address);
      newTokens.push(token1.address);
    });

    it('Returns tokens', async () => {
      const tokens = await categories.getCategoryTokens(2);
      expect(tokens).to.deep.eq(newTokens);
    });
  });

  describe('removeToken()', async () => {
    setupTests();

    it('Reverts if caller is not owner', async () => {
      await verifyRejection(
        categories.connect(notOwner),
        'removeToken',
        /Ownable: caller is not the owner/g,
        0,
        zeroAddress
      );
    });

    it('Reverts if categoryIndex is 0', async () => {
      await verifyRevert('removeToken', /ERR_CATEGORY_ID/g, zero, zeroAddress);
    });

    it('Reverts if categoryID > categoryIndex', async () => {
      await makeCategory();
      await verifyRevert('removeToken', /ERR_CATEGORY_ID/g, 2, zeroAddress);
    });

    it('Reverts if category is empty', async () => {
      await categories.createCategory(`0x${'00'.repeat(32)}`);
      await verifyRevert('removeToken', /ERR_EMPTY_CATEGORY/g, 2, zeroAddress);
    });

    it('Reverts if token not found', async () => {
      const token = await deployTestToken();
      await categories.addToken(2, token.address);
      await verifyRevert('removeToken', /ERR_TOKEN_NOT_BOUND/g, 2, zeroAddress);
    });

    it('Resets the lastCategoryUpdate time', async () => {
      const token = await deployTestToken();
      expect((await categories.getCategoryTokens(2)).length).to.eq(1);
      await categories.addToken(2, token.address);
      expect((await categories.getCategoryTokens(2)).length).to.eq(2);
      await categories.updateCategoryPrices(2)
      await fastForward(DAY * 2)
      await categories.orderCategoryTokensByMarketCap(2);
      const lastUpdate1 = await categories.getLastCategoryUpdate(2);
      expect(lastUpdate1.gt(0)).to.be.true;
      await categories.removeToken(2, token.address)
      expect((await categories.getCategoryTokens(2)).length).to.eq(1);
      const lastUpdate2 = await categories.getLastCategoryUpdate(2);
      expect(lastUpdate2.eq(lastUpdate1.sub(DAY))).to.be.true;
      const [last] = await categories.getCategoryTokens(2);
      await categories.removeToken(2, last);
      expect((await categories.getCategoryTokens(2)).length).to.eq(0);
    });

    it('Swaps with last token in list', async () => {
      const tokenList = [];
      for (let i = 0; i < 25; i++) {
        const token = await deployTestToken();
        tokenList.push(token.address);
      }
      await categories.addTokens(2, tokenList);
      await categories.removeToken(2, tokenList[5]);
      tokenList[5] = tokenList.pop();
      const catTokens = await categories.getCategoryTokens(2);
      expect(catTokens).to.deep.eq(tokenList);
    });
  })

  describe('addTokens()', async () => {
    setupTests();

    it('Reverts if caller is not owner', async () => {
      await verifyRejection(
        categories.connect(notOwner),
        'addTokens',
        /Ownable: caller is not the owner/g,
        0,
        [zeroAddress, zeroAddress],
      );
    });

    it('Reverts if categoryIndex is 0', async () => {
      await verifyRevert('addTokens', /ERR_CATEGORY_ID/g, zero, [zeroAddress, zeroAddress]);
    });

    it('Reverts if categoryID > categoryIndex', async () => {
      await makeCategory();
      await verifyRevert('addTokens', /ERR_CATEGORY_ID/g, 2, [zeroAddress, zeroAddress]);
    });

    it('Reverts if category would exceed maximum after adding the tokens', async () => {
      for (let i = 0; i < 24; i++) {
        const token = await deployTestToken();
        await categories.addToken(1, token.address);
      }
      await verifyRevert('addTokens', /ERR_MAX_CATEGORY_TOKENS/g, 1, [zeroAddress, zeroAddress]);
    });

    it('Reverts if any of the tokens are already bound', async () => {
      await makeCategory();
      const token = await deployTestToken();
      await categories.addToken(2, token.address);
      await verifyRevert('addTokens', /ERR_TOKEN_BOUND/g, 2, [token.address]);
    });
  });

  describe('getCategoryTokens()', async () => {
    setupTests();

    it('Reverts if categoryIndex is 0', async () => {
      await verifyRevert('getCategoryTokens', /ERR_CATEGORY_ID/g, zero);
    });

    it('Reverts if categoryID > categoryIndex', async () => {
      await makeCategory();
      await verifyRevert('getCategoryTokens', /ERR_CATEGORY_ID/g, 2);
    });

    it('Returns the category tokens', async () => {
      await categories.addTokens(1, tokens);
      expect(await categories.getCategoryTokens(1)).to.deep.eq(tokens);
    });
  });

  describe('computeAverageMarketCap()', async () => {
    setupTests();

    it('Reverts if the oracle does not have a price observation in the TWAP range', async () => {
      await verifyRevert('computeAverageMarketCap', /IndexedUniswapV2Oracle::_getTokenPrice: No price found in provided range\./g, tokens[0]);
    });

    it('Returns correct token market caps', async () => {
      await fastForward(3600 * 48);
      await addLiquidityAll();
      await makeCategory();
      await categories.addTokens(1, tokens);

      for (let i = 0; i < tokens.length; i++) {
        const { price, token: erc20 } = wrappedTokens[i];
        const _price = toWei(price);
        const expected = (await erc20.totalSupply()).mul(_price).div(oneE18);
        const actual = await categories.computeAverageMarketCap(tokens[i]);
        expect(+calcRelativeDiff(fromWei(expected), fromWei(actual))).to.be.lte(errorDelta);
      }
    });
  });

  describe('computeAverageMarketCaps()', async () => {
    setupTests();

    it('Reverts if the oracle does not have price observations in the TWAP range', async () => {
      await verifyRevert('computeAverageMarketCaps', /IndexedUniswapV2Oracle::_getTokenPrice: No price found in provided range\./g, tokens);
    });

    it('Returns correct token market caps', async () => {
      await fastForward(3600 * 48);
      await addLiquidityAll();
      await makeCategory();
      await categories.addTokens(1, tokens);
      const actual = await categories.computeAverageMarketCaps(tokens);
      const expected = await Promise.all(wrappedTokens.map(async ({ token, price }) => {
        const _price = toWei(price);
        return (await token.totalSupply()).mul(_price).div(oneE18);
      }));
      for (let i = 0; i < tokens.length; i++) {
        expect(+calcRelativeDiff(fromWei(expected[i]), fromWei(actual[i]))).to.be.lte(errorDelta);
      }
    });
  });

  describe('getCategoryMarketCaps()', async () => {
    setupTests();

    it('Reverts if the category does not exist', async () => {
      await verifyRevert('getCategoryMarketCaps', /ERR_CATEGORY_ID/g, 1);
    });

    it('Reverts if the oracle does not have price observations in the TWAP range', async () => {
      await makeCategory();
      await categories.addTokens(1, tokens);
      await verifyRevert('getCategoryMarketCaps', /IndexedUniswapV2Oracle::_getTokenPrice: No price found in provided range\./g, 1);
    });

    it('Returns expected market caps', async () => {
      await fastForward(3600 * 48);
      await addLiquidityAll();
      const actual = await categories.getCategoryMarketCaps(1);
      const expected = await Promise.all(wrappedTokens.map(async ({ token, price }) => {
        const _price = toWei(price);
        return (await token.totalSupply()).mul(_price).div(oneE18);
      }));
      for (let i = 0; i < tokens.length; i++) {
        expect(+calcRelativeDiff(fromWei(expected[i]), fromWei(actual[i]))).to.be.lte(errorDelta);
      }
    });
  });

  describe('getTopCategoryTokens()', async () => {
    setupTests();

    it('Reverts if the category does not exist', async () => {
      await verifyRevert('getTopCategoryTokens', /ERR_CATEGORY_ID/g, 1, 1);
    });

    it('Reverts if size > number of category tokens', async () => {
      await makeCategory();
      await categories.addTokens(1, tokens);
      await verifyRevert('getTopCategoryTokens', /ERR_CATEGORY_SIZE/g, 1, 12);
    });

    it('Reverts if category has not been sorted recently', async () => {
      await verifyRevert('getTopCategoryTokens', /ERR_CATEGORY_NOT_READY/g, 1, 2);
    });

    it('Returns top n tokens in descending order of market cap', async () => {
      await fastForward(3600 * 48);
      await addLiquidityAll();
      const orderedTokens = [...wrappedTokens].sort((a, b) => {
        if (a.marketcap < b.marketcap) return 1;
        if (a.marketcap > b.marketcap) return -1;
        return 0;
      }).map(t => t.address);
      await getTransactionTimestamp(categories.orderCategoryTokensByMarketCap(1));
      const topTokens = await categories.getTopCategoryTokens(1, 2);
      expect(topTokens).to.deep.eq(orderedTokens.slice(0, 2));
    });
  });

  describe('orderCategoryTokensByMarketCap()', async () => {
    setupTests();
    let updateTime;

    it('Reverts if the category does not exist', async () => {
      await verifyRevert('orderCategoryTokensByMarketCap', /ERR_CATEGORY_ID/g, 1);
    });

    it('Reverts if the oracle does not have price observations in the TWAP range', async () => {
      await makeCategory();
      await categories.addTokens(1, tokens);
      await verifyRevert('orderCategoryTokensByMarketCap', /IndexedUniswapV2Oracle::_getTokenPrice: No price found in provided range\./g, 1);
    });

    it('Sorts the category using insertion sort', async () => {
      await fastForward(3600 * 48);
      await addLiquidityAll();
      const orderedTokens = [...wrappedTokens].sort((a, b) => {
        if (a.marketcap < b.marketcap) return 1;
        if (a.marketcap > b.marketcap) return -1;
        return 0;
      }).map(t => t.address);
      updateTime = await getTransactionTimestamp(categories.orderCategoryTokensByMarketCap(1));
      expect(await categories.getCategoryTokens(1)).to.deep.eq(orderedTokens);
    });

    it('Sets the last category update timestamp', async () => {
      const last = await categories.getLastCategoryUpdate(1);
      expect(last.eq(updateTime)).to.be.true;
    });
  });
});