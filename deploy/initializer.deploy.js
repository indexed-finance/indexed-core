const Logger = require('../lib/logger');
const Deployer = require('../lib/deployer');
const { sha3 } = require('../test/utils');

const poolInitializerID = sha3('PoolInitializer.sol')

module.exports = async (bre) => {
  const {
    getChainId,
    getNamedAccounts,
    ethers
  } = bre;
  const { deployer } = await getNamedAccounts();
  const [ signer ] = await ethers.getSigners();

  const chainID = +(await getChainId());
  const logger = Logger(chainID)
  const deploy = await Deployer(bre, logger);

  const gasPrice = (chainID == 1) ? 25000000000 : 1000000000;

  const proxyManager = await ethers.getContract('proxyManager', signer);
  const uniswapOracle = await ethers.getContract('IndexedUniswapV2Oracle', signer);
  const controller = await ethers.getContract('controller');

  const poolInitializerImplementation = await deploy('PoolInitializer', 'poolInitializerImplementation', {
    from: deployer,
    gas: 4000000,
    gasPrice,
    args: [uniswapOracle.address, controller.address]
  });

  await proxyManager.createManyToOneProxyRelationship(
    poolInitializerID,
    poolInitializerImplementation.address,
    { gasPrice, gasLimit: 150000 }
  ).then(r => r.wait());
};

module.exports.tags = ['PoolInitializer'];