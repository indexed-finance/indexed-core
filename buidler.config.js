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

let debug = true  ;
const printDebug = (str) => {
  if (!debug) return;
  console.log(str);
}

const deployERC20 = async (name, symbol) => {
  const factory = await ethers.getContractFactory('MockERC20');
  const token = await factory.deploy(name, symbol);
  await token.deployed();
  return token;
}

const getERC20 = async (address) => {
  const token = await ethers.getContractAt('MockERC20', address);
  return token;
}

const poolControllerSalt = soliditySha3('PoolController.sol');
const uniswapOracleSalt = soliditySha3('UniSwapV2PriceOracle.sol');
const poolInitializerID = soliditySha3('PoolInitializer.sol')
const poolImplementationID = soliditySha3('IPool.sol');
const sellerImplementationID = soliditySha3('UnboundTokenSeller.sol');

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
    const weth = await deployERC20('WETH V9', 'WETH');
    printDebug(`Deployed WETH to ${weth.address}`);
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
      [uniswapFactory.options.address, weth.address]
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

internalTask("deploy_uniswap_oracle", "Deploys the UniSwap oracle or returns the existing one.")
  .setAction(async () => {
    const bre = getBre();

    if (getDeployed(bre, 'uniswapOracle')) {
      return getDeployed(bre, 'uniswapOracle');
    }

    const {
      uniswapFactory,
      weth
    } = await bre.run('deploy_uniswap');

    printDebug('-- UniSwapV2 Price Oracle --');

    const factory = await ethers.getContractFactory('UniSwapV2PriceOracle');
    const uniswapOracle = await factory.deploy(
      uniswapFactory.options.address,
      weth.address,
      3.5 * 24 * 60 * 60
    );
    await uniswapOracle.deployed();
    printDebug(`UniSwapV2 Price Oracle deployed to ${uniswapOracle.address}`);
    return setDeployed(bre, 'uniswapOracle', uniswapOracle);
  });

internalTask("deploy_short_term_uniswap_oracle", "Deploys the short term UniSwap oracle or returns the existing one.")
  .setAction(async () => {
    const bre = getBre();

    if (getDeployed(bre, 'shortUniswapOracle')) {
      return getDeployed(bre, 'shortUniswapOracle');
    }

    const {
      uniswapFactory,
      weth
    } = await bre.run('deploy_uniswap');

    printDebug('-- UniSwapV2 Short Term Price Oracle --');

    const factory = await ethers.getContractFactory('UniSwapV2PriceOracle');
    const uniswapOracle = await factory.deploy(
      uniswapFactory.options.address,
      weth.address,
      60 * 60
    );
    await uniswapOracle.deployed();
    printDebug(`UniSwapV2 Short Term Price Oracle deployed to ${uniswapOracle.address}`);
    return setDeployed(bre, 'shortUniswapOracle', uniswapOracle);
  });

internalTask(
  "deploy_seller_implementation",
  "Deploys the unbound token seller implementation or returns the existing one."
)
  .setAction(async () => {
    const bre = getBre();
    if (getDeployed(bre, 'sellerImplementation')) {
      return getDeployed(bre, 'sellerImplementation');
    }
    const proxyManager = await bre.run('deploy_proxy_manager');
    const oracle = await bre.run('deploy_short_term_uniswap_oracle');
    const controller = await bre.run('deploy_controller')
    const sellerImplementationHolder = await proxyManager
      .functions['getImplementationHolder(bytes32)'](
        sellerImplementationID
      );
    const from = getDeployed(bre, 'from');
    printDebug('-- Unbound Token Seller Implementation --');

    if (sellerImplementationHolder != `0x${'00'.repeat(20)}`) {
      printDebug(`Unbound Token Seller Implementation Holder found at ${sellerImplementationHolder}`);
      const holder = await ethers.getContractAt(
        'ManyToOneImplementationHolder',
        sellerImplementationHolder
      );
      const sellerImplementation = await holder.getImplementationAddress();
      printDebug(`Unbound Token Seller Implementation found at ${sellerImplementation.address}`);
      return setDeployed(
        bre,
        'sellerImplementation',
        await ethers.getContractAt('UnboundTokenSeller', sellerImplementation)
      );
    }

    const SellerImplementation = await ethers.getContractFactory('UnboundTokenSeller');
    const sellerImplementation = await SellerImplementation.deploy(
      getDeployed('uniswapRouter').options.address,
      oracle.address,
      controller.address
    );
    await sellerImplementation.deployed();

    printDebug(`Unbound Token Seller Implementation deployed to ${sellerImplementation.address}`);
    await proxyManager.createManyToOneProxyRelationship(
      sellerImplementationID,
      sellerImplementation.address
    );
    return setDeployed(bre, 'sellerImplementation', sellerImplementation);
  });

