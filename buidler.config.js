usePlugin("@nomiclabs/buidler-waffle");
usePlugin("@nomiclabs/buidler-web3");

const { types, internalTask } = require("@nomiclabs/buidler/config")

const {
  abi: UniswapV2FactoryABI,
  bytecode: UniswapV2FactoryBytecode,
} = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const {
  abi: UniswapV2RouterABI,
  bytecode: UniswapV2RouterBytecode,
} = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");

const { soliditySha3 } = require('web3-utils');

const { deployERC20, getERC20 } = require('./lib/erc20');
const { deploy, contractExists } = require('./lib/util/contracts');

let getDeployed = (bre, name) => {
  if (!bre.config.deployed) bre.config.deployed = {};
  return bre.config.deployed[name];
}

let setDeployed = (bre, name, address) => {
  if (!bre.config.deployed) bre.config.deployed = {};
  bre.config.deployed[name] = address;
  return address;
}

let debug = false;
const printDebug = (str) => {
  if (!debug) return;
  console.log(str);
}

const poolControllerSalt = soliditySha3('PoolController.sol');
const marketOracleSalt = soliditySha3('MarketOracle.sol');
const tokenBuyerSalt = soliditySha3('RestrictedTokenBuyer.sol')
const poolImplementationID = soliditySha3('BPool.sol');

const getBre = () => require("@nomiclabs/buidler");

internalTask("get_from", "Gets the first caller address")
  .setAction(async () => {
    const bre = getBre();
    let from = getDeployed(bre, 'from');
    return from || setDeployed(
      bre,
      'from',
      (await web3.eth.getAccounts())[0]
    );
  })

internalTask("deploy_uniswap", "Deploys UniSwap contracts or returns the existing ones.")
  .setAction(async () => {
    const bre = getBre();
    const from = await bre.run('get_from');
    if (getDeployed(bre, 'uniswapFactory')) {
      return {
        uniswapFactory: getDeployed(bre, 'uniswapFactory'),
        uniswapRouter: getDeployed(bre, 'uniswapRouter'),
        weth: getDeployed(bre, 'weth')
      }
    }
    printDebug('-- UniSwap --');
    if (bre.config.defaultNetwork == 'mainnet') {
      printDebug('Reading UniSwap contracts from mainnet...');
      return {
        uniswapFactory: setDeployed(
          bre,
          'uniswapFactory',
          toContract(web3, UniswapV2FactoryABI, '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f')
        ),
        uniswapRouter: setDeployed(
          bre,
          'uniswapRouter',
          toContract(web3, UniswapV2RouterABI, '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D')
        ),
        weth: setDeployed(
          bre,
          'weth',
          getERC20(web3, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
        )
      }
    }
    const weth = await deployERC20(web3, from, 'WETH V9', 'WETH');
    printDebug(`Deployed WETH to ${weth.options.address}`);
    const uniswapFactory = await deploy(
      web3,
      from,
      UniswapV2FactoryABI,
      UniswapV2FactoryBytecode,
      [from]
    );
    printDebug(`Deployed UniSwap Factory to ${uniswapFactory.options.address}`);
    const uniswapRouter = await deploy(
      web3,
      from,
      UniswapV2RouterABI,
      UniswapV2RouterBytecode,
      [uniswapFactory.options.address, weth.options.address]
    );
    printDebug(`Deployed UniSwap Router to ${uniswapRouter.options.address}`);
    return {
      uniswapFactory: setDeployed(bre, 'uniswapFactory', uniswapFactory),
      uniswapRouter: setDeployed(bre, 'uniswapRouter', uniswapRouter),
      weth: setDeployed(bre, 'weth', weth)
    };
  });

internalTask("deploy_proxy_manager", "Deploys the proxy manager or returns the existing one.")
  .setAction(async () => {
    const bre = getBre();
    if (getDeployed(bre, 'proxyManager')) {
      return getDeployed(bre, 'proxyManager');
    }
    printDebug('-- Proxy Manager --');
    const factory = await ethers.getContractFactory('DelegateCallProxyManager');
    const proxyManager = await factory.deploy();
    await proxyManager.deployed();
    setDeployed(
      bre,
      'proxyManager',
      proxyManager
    );
    printDebug(`Deployed Proxy Manager to ${proxyManager.address}`);
    return proxyManager;
  });

internalTask("deploy_market_oracle", "Deploys the market oracle or returns the existing one.")
  .setAction(async () => {
    const bre = getBre();

    if (getDeployed(bre, 'marketOracle')) {
      return getDeployed(bre, 'marketOracle');
    }

    const from = await bre.run('get_from');
    const {
      uniswapFactory,
      weth
    } = await bre.run('deploy_uniswap');
    const proxyManager = await bre.run('deploy_proxy_manager');

    printDebug('-- Market Oracle --');

    const oracleAddress = await proxyManager.computeProxyAddressOneToOne(marketOracleSalt);
    const isDeployed = await contractExists(web3, oracleAddress);
    if (isDeployed) {
      printDebug(`Market Oracle proxy found at ${oracleAddress}`);
      return setDeployed(
        bre,
        'marketOracle',
        await ethers.getContractAt('MarketOracle', oracleAddress)
      )
    }
    const factory = await ethers.getContractFactory('MarketOracle');
    const marketOracleImplementation = await factory.deploy(
      uniswapFactory.options.address,
      weth.options.address,
      from
    );
    await marketOracleImplementation.deployed();
    printDebug(`Market Oracle implementation deployed to ${marketOracleImplementation.address}`);
    await proxyManager.deployProxyOneToOne(
      marketOracleSalt,
      marketOracleImplementation.address
    );
    printDebug(`Market Oracle proxy deployed to ${oracleAddress}`);
    return setDeployed(
      bre,
      'marketOracle',
      await ethers.getContractAt('MarketOracle', oracleAddress)
    );
  });

internalTask("deploy_pool_implementation", "Deploys the pool implementation or returns the existing one.")
  .setAction(async () => {
    const bre = getBre();
    if (getDeployed(bre, 'poolImplementation')) {
      return getDeployed(bre, 'poolImplementation');
    }
    const proxyManager = await bre.run('deploy_proxy_manager');
    const poolImplementationHolder = await proxyManager.functions['getImplementationHolder(bytes32)'](
      poolImplementationID
    );

    printDebug('-- Pool Implementation --');

    if (poolImplementationHolder != `0x${'00'.repeat(20)}`) {
      printDebug(`Pool Implementation Holder found at ${poolImplementationHolder}`);
      const holder = await ethers.getContractAt(
        'ManyToOneImplementationHolder',
        poolImplementationHolder
      );
      const poolImplementation = await holder.getImplementationAddress();
      printDebug(`Pool Implementation found at ${poolImplementation.address}`);
      return setDeployed(
        bre,
        'poolImplementation',
        await ethers.getContractAt('BPool', poolImplementation)
      );
    }

    const PoolImplementation = await ethers.getContractFactory('BPool');
    const poolImplementation = await PoolImplementation.deploy();
    await poolImplementation.deployed();
    printDebug(`Pool Implementation deployed to ${poolImplementation.address}`);
    await proxyManager.createManyToOneProxyRelationship(
      poolImplementationID,
      poolImplementation.address
    );
    return setDeployed(bre, 'poolImplementation', poolImplementation);
  });

internalTask("deploy_token_buyer", "Deploys the token buyer or returns the existing one.")
  .setAction(async () => {
    const bre = getBre();
    if (getDeployed(bre, 'tokenBuyer')) {
      return getDeployed(bre, 'tokenBuyer');
    }
    await bre.run('deploy_market_oracle');
    const proxyManager = getDeployed(bre, 'proxyManager');
    printDebug('-- Token Buyer --');

    const buyerAddress = await proxyManager.computeProxyAddressOneToOne(tokenBuyerSalt);
    const isDeployed = await contractExists(web3, buyerAddress);
    if (isDeployed) {
      printDebug(`Token Buyer proxy found at ${buyerAddress}`);
      return setDeployed(
        bre,
        'tokenBuyer',
        await ethers.getContractAt('RestrictedTokenBuyer', buyerAddress)
      )
    }

    const controllerAddress = await proxyManager.computeProxyAddressOneToOne(poolControllerSalt);
    const RestrictedTokenBuyer = await ethers.getContractFactory('RestrictedTokenBuyer');
    const tokenBuyerImplementation = await RestrictedTokenBuyer.deploy(
      controllerAddress,
      getDeployed(bre, 'uniswapFactory').options.address,
      getDeployed(bre, 'uniswapRouter').options.address,
      getDeployed(bre, 'weth').options.address
    );
    await tokenBuyerImplementation.deployed();
    printDebug(`Token Buyer implementation deployed to ${tokenBuyerImplementation.address}`);
    setDeployed(bre, 'tokenBuyerImplementation', tokenBuyerImplementation);
    await proxyManager.deployProxyOneToOne(
      tokenBuyerSalt,
      tokenBuyerImplementation.address
    );
    printDebug(`Token Buyer proxy deployed to ${buyerAddress}`);
    return setDeployed(
      bre,
      'tokenBuyer',
      await ethers.getContractAt('RestrictedTokenBuyer', buyerAddress)
    );
  });

internalTask("deploy_pool_controller", "Deploys the pool implementation or returns the existing one.")
  .setAction(async () => {
    if (debug) console.log(`Deploying pool controller...`)
    const bre = getBre();
    if (getDeployed(bre, 'poolController')) {
      return getDeployed(bre, 'poolController');
    }

    await bre.run('deploy_pool_implementation');
    const from = await bre.run('get_from');
    const tokenBuyer = await bre.run('deploy_token_buyer');
    printDebug(`-- Pool Controller --`);
    const proxyManager = getDeployed(bre, 'proxyManager');

    const controllerAddress = await proxyManager.computeProxyAddressOneToOne(poolControllerSalt);
    const isDeployed = await contractExists(web3, controllerAddress);
    if (isDeployed) {
      printDebug(`Pool Controller proxy found at ${controllerAddress}`);
      return setDeployed(
        bre,
        'poolController',
        await ethers.getContractAt('PoolController', controllerAddress)
      );
    }
    const PoolController = await ethers.getContractFactory('PoolController');
    const poolControllerImplementation = await PoolController.deploy(
      from,
      getDeployed(bre, 'marketOracle').address,
      proxyManager.address,
      getDeployed(bre, 'weth').options.address,
      tokenBuyer.address
    );
    await poolControllerImplementation.deployed();
    printDebug(`Pool Controller implementation deployed to ${poolControllerImplementation.address}`);
    setDeployed(
      bre,
      'poolControllerImplementation',
      poolControllerImplementation
    );
    await proxyManager.deployProxyOneToOne(
      poolControllerSalt,
      poolControllerImplementation.address
    );
    await proxyManager.approveDeployer(controllerAddress);
    printDebug(`Approved Pool Controller to deploy many-to-one proxies`);
    printDebug(`Pool Controller proxy deployed to ${controllerAddress}`);
    
    const poolController = setDeployed(
      bre,
      'poolController',
      await ethers.getContractAt('PoolController', controllerAddress)
    );
    await poolController.setPremiumRate(4);
    printDebug(`Set token buyer premium rate to 4%`);
    return poolController;
  });

internalTask("deploy_contracts", "deploys all the core contracts")
  .setAction(async () => {
    const bre = getBre();
    await bre.run('deploy_pool_controller');
    return bre.config.deployed;
  })

task("deploy_all", "deploys all the core contracts")
  .addOptionalParam("debug", "Print debug output", false, types.boolean)
  .setAction(async ({ debug: _debug }) => {
    debug = _debug;
    const bre = getBre();
    await bre.run('deploy_contracts');
  });

// You have to export an object to set up your config
// This object can have the following optional entries:
// defaultNetwork, networks, solc, and paths.
// Go to https://buidler.dev/config/ to learn more
module.exports = {
  // This is a sample solc configuration that specifies which version of solc to use
  solc: {
    version: "0.6.8",
    optimizer: {
      enabled: true,
      runs: 200
    }
  },
};
