const chalk = require('chalk');
const moment = require('moment');
const BN = require('bn.js');
const { soliditySha3 } = require('web3-utils');

const { wrapped_tokens: wrappedTokens } = require('../test/testData/categories.json');

const logger = {
  info(v) {
    console.log(
      chalk.bold.cyan(
        '@indexed-finance/mocks/deploy:' + moment(new Date()).format('HH:mm:ss') + ': '
      ) + v
    );
    return v;
  }
};

const nTokensHex = (amount) => toHex(nTokens(amount));

let uniswapFactory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
let uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

module.exports = async ({
  deployments,
  getNamedAccounts,
  getChainId,
  ethers
}) => {
  const chainID = await getChainId();
  if (chainID != 4) return;
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

  const weth = await deployments.get('weth');
  if (chainID != 4) {
    uniswapFactory = await deployments.get('uniswapFactory');
    uniswapRouter = await deployments.get('uniswapRouter');
  } else {
    uniswapFactory = await ethers.getContractAt('UniswapV2Factory', uniswapFactory, signer);
    uniswapRouter = await ethers.getContractAt('UniswapV2Router', uniswapRouter, signer);
  }

  logger.info('Executing deployment script.');
  
  for (let token of wrappedTokens) {
    const { name, symbol } = token;
    const erc20 = await deploy('MockERC20', symbol.toLowerCase(), {
      from: deployer,
      gas: 4000000,
      args: [name, symbol]
    }, true);
    token.token = erc20;
    token.address = erc20.address;
    const receipt = await this.uniswapFactory.methods.createPair(
      token.address,
      this.weth.options.address
    );
    const { events } = await receipt.wait();
    const { args: { pair } } = events.filter(e => e.event == 'PairCreated')[0];
    token.pair = await ethers.getContractAt('UniswapV2Pair', pair, signer);
    const liquidity = nTokensHex(100);
    const wethAmount = nTokensHex(liquidity * token.initialPrice);
    await erc20.getFreeTokens(deployer, liquidity);
    await weth.getFreeTokens(deployer, wethAmount);
    await erc20.approve(uniswapRouter.address, liquidity);
    await weth.approve(uniswapRouter.address, wethAmount);
    await uniswapRouter.addLiquidity(
      erc20.address,
      weth.address,
      liquidity,
      wethAmount,
      deployer,
      await bre.run('getTimestamp')
    );
  }

  const controller = await deployments.get('controller');
  const metadata = {
    name: 'Wrapped Tokens',
    description: 'Category for wrapped tokens.'
  };
  const metadataHash = keccak256(JSON.stringify(metadata));
  await controller.createCategory(metadataHash);
  await controller.addTokens(1, wrappedTokens.map(w => w.address));
  bre.config.wrappedTokens = wrappedTokens;
};

module.exports.tags = ['Mocks'];
module.exports.dependencies = ['Core'];