internalTask("deploy_pool_implementation", "Deploys the pool implementation or returns the existing one.")
  .setAction(async () => {
    const bre = getBre();
    if (getDeployed(bre, 'poolImplementation')) {
      return getDeployed(bre, 'poolImplementation');
    }
    const proxyManager = await bre.run('deploy_proxy_manager');
    const poolImplementationHolder = await proxyManager
      .functions['getImplementationHolder(bytes32)'](
        poolImplementationID
      );

    printDebug('-- Pool Implementation --');

    if (poolImplementationHolder != `0x${'00'.repeat(20)}`) {
      printDebug(`Pool Implementation Holder found at ${poolImplementationHolder}`);
      const holder = await ethers.getContractAt(
        'ManyToOneImplementationHolder',
        poolImplementationHolder
      );
      const poolImplementation = await holder.call();
      printDebug(`Pool Implementation found at ${poolImplementation.address}`);
      return setDeployed(
        bre,
        'poolImplementation',
        await ethers.getContractAt('IPool', poolImplementation)
      );
    }

    const PoolImplementation = await ethers.getContractFactory('IPool');
    const poolImplementation = await PoolImplementation.deploy();
    await poolImplementation.deployed();

    printDebug(`Pool Implementation deployed to ${poolImplementation.address}`);
    await proxyManager.createManyToOneProxyRelationship(
      poolImplementationID,
      poolImplementation.address
    );
    return setDeployed(bre, 'poolImplementation', poolImplementation);
  });

internalTask(
  "deploy_pool_initializer_implementation",
  "Deploys the pool initializer implementation or returns the existing one."
)
  .setAction(async () => {
    const bre = getBre();
    if (getDeployed(bre, 'poolInitializerImplementation')) {
      return getDeployed(bre, 'poolInitializerImplementation');
    }
    const oracle = await bre.run('deploy_short_term_uniswap_oracle');
    const proxyManager = getDeployed(bre, 'proxyManager');
    printDebug('-- Pool Initializer --');

    const initializerImplementationHolder = await proxyManager
      .functions['getImplementationHolder(bytes32)'](
        poolInitializerID
      );

    printDebug('-- Pool Implementation --');

    if (initializerImplementationHolder != `0x${'00'.repeat(20)}`) {
      printDebug(`Pool Initializer Implementation Holder found at ${
        initializerImplementationHolder
      }`);
      const holder = await ethers.getContractAt(
        'ManyToOneImplementationHolder',
        initializerImplementationHolder
      );
      const initializerImplementation = await holder.getImplementationAddress();
      printDebug(`Pool Initializer Implementation found at ${
        initializerImplementation.address
      }`);
      return setDeployed(
        bre,
        'poolInitializerImplementation',
        await ethers.getContractAt('PoolInitializer', initializerImplementation)
      );
    }
    const controller = getDeployed(bre, 'controller');
    const PoolInitializer = await ethers.getContractFactory('PoolInitializer');
    const poolInitializerImplementation = await PoolInitializer.deploy(
      oracle.address,
      controller.address
    );
    await poolInitializerImplementation.deployed();
    await proxyManager.createManyToOneProxyRelationship(
      poolInitializerID,
      poolInitializerImplementation.address
    );
    printDebug(`Pool Initializer implementation deployed to ${poolInitializerImplementation.address}`);
    return setDeployed(bre, 'poolInitializerImplementation', poolInitializerImplementation);
  });

internalTask("deploy_pool_factory", "Deploys the pool factory or returns the existing one.")
  .setAction(async () => {
    if (debug) printDebug(`Deploying pool factory...`)
    const bre = getBre();
    if (getDeployed(bre, 'poolFactory')) {
      return getDeployed(bre, 'poolFactory');
    }
    await bre.run('deploy_pool_implementation');
    const from = await bre.run('get_from');
    const proxyManager = getDeployed(bre, 'proxyManager');
    const PoolFactory = await ethers.getContractFactory('PoolFactory');
    const poolFactory = await PoolFactory.deploy(
      from,
      proxyManager.address
    );
    await poolFactory.deployed();
    printDebug(`Pool Factory deployed to ${poolFactory.address}`);
    return setDeployed(bre, 'poolFactory', poolFactory);
  })

internalTask(
  "deploy_category_oracle",
  "Deploys a test MarketCapSortedTokenCategories contract or returns the existing one."
)
  .setAction(async () => {
    if (debug) printDebug(`Deploying category oracle...`)
    const bre = getBre();
    if (getDeployed(bre, 'categoryOracle')) {
      return getDeployed(bre, 'categoryOracle');
    }
    const oracle = await bre.run('deploy_uniswap_oracle');
    const from = getDeployed(bre, 'from');
    const MarketCapSortedTokenCategories = await ethers.getContractFactory('MarketCapSortedTokenCategories');
    const categoryOracle = await MarketCapSortedTokenCategories.deploy(
      oracle.address,
      from
    );
    await categoryOracle.deployed();
    return setDeployed(bre, 'categoryOracle', categoryOracle);
  });

internalTask(
  "deploy_controller",
  "Deploys the Market Cap Square Root controller or returns the existing one."
)
  .setAction(async () => {
    if (debug) printDebug(`Deploying pool controller...`)
    const bre = getBre();
    if (getDeployed(bre, 'controller')) {
      return getDeployed(bre, 'controller');
    }
    const poolFactory = await bre.run('deploy_pool_factory');
    const oracle = await bre.run('deploy_uniswap_oracle');
    const proxyManager = getDeployed(bre, 'proxyManager');
    const from = getDeployed(bre, 'from');
    const MarketCapSqrtController = await ethers.getContractFactory('MarketCapSqrtController');
    const controller = await MarketCapSqrtController.deploy(
      oracle.address,
      from,
      poolFactory.address,
      proxyManager.address
    );
    await controller.deployed();
    setDeployed(bre, 'controller', controller);
    await bre.run('deploy_pool_initializer_implementation');
    return controller;
  });

internalTask('approve_deployers', "Approves the controller & factory to use the proxy manager")
  .setAction(async () => {
    const bre = getBre();
    printDebug('-- Deployment Approval --');
    const proxyManager = getDeployed(bre, 'proxyManager');
    const poolFactory = await bre.run('deploy_pool_factory');
    const controller = await bre.run('deploy_controller');
    await proxyManager.approveDeployer(poolFactory.address);
    printDebug(`Approved the pool factory to deploy proxies`);
    await proxyManager.approveDeployer(controller.address);
    printDebug(`Approved the pool controller to deploy proxies`);
    await poolFactory.approvePoolController(controller.address);
    printDebug('Approved pool controller to deploy pools');
  })

internalTask("deploy_contracts", "deploys all the core contracts")
  .setAction(async () => {
    const bre = getBre();
    await bre.run('deploy_pool_controller');
    await bre.run('approve_deployers');
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
