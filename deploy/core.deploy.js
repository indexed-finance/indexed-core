const Logger = require('../lib/logger');
const Deployer = require('../lib/deployer');
const { sha3 } = require('../test/utils');

const poolInitializerID = sha3('PoolInitializer.sol')
const poolImplementationID = sha3('IPool.sol');
const sellerImplementationID = sha3('UnboundTokenSeller.sol');


/*
Deploys the base contracts for Indexed
=========================================
External Dependencies
- WETH (if not mainnet)
- Uniswap Factory (if not mainnet or rinkeby)
- Uniswap Router (if not mainnet or rinkeby)
Core Contracts
- Pool Factory
- Proxy Manager (if no existing deployment)
- Indexed UniswapV2 Oracle (if no existing deployment)
*/
module.exports = async (bre) => {
  const {
    deployments,
    getChainId,
    getNamedAccounts,
    ethers
  } = bre;
  const { deployer } = await getNamedAccounts();
  const [ signer ] = await ethers.getSigners();

  const chainID = await getChainId();
  const logger = Logger(chainID)
  const deploy = await Deployer(bre, logger);

  // ------- External Contracts -------
  const weth = (await deployments.get('weth')).address;
  const uniswapRouter = (await deployments.get('uniswapRouter')).address;
  const uniswapFactory = (await deployments.get('uniswapFactory')).address;

  let uniswapOracle;
  if (chainID == 1 || chainID == 4) {
    uniswapOracle = await ethers.getContract('uniswapOracle', signer);
  } else {
    uniswapOracle = await deploy("IndexedUniswapV2Oracle", 'uniswapOracle', {
      from: deployer,
      gas: 4000000,
      args: [uniswapFactory, weth]
    });
  }

  let proxyManager;
  if (chainID == 1 || chainID == 4) {
    proxyManager = await ethers.getContract('proxyManager', signer);
  } else {
    proxyManager = await deploy('DelegateCallProxyManager', 'proxyManager', {
      from: deployer,
      gas: 4000000,
      args: []
    }, true);
  }

  // ------- Core Contracts -------

  // Deploy pool factory
  const poolFactory = await deploy('PoolFactory', 'poolFactory', {
    contractName: 'poolFactory',
    from: deployer,
    gas: 4000000,
    args: [proxyManager.address]
  }, true);

  // Deploy pool controller
  const controller = await deploy('MarketCapSqrtController', 'controller', {
    from: deployer,
    gas: 4000000,
    args: [
      uniswapOracle.address,
      poolFactory.address,
      proxyManager.address
    ]
  }, true);

  const nullAddress = `0x${'00'.repeat(20)}`;
  const addImplementation = async (id, deployment) => {
    if (!deployment.newlyDeployed) return;
    const address = deployment.address;
    if (chainID == 1 || chainID == 4) {
      const existing = await proxyManager.getImplementationHolder(id);
      if (!existing || existing == nullAddress) {
        await proxyManager.createManyToOneProxyRelationship(id, address).then(r => r.wait());
        logger.success(`Created implementation for ${deployment.contractName}`);
      } else if (existing.toLowerCase() != address.toLowerCase()) {
        await proxyManager.setImplementationAddressManyToOne(id, address).then(r => r.wait());
        logger.success(`Updated implementation for ${deployment.contractName}`);
      } else {
        logger.info(`Implementation already exists for ${deployment.contractName} with same address`);
      }
    } else {
      await proxyManager.createManyToOneProxyRelationship(id, address).then(r => r.wait());
      logger.success(`Created implementation for ${deployment.contractName}`);
    }
  }

  const approveDeployer = async (address) => {
    if (chainID == 1 || chainID == 4) {
      const isApproved = await proxyManager.isApprovedDeployer(address);
      if (!isApproved) {
        await proxyManager.approveDeployer(address, { gasLimit: 60000 }).then(r => r.wait());
        logger.success(`Approved ${address} for mt1 proxy deployment`);
      } else {
        logger.info(`${address} is already an approved deployer`);
      }
    } else {
      await proxyManager.approveDeployer(address, { gasLimit: 60000 }).then(r => r.wait());
      logger.success(`Approved ${address} for mt1 proxy deployment`);
    }
  }

  await approveDeployer(poolFactory.address);
  await approveDeployer(controller.address);

  // Add UnboundTokenSeller implementation
  const tokenSellerImplementation = await deploy('UnboundTokenSeller', 'tokenSellerImplementation', {
    from: deployer,
    gas: 4000000,
    args: [uniswapRouter, uniswapOracle.address, controller.address]
  });
  await addImplementation(sellerImplementationID, tokenSellerImplementation);

  // Add IPool implementation
  const poolImplementation = await deploy('IPool', 'poolImplementation', {
    from: deployer,
    gas: 4000000,
    args: []
  });
  await addImplementation(poolImplementationID, poolImplementation);

  // Add PoolInitializer implementation
  const poolInitializerImplementation = await deploy('PoolInitializer', 'poolInitializerImplementation', {
    from: deployer,
    gas: 4000000,
    args: [uniswapOracle.address, controller.address]
  });
  await addImplementation(poolInitializerID, poolInitializerImplementation);

  const isApprovedController = await poolFactory.isApprovedController(controller.address);
  if (!isApprovedController) {
    await poolFactory.approvePoolController(controller.address);
    logger.success(`Approved MarketCapSqrtController.sol to deploy pools through the factory.`);
  } else {
    logger.info(`Controller is already approved to deploy pools.`);
  }
};

module.exports.tags = ['Core'];
module.exports.dependencies = ['Uniswap'];