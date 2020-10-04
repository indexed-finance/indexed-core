const chalk = require('chalk');
const moment = require('moment');
const { soliditySha3 } = require('web3-utils');

let uniswapFactory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
let uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
let weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

const poolInitializerID = soliditySha3('PoolInitializer.sol')
const poolImplementationID = soliditySha3('IPool.sol');
const sellerImplementationID = soliditySha3('UnboundTokenSeller.sol');

const logger = {
  info(v) {
    console.log(
      chalk.bold.cyan(
        '@indexed-finance/core/deploy:' + moment(new Date()).format('HH:mm:ss') + ': '
      ) + v
    );
    return v;
  }
};

module.exports = async ({
  deployments,
  getChainId,
  getNamedAccounts,
  ethers
}) => {
  const { save } = deployments;
  const { deployer } = await getNamedAccounts();
  const [ signer ] = await ethers.getSigners();
  // For some reason the contractName field wasn't properly being saved
  // to deployments.
  const deploy = async (name, contractName, opts) => {
    logger.info(`Deploying ${contractName} [${name}]`);
    const deployment = await deployments.deploy(name, {
      ...opts,
      contractName
    });
    if (deployment.newlyDeployed) {
      await save(contractName, deployment);
    }
    return deployment;
  }

  logger.info('Executing deployment script.');


  const WETH = await deploy('MockERC20', 'weth', {
    from: deployer,
    gas: 4000000,
    args: ["Wrapped Ether V9", "WETH9"]
  });
  weth = WETH.address;

  const chainID = await getChainId();
  if (chainID != 1 && chainID != 4) {
    logger.info('Deploying UniSwap mocks');

    const factory = await deploy("UniswapV2Factory", 'uniswapFactory', {
      from: deployer,
      gas: 4000000,
      args: [deployer]
    });
    uniswapFactory = factory.address;

    const router = await deploy('UniswapV2Router02', 'uniswapRouter', {
      from: deployer,
      gas: 4000000,
      args: [uniswapFactory, weth]
    });
    uniswapRouter = router.address;
  }

  // Deploy UniSwap oracles
  const longTermUniSwapOracle = await deploy("UniSwapV2PriceOracle", 'WeeklyTWAPUniSwapV2Oracle', {
    from: deployer,
    gas: 4000000,
    args: [uniswapFactory, weth, 3.5*24*60*60]
  });

  const shortTermUniswapOracle = await deploy("UniSwapV2PriceOracle", 'HourlyTWAPUniswapV2Oracle', {
    from: deployer,
    gas: 4000000,
    args: [uniswapFactory, weth, 60*60]
  });

  // Deploy proxy manager
  const proxyManagerDeployment = await deploy('DelegateCallProxyManager', 'proxyManager', {
    from: deployer,
    gas: 4000000,
    args: []
  });
  const proxyManager = await ethers.getContractAt(
    proxyManagerDeployment.abi, proxyManagerDeployment.address, signer
  );

  // Deploy pool factory
  const poolFactoryDeployment = await deploy('PoolFactory', 'poolFactory', {
    contractName: 'poolFactory',
    from: deployer,
    gas: 4000000,
    args: [deployer, proxyManager.address]
  });
  const poolFactory = await ethers.getContractAt(
    poolFactoryDeployment.abi, poolFactoryDeployment.address, signer
  );

  // Deploy pool controller
  const controllerDeployment = await deploy('MarketCapSqrtController', 'controller', {
    from: deployer,
    gas: 4000000,
    args: [
      longTermUniSwapOracle.address,
      deployer,
      poolFactory.address,
      proxyManager.address
    ]
  });
  const controller = await ethers.getContractAt(
    controllerDeployment.abi, controllerDeployment.address, signer
  );

  // Add UnboundTokenSeller implementation
  const tokenSellerImplementation = await deploy('UnboundTokenSeller', 'tokenSellerImplementation', {
    from: deployer,
    gas: 4000000,
    args: [uniswapRouter, shortTermUniswapOracle.address, controller.address]
  });

  if (tokenSellerImplementation.newlyDeployed) {
    await proxyManager.createManyToOneProxyRelationship(
      sellerImplementationID,
      tokenSellerImplementation.address
    );
  }

  // Add IPool implementation
  const poolImplementation = await deploy('IPool', 'poolImplementation', {
    from: deployer,
    gas: 4000000,
    args: []
  });

  if (poolImplementation.newlyDeployed) {
    await proxyManager.createManyToOneProxyRelationship(
      poolImplementationID,
      poolImplementation.address
    );
  }

  // Add PoolInitializer implementation
  const poolInitializerImplementation = await deploy('PoolInitializer', 'poolInitializerImplementation', {
    from: deployer,
    gas: 4000000,
    args: [shortTermUniswapOracle.address, controller.address]
  });
  
  if (poolInitializerImplementation.newlyDeployed) {
    await proxyManager.createManyToOneProxyRelationship(
      poolInitializerID,
      poolInitializerImplementation.address
    );
  }
  if (proxyManagerDeployment.newlyDeployed) {
    await proxyManager.approveDeployer(poolFactory.address);
    await proxyManager.approveDeployer(controller.address);
  }
  if (poolFactoryDeployment.newlyDeployed) {
    await poolFactory.approvePoolController(controller.address);
  }
};

module.exports.tags = ['Core'];