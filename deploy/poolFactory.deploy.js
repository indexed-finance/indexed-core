const Logger = require('../lib/logger');
const Deployer = require('../lib/deployer');
const { sha3 } = require('../test/utils');

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

  const poolFactory = await deploy('PoolFactory', 'poolFactory', {
    contractName: 'poolFactory',
    from: deployer,
    gas: 4000000,
    gasPrice,
    nonce: 1,
    args: [proxyManager.address]
  }, true);

  await bre.run('approve_proxy_deployer', { address: poolFactory.address, gasPrice });
};

module.exports.tags = ['PoolFactory'];