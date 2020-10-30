const [...testTokens] = require('../testData/test-tokens.json');
const { toWei, oneE18 } = require('../utils');

const { uniswapFixture } = require('./uniswap.fixture');

const toLiquidityAmounts = ({ price, marketcap }, init = false) => {
  let amountWeth = toWei(marketcap);
  let amountToken = amountWeth.mul(oneE18).div(toWei(price));
  if (!init) {
    amountWeth = amountWeth.div(10);
    amountToken = amountToken.div(10);
  }
  return { amountToken, amountWeth };
}

const categoriesFixture = async () => {
  const uniswapResult = await deployments.createFixture(uniswapFixture)();
  const { deployTokenAndMarket, addLiquidity, updatePrices } = uniswapResult;

  const tokens = [];

  for (let tokenInfo of testTokens) {
    const { marketcap, name, symbol, price } = tokenInfo;
    if (!marketcap || !name || !symbol || !price) {
      throw new Error(`Token JSON must include: marketcap, name, symbol, price`);
    }
    const tokenAndPairData = await deployTokenAndMarket(name, symbol);
    const { amountToken, amountWeth } = toLiquidityAmounts(tokenInfo, true);
    await addLiquidity(tokenAndPairData.token, amountToken, amountWeth);
    tokens.push({
      ...tokenAndPairData,
      ...tokenInfo
    });
  }
  await updatePrices(tokens);
  const addLiquidityAll = async () => {
    for (let token of tokens) {
      const { amountToken, amountWeth } = toLiquidityAmounts(token, false);
      await addLiquidity(token, amountToken, amountWeth)
    }
  }
  return {
    ...uniswapResult,
    tokens,
    addLiquidityAll
  };
}

module.exports = { categoriesFixture };