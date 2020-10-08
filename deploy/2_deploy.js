const chalk = require('chalk');
const moment = require('moment');

const { wrapped_tokens: wrappedTokens } = require('../test/testData/categories.json');

const Logger = (chainID) => ({
  info: (v) => {
    if (chainID != 1 && chainID != 4) return;
    console.log(
      chalk.bold.cyan(
        '@indexed-finance/core/deploy:' + moment(new Date()).format('HH:mm:ss') + ': '
      ) + v
    );
    return v;
  }
});

let uniswapFactory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
let uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

module.exports = async ({
  config,
  deployments,
  getNamedAccounts,
  getChainId,
  ethers
}) => {
  const chainID = await getChainId();
  const logger = Logger(chainID);
  const { save } = deployments;
  const { deployer } = await getNamedAccounts();
  const [ signer ] = await ethers.getSigners();

  const deploy = async (name, contractName, opts, returnContract = false) => {
    logger.info(`Deploying ${contractName} [${name}]`);
    const deployment = await deployments.deploy(name, {
      ...opts,
      contractName
    });
    if (deployment.newlyDeployed) {
      await save(contractName, deployment);
    }
    if (returnContract) {
      const contract = await ethers.getContractAt(deployment.abi, deployment.address, signer);
      return contract;
    }
    return deployment;
  }

  const weth = await ethers.getContract('weth');
  if (chainID != 4) {
    uniswapFactory = await ethers.getContract('uniswapFactory');
    uniswapRouter = await ethers.getContract('uniswapRouter');
  } else {
    uniswapFactory = await ethers.getContractAt('UniswapV2Factory', uniswapFactory, signer);
    uniswapRouter = await ethers.getContractAt('UniswapV2Router', uniswapRouter, signer);
  }

  logger.info('Executing deployment script.');
  const tokens = [];
  for (let token of wrappedTokens) {
    const { name, symbol } = token;
    const erc20 = await deploy('MockERC20', symbol.toLowerCase(), {
      from: deployer,
      gas: 4000000,
      args: [name, symbol]
    }, true);
    const receipt = await uniswapFactory.createPair(
      erc20.address,
      weth.address
    );
    const { events } = await receipt.wait();
    const { args: { pair } } = events.filter(e => e.event == 'PairCreated')[0];
    tokens.push({
      ...token,
      token: erc20,
      address: erc20.address,
      pair: await ethers.getContractAt('UniswapV2Pair', pair, signer)
    });
  }
  config.wrappedTokens = tokens;
};

module.exports.tags = ['Mocks'];
module.exports.dependencies = ['Core'];