const Logger = require('../lib/logger');
const Deployer = require('../lib/deployer');
const { sha3 } = require('../test/utils');

const sellerImplementationID = sha3('UnboundTokenSeller.sol');

module.exports = async (bre) => {
  const {
    deployments,
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

  const uniswapRouter = (await deployments.get('uniswapRouter')).address;
  const proxyManager = await ethers.getContract('proxyManager', signer);
  const uniswapOracle = await ethers.getContract('IndexedUniswapV2Oracle', signer);
  const controller = await ethers.getContract('controller');

  const tokenSellerImplementation = await deploy('UnboundTokenSeller', 'tokenSellerImplementation', {
    from: deployer,
    gas: 4000000,
    gasPrice,
    args: [uniswapRouter, uniswapOracle.address, controller.address]
  });

  await proxyManager.createManyToOneProxyRelationship(
    sellerImplementationID,
    tokenSellerImplementation.address,
    { gasPrice, gasLimit: 150000 }
  ).then(r => r.wait());

  logger.success(`Created implementation for token seller`);
};

module.exports.tags = ['TokenSellerImplementation'];