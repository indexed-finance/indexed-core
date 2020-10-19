const Logger = require('../lib/util/logger');
const Deployer = require('../lib/util/deployer');
const { soliditySha3 } = require('web3-utils');

let uniswapFactory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
let uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
let weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

const poolInitializerID = soliditySha3('PoolInitializer.sol')
const poolImplementationID = soliditySha3('IPool.sol');
const sellerImplementationID = soliditySha3('UnboundTokenSeller.sol');

/*
Deploys the base contracts for Indexed
=========================================
External Dependencies
- WETH (if not mainnet)
- Uniswap Factory (if not mainnet or rinkeby)
- Uniswap Router (if not mainnet or rinkeby)

Core Contracts
- Pool Factory
- Proxy Manager
- Hourly TWAP Uniswap Oracle
- Weekly TWAP Uniswap Oracle
*/

module.exports = async (bre) => {
  const {
    deployments,
    getChainId,
    getNamedAccounts,
    ethers
  } = bre;
  const chainID = await getChainId();
  const logger = Logger(chainID)
  const { deployer } = await getNamedAccounts();
  const deploy = await Deployer(bre, logger);

  // ------- External Contracts -------
  logger.info('Linking external dependencies.', true);

  if (chainID != 1) {
    const WETH = await deploy('MockERC20', 'weth', {
      from: deployer,
      gas: 4000000,
      args: ["Wrapped Ether V9", "WETH9"]
    });
    weth = WETH.address;

    if (chainID != 4) {
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
  }


  // ------- Uniswap Oracles -------
  let longTermDelay = chainID == 4 ? 60*10 : 3.5*24*60*60;
  let shortTermDelay = chainID == 4 ? 60*10 - 1 : 60*60;

  // Deploy UniSwap oracles
  const longTermUniSwapOracle = await deploy("UniSwapV2PriceOracle", 'WeeklyTWAPUniSwapV2Oracle', {
    from: deployer,
    gas: 4000000,
    args: [uniswapFactory, weth, longTermDelay]
  }, true);

  const shortTermUniswapOracle = await deploy("UniSwapV2PriceOracle", 'HourlyTWAPUniswapV2Oracle', {
    from: deployer,
    gas: 4000000,
    args: [uniswapFactory, weth, shortTermDelay]
  }, true);

  logger.info('Checking time delay for long oracle');
  console.log(await longTermUniSwapOracle.OBSERVATION_PERIOD());

  // ------- Core Contracts -------
  // Deploy proxy manager
  const proxyManager = await deploy('DelegateCallProxyManager', 'proxyManager', {
    from: deployer,
    gas: 4000000,
    args: []
  }, true);

  // Deploy pool factory
  const poolFactory = await deploy('PoolFactory', 'poolFactory', {
    contractName: 'poolFactory',
    from: deployer,
    gas: 4000000,
    args: [deployer, proxyManager.address]
  }, true);

  // Deploy pool controller
  const controller = await deploy('MarketCapSqrtController', 'controller', {
    from: deployer,
    gas: 4000000,
    args: [
      longTermUniSwapOracle.address,
      deployer,
      poolFactory.address,
      proxyManager.address
    ]
  }, true);

  // ------- Proxy Implementations -------
  if (proxyManager.newlyDeployed) {
    const tokenSellerImplementation = await deploy('UnboundTokenSeller', 'tokenSellerImplementation', {
      from: deployer,
      gas: 4000000,
      args: [uniswapRouter, shortTermUniswapOracle.address, controller.address]
    });
    if (tokenSellerImplementation.newlyDeployed) {
      logger.info('Adding token seller to proxy manager...')
      await proxyManager.createManyToOneProxyRelationship(
        sellerImplementationID,
        tokenSellerImplementation.address,
        { gasLimit: 400000 }
      ).then(r => r.wait());
      logger.success(`Created UnboundTokenSeller.sol implementation on proxy manager.`);
    }
  
    const poolImplementation = await deploy('IPool', 'poolImplementation', {
      from: deployer,
      gas: 4000000,
      args: []
    });
  
    if (poolImplementation.newlyDeployed) {
      logger.info('Adding pool to proxy manager...')
      await proxyManager.createManyToOneProxyRelationship(
        poolImplementationID,
        poolImplementation.address,
        { gasLimit: 400000 }
      ).then(r => r.wait());
      logger.success(`Created IPool.sol implementation on proxy manager.`);
    }
  
    const poolInitializerImplementation = await deploy('PoolInitializer', 'poolInitializerImplementation', {
      from: deployer,
      gas: 4000000,
      args: [shortTermUniswapOracle.address, controller.address]
    });

    if (poolInitializerImplementation.newlyDeployed) {
      logger.info('Adding pool initializer to proxy manager...')
      await proxyManager.createManyToOneProxyRelationship(
        poolInitializerID,
        poolInitializerImplementation.address,
        { gasLimit: 750000 }
      ).then(r => r.wait());
      logger.success(`Created PoolInitializer.sol implementation on proxy manager.`);
    }
    await proxyManager.approveDeployer(poolFactory.address, { gasLimit: 60000 }).then(r => r.wait());
    await proxyManager.approveDeployer(controller.address, { gasLimit: 60000 }).then(r => r.wait());
    logger.success(`Approved controller and factory to use the proxy manager.`);
  }

  if (poolFactory.newlyDeployed) {
    await poolFactory.approvePoolController(controller.address, { gasLimit: 60000 }).then(r => r.wait());
    logger.success(`Approved MarketCapSqrtController.sol to deploy pools through the factory.`);
  }
};

module.exports.tags = ['Core'];