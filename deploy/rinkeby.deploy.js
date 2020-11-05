const Logger = require('../lib/logger');
const Deployer = require('../lib/deployer');
const uploadFile = require('../lib/upload');

const categories = require('../test/testData/rinkeby-categories.json');
const testTokens = require('../test/testData/test-tokens.json');
const { toWei, oneE18 } = require('../test/utils');

const toLiquidityAmounts = ({ price, marketcap }) => {
  let amountWeth = toWei(marketcap);
  let amountToken = amountWeth.mul(oneE18).div(toWei(price));
  return { amountToken, amountWeth };
};

module.exports = async (bre) => {
  const { ethers, getNamedAccounts, getChainId } = bre;
  const chainID = await getChainId();
  const { deployer } = await getNamedAccounts();
  const [ signer ] = await ethers.getSigners();

  const logger = Logger(chainID, 'rinkeby:category-setup');
  const deploy = await Deployer(bre, logger);

  if (+chainID != 4) {
    logger.error(`Tried running rinkeby deployment on network other than Rinkeby.`);
    return;
  }

  const controller = await ethers.getContract('controller', signer);

  const weth = await ethers.getContractAt('MockERC20', '0x72710B0b93c8F86aEf4ec8bd832868A15df50375');
  const uniswapFactory = await ethers.getContract('uniswapFactory');
  const uniswapRouter = await ethers.getContract('uniswapRouter');

  const liquidityAdder = await deploy('LiquidityAdder', 'liquidityAdder', {
    from: deployer,
    gas: 4000000,
    args: [weth.address, uniswapFactory.address, uniswapRouter.address]
  }, true);

  const categoryIndex = await controller.categoryIndex();
  if (!categoryIndex.eq(0)) {
    logger.success(`Category index not zero, skipping category setup.`);
    return;
  }
  const tokenAddresses = {};

  for (let token of testTokens) {
    const { amountToken, amountWeth } = toLiquidityAmounts(token);
    const { name, symbol } = token;
    const deployment = await deployments.getOrNull(symbol.toLowerCase());
    let erc20;
    if (deployment) {
      erc20 = await ethers.getContractAt('MockERC20', deployment.address);
    } else {
      erc20 = await deploy('MockERC20', symbol.toLowerCase(), {
        from: deployer,
        gas: 4000000,
        args: [name, symbol]
      }, true);
      await uniswapFactory.createPair(weth.address, erc20.address, { gasLimit: 5500000 }).then(tx => tx.wait());
    }
    tokenAddresses[symbol.toLowerCase()] = erc20.address;
    logger.info(`Adding liquidity to Uniswap market between WETH and ${symbol}`);
    await liquidityAdder.addLiquiditySingle(erc20.address, amountToken, amountWeth, { gasLimit: 2500000 }).then(tx => tx.wait());
    logger.success(`Added liquidity to Uniswap market between WETH and ${symbol}`);
  }

  for (let category of categories) {
    const { name, symbol, description, tokens } = category;
    logger.info(`Creating category ${name}`);
    const { sha3Hash } = await uploadFile({ name, symbol, description });
    const { events } = await controller.createCategory(sha3Hash, { gasLimit: 250000 }).then(tx => tx.wait());
    const { args: { categoryID } } = events.filter(e => e.event == 'CategoryAdded')[0];
    logger.success(`Created category ${name} with ID ${categoryID}`);
    const addresses = tokens.map(symbol => tokenAddresses[symbol.toLowerCase()]);
    await controller.addTokens(categoryID, addresses, { gasLimit: 1500000 }).then(tx => tx.wait());
    logger.success(`Added ${addresses.length} tokens to category ${name}`);
  }

  for (let token of testTokens) {
    const { amountToken, amountWeth } = toLiquidityAmounts(token);
    const { symbol } = token;
    const address = tokenAddresses[symbol.toLowerCase()];
    await liquidityAdder.addLiquiditySingle(address, amountToken, amountWeth, { gasLimit: 1250000 }).then(tx => tx.wait());;
  }

  const initialWethValue = toWei(5);

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    const categoryID = i + 1;
    logger.info(`Sorting category ${categoryID}...`);
    await controller.orderCategoryTokensByMarketCap(categoryID, { gasLimit: 1000000 }).then(tx => tx.wait());
    logger.success(`Sorted category ${categoryID}!`);
    const name = `${category.name} Top 5 Index`;
    const symbol = `${category.symbol}5r`;
    logger.info(`Creating index pool for category ${categoryID}...`);
    const { events } = await controller.prepareIndexPool(categoryID, 5, initialWethValue, name, symbol, { gasLimit: 2250000 }).then(tx => tx.wait());
    const event = events.filter(e => e.event == 'NewPoolInitializer')[0];
    const { pool, initializer } = event.args;
    logger.success(`Deployed index pool and initializer: Pool ${pool} | Initializer ${initializer}`);
    if (i == 0) {
      const poolInitializer = await ethers.getContractAt('PoolInitializer', initializer);
      const iTokens = await poolInitializer.getDesiredTokens();
      const amounts = await poolInitializer.getDesiredAmounts(iTokens);
      for (let t = 0; t < 5; t++) {
        const tokenAddress = iTokens[t];
        const amountIn = amounts[t];
        const iToken = await ethers.getContractAt('MockERC20', tokenAddress);
        await iToken.getFreeTokens(deployer, amountIn, { gasLimit: 60000 }).then(tx => tx.wait());
        await iToken.approve(initializer, amountIn, { gasLimit: 60000 }).then(tx => tx.wait());
      }
      await poolInitializer['contributeTokens(address[],uint256[],uint256)'](iTokens, amounts, 0, { gasLimit: 1500000 }).then(tx => tx.wait());
      await poolInitializer.finish({ gasLimit: 1500000 });
      await poolInitializer['claimTokens()']({ gasLimit: 150000 });
    }
  }
};

module.exports.tags = ['Rinkeby'];
module.exports.dependencies = ['Core'];