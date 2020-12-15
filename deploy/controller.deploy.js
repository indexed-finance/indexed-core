const Logger = require('../lib/logger');
const Deployer = require('../lib/deployer');

const { controllerImplementationSalt } = require('../lib/implementationIDs');

module.exports = async (bre) => {
  const {
    deployments,
    getChainId,
    getNamedAccounts,
    ethers
  } = bre;
  const { deployer } = await getNamedAccounts();

  const chainID = +(await getChainId());
  const logger = Logger(chainID)
  const deploy = await Deployer(bre, logger);

  const gasPrice = (chainID == 1) ? 25000000000 : 1000000000;

  const proxyManager = await ethers.getContract('proxyManager');
  const uniswapOracle = await ethers.getContract('IndexedUniswapV2Oracle');
  const poolFactory = await ethers.getContract('poolFactory');

  // Deploy pool controller implementation
  const controllerImplementation = await deploy('MarketCapSqrtController', 'controllerImplementation', {
    from: deployer,
    gas: 4000000,
    gasPrice,
    args: [uniswapOracle.address, poolFactory.address, proxyManager.address]
  });
  // Compute proxy address
  const controllerAddress = await proxyManager.computeProxyAddressOneToOne(deployer, controllerImplementationSalt);

  // // Create proxy
  await proxyManager.deployProxyOneToOne(controllerImplementationSalt, controllerImplementation.address, { gasLimit: 500000, gasPrice });
  // // Get interface for contract
  const controller = await ethers.getContractAt('MarketCapSqrtController', controllerAddress);
  // // Initialize ctrlr
  await controller.initialize({ gasLimit: 500000, gasPrice });
  // // Update deployment info
  controllerImplementation.address = controllerAddress;
  controllerImplementation.receipt.contractAddress = controllerAddress;
  await deployments.save('controller', controllerImplementation);

  await bre.run('approve_proxy_deployer', { address: controller.address, gasPrice });
  await bre.run('approve_pool_controller', { address: controller.address, gasPrice });
};

module.exports.tags = ['Controller'];