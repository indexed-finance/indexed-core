const Logger = require('../lib/logger');
const Deployer = require('../lib/deployer');

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

  const gasPrice = (chainID == 1) ? 140000000000 : 1000000000;

  const poolFactory = await ethers.getContract('PoolFactory');

  const poolFactoryAccessControl = await deploy('PoolFactoryAccessControl', 'poolFactoryAccessControl', {
    from: deployer,
    gas: 4000000,
    gasPrice,
    args: [poolFactory.address]
  }, true);
};

module.exports.tags = ['PoolFactoryAccessControl'];