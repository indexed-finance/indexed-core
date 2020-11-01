const wrappedTokens = [
  {
    "name": "Wrapped Bitcoin",
    "symbol": "WBTC",
    "initialPrice": 10
  },
  {
    "name": "Wrapped Litecoin",
    "symbol": "WLTC",
    "initialPrice": 1
  },
  {
    "name": "Wrapped Token",
    "symbol": "WTKN",
    "initialPrice": 2
  }
];

const { uniswapFixture } = require('./uniswap.fixture');

const wrappedTokensFixture = async ({deployments}) => {
  const uniswapFixtures = await deployments.createFixture(uniswapFixture)();

  const tokens = [];
  for (let i = 0; i < wrappedTokens.length; i++) {
    const token = wrappedTokens[i];
    const { name, symbol } = token;
    const tokenAndPairData = await uniswapFixtures.deployTokenAndMarket(name, symbol);
    tokens.push({ ...token, ...tokenAndPairData });
  }
  return {
    ...uniswapFixtures,
    tokens
  };
};

module.exports = {wrappedTokensFixture};