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
  const uniswapFactory = await ethers.getContract('UniswapV2Factory');
  const uniswapRouter = await ethers.getContract('UniswapV2Router02');
  const uniswapOracle = await ethers.getContract('IndexedUniswapV2Oracle');

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
    const erc20 = await deploy('MockERC20', symbol.toLowerCase(), {
      from: deployer,
      gas: 4000000,
      args: [name, symbol]
    });
    tokenAddresses[symbol.toLowerCase()] = erc20.address;
    await uniswapFactory.createPair(erc20.address, weth.address, { gasLimit: 250000 });
    await liquidityAdder.addLiquiditySingle(erc20.address, amountToken, amountWeth, { gasLimit: 250000 });
  }

  for (let category of categories) {
    const { name, symbol, description, tokens } = category;
    logger.info(`Creating category ${name}`);
    const { sha3Hash } = await uploadFile({ name, symbol, description });
    const { events } = await controller.createCategory(sha3Hash, { gasLimit: 250000 }).then(tx => tx.wait());
    const { args: { categoryID } } = events.filter(e => e.event == 'CategoryAdded')[0];
    logger.success(`Created category ${name} with ID ${categoryID}`);
    category.categoryID = categoryID;
    const addresses = tokens.map(symbol => tokenAddresses[symbol.toLowerCase()]);
    await controller.addTokens(categoryID, addresses, { gasLimit: 250000 });
  }

  for (let token of testTokens) {
    const { amountToken, amountWeth } = toLiquidityAmounts(token);
    const { symbol } = token;
    const address = tokenAddresses[symbol.toLowerCase()];
    await liquidityAdder.addLiquiditySingle(address, amountToken, amountWeth, { gasLimit: 250000 });
  }
};

module.exports.tags = ['Rinkeby'];
module.exports.dependencies = ['Core'];