const Deployer = require('../lib/deployer');
const Logger = require('../lib/logger');

module.exports = async (bre) => {
  const { getChainId, getNamedAccounts } = bre;
  const chainID = await getChainId();
  const logger = Logger(chainID, 'deploy-uniswap-mocks');

  const { deployer } = await getNamedAccounts();
  const deploy = await Deployer(bre, logger);

  if (chainID == 1) return;

  const weth = await deploy('MockERC20', 'weth', {
    from: deployer,
    gas: 4000000,
    args: ["Wrapped Ether V9", "WETH9"]
  });

  if (chainID == 4) return;

  const uniswapFactory = await deploy("UniswapV2Factory", 'uniswapFactory', {
    from: deployer,
    gas: 4000000,
    args: [deployer]
  });

  const router = await deploy('UniswapV2Router02', 'uniswapRouter', {
    from: deployer,
    gas: 4000000,
    args: [uniswapFactory.address, weth.address]
  });
};

module.exports.tags = ['Uniswap'];