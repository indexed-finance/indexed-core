const Logger = require('../lib/util/logger');
const Deployer = require('../lib/util/deployer');

const testTokens = require('../test/testData/test-tokens.json');
const { oneToken, toBN, toHex } = require('../lib/util/bn');


module.exports = async ({
  getChainId,
  run
}) => {
  const chainID = await getChainId();
  const logger = Logger(chainID, 'deploy-mocks');
  
  const addresses = [];
  for (let token of testTokens) {
    const { marketcap, name, symbol, price } = token;
    if (!marketcap || !name || !symbol || !price) {
      throw new Error(`Token JSON must include: marketcap, name, symbol, price`);
    }
    const erc20 = await run('deploy-test-token-and-market', { logger, name, symbol });
    addresses.push(erc20.address);
    const totalSupply = await erc20.totalSupply();
    let amountWeth = toBN(marketcap);
    // let liquidity = marketcap / price;
    if (totalSupply.eq(0)) {
      amountWeth = amountWeth.divn(10);
    }
    let amountToken = amountWeth.divn(price);
    await run('add-liquidity', {
      logger,
      symbol,
      amountToken: toHex(amountToken.mul(oneToken)),
      amountWeth: toHex(amountWeth.mul(oneToken))
    });
  }
  await run('update-prices', { logger, tokens: addresses });
  logger.info('Executing deployment script.');
};

module.exports.tags = ['Mocks'];
module.exports.dependencies = ['Core'];