const path = require('path');
const url = require('url');
const fs = require('fs');
const moment = require('moment');
const Table = require('cli-table3');

const Logger = require('./lib/util/logger');
const uploadFile = require('./lib/util/upload');
const Deployer = require('./lib/util/deployer');

require('dotenv').config();

const { InfuraProvider } = require('@ethersproject/providers');
const { fromPrivateKey } = require('ethereumjs-wallet');
const { randomBytes } = require('crypto');

const { internalTask, task, types } = require("@nomiclabs/buidler/config");
const { isAddress, formatEther } = require('ethers/lib/utils');
const { toBN, toHex, oneToken, nTokensHex } = require('./lib/util/bn');
const chalk = require('chalk');

usePlugin("@nomiclabs/buidler-web3");
usePlugin("@nomiclabs/buidler-ethers");
usePlugin("buidler-ethers-v5");
usePlugin("buidler-deploy");
usePlugin('buidler-abi-exporter');
usePlugin("solidity-coverage");

const keys = {
  rinkeby: fromPrivateKey(
    process.env.RINKEBY_PVT_KEY
      ? Buffer.from(process.env.RINKEBY_PVT_KEY.slice(2), 'hex')
      : randomBytes(32)).getPrivateKeyString()
};

/*  =========== Internal Tasks  =========== */

internalTask('getTimestamp', () => {
  return web3.eth.getBlock('latest').then(b => b.timestamp);
});

internalTask('increaseTime', 'Increases the node timestamp')
  .setAction(async ({ days, hours, seconds }) => {
    const amount = days ? days * 86400 : hours ? hours * 3600 : seconds;
    await web3.currentProvider._sendJsonRpcRequest({
      method: "evm_increaseTime",
      params: [amount],
      jsonrpc: "2.0",
      id: new Date().getTime()
    });
  });

internalTask('deploy-test-token-and-market', 'Deploy a test token and Uniswap market pair for it and WETH')
  .setAction(async ({ logger, name, symbol }) => {
    const bre = require('@nomiclabs/buidler');
    const { deployments } = bre;
    const chainID = await getChainId();
    if (!logger) logger = Logger(undefined, 'deploy-test-token-and-market');
    if (chainID != 31337 && chainID != 4) {
      throw new Error(`Must be on testnet to deploy test tokens.`);
    }
    const [signer] = await ethers.getSigners();
    const { deployer } = await getNamedAccounts();
    const deploy = await Deployer(bre, logger);
    let erc20;
    if (await deployments.getOrNull(symbol.toLowerCase())) {
      erc20 = await ethers.getContractAt(
        'MockERC20',
        (await deployments.getOrNull(symbol.toLowerCase())).address,
        signer
      );
      logger.info(`Found existing deployment for ${symbol}`);
    } else {
      erc20 = await deploy('MockERC20', symbol.toLowerCase(), {
        from: deployer,
        gas: 4000000,
        args: [name, symbol]
      }, true);
      logger.info(`Deployed MockERC20 for ${symbol}`);
    }
    logger.info(`Creating pair for ${symbol}:WETH`);
    const weth = await ethers.getContract('weth');
    let factory;
    if (chainID == 4) {
      factory = await ethers.getContractAt('UniswapV2Factory', '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', signer);
    } else {
      factory = await ethers.getContract('UniswapV2Factory', signer);
    }
    if (
      (await factory.getPair(erc20.address, weth.address)) == '0x0000000000000000000000000000000000000000' &&
      (await factory.getPair(weth.address, erc20.address)) == '0x0000000000000000000000000000000000000000'
    ) {
      await factory.createPair(erc20.address, weth.address).then(tx => tx.wait());
      logger.info(`Created pair for ${symbol}:WETH`);
    } else {
      logger.error(`Pair for ${symbol}:WETH already exists`);
    }
    return erc20;
  });

internalTask('add-liquidity', 'Add liquidity to a test token market')
  .setAction(async ({ logger, symbol, amountToken, amountWeth }) => {
    const bre = require('@nomiclabs/buidler');
    const { deployments } = bre;
    const chainID = await getChainId();
    const deploy = await Deployer(bre, logger);
    const { deployer } = await getNamedAccounts();
    if (!logger) {
      logger = Logger(undefined, 'add-liquidity');
    }
    if (chainID != 31337 && chainID != 4) {
      throw new Error(`Must be on testnet to add liquidity to test tokens.`);
    }
    const [signer] = await ethers.getSigners();
    const weth = await ethers.getContract('weth');
    let factory, router;
    if (chainID == 4) {
      factory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
      router = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
    } else {
      factory = (await deployments.getOrNull('UniswapV2Factory')).address;
      router = (await deployments.getOrNull('UniswapV2Router02')).address;
    }
    const liquidityAdder = await deploy('LiquidityAdder', 'liquidityAdder', {
      from: deployer,
      gas: 1000000,
      args: [
        weth.address,
        factory,
        router
      ]
    }, true);
    const erc20 = await ethers.getContractAt(
      'MockERC20',
      (await deployments.getOrNull(symbol.toLowerCase())).address,
      signer
    );
    logger.success(`Adding liquidity to ${symbol}:ETH market`);
    await liquidityAdder.addLiquiditySingle(
      erc20.address,
      amountToken,
      amountWeth,
      { gasLimit: 4700000 }
    ).then(r => r.wait());
    logger.success(`Added liquidity to ${symbol}:ETH market`);
  });

internalTask('update-prices', 'Update the prices for a list of tokens')
  .setAction(async ({ logger, tokens }) => {
    if (!logger) {
      logger = Logger(undefined, 'update-prices');
    }
    const [signer] = await ethers.getSigners();
    logger.info('Updating prices on weekly TWAP oracle...');
    const shortOracle = await ethers.getContract('HourlyTWAPUniswapV2Oracle', signer);
    await shortOracle.updatePrices(tokens, { gasLimit: 2000000 }).then(r => r.wait());
    logger.info('Updated prices on weekly TWAP oracle!');
    logger.info('Updating prices on hourly TWAP oracle...');
    const oracle = await ethers.getContract('WeeklyTWAPUniSwapV2Oracle', signer);
    await oracle.updatePrices(tokens, { gasLimit: 2000000 }).then(r => r.wait());
    logger.success('Updated prices on hourly TWAP oracle!');
  });
/*  =========== Tasks for test networks =========== */


task('update-category-prices', 'Update the prices for all the tokens on a category')
  .addParam('id', 'Category ID to update prices for')
  .setAction(async ({ id }) => {
    const [signer] = await ethers.getSigners();
    const logger = Logger(undefined, 'update-category-prices');
    const controller = await ethers.getContract('controller', signer);
    logger.info('Getting category tokens...');
    const tokens = await controller.getCategoryTokens(id);
    logger.success(`Found ${tokens.length} tokens in category`);
    await run('update-prices', { tokens });
  });

task('add-test-liquidity', 'Add liquidity to test token markets')
  .addParam('file', 'Path to JSON file with the array of tokens')
  .addParam('updatePrices', 'Whether to update the prices of the tokens on the Uniswap oracles', false, types.boolean)
  .setAction(async ({ file, updatePrices }) => {
    const [signer] = await ethers.getSigners();
    const chainID = await getChainId();
    if (chainID != 31337 && chainID != 4) {
      throw new Error(`Must be on testnet to add liquidity to test tokens.`);
    }
    const logger = Logger(undefined, 'add-test-liquidity');
    if (!fs.existsSync(file)) {
      throw new Error(`Invalid path given for file: ${file}`);
    }
    const tokens = require(file);
    const addresses = [];
    for (let token of tokens) {
      const { marketcap, name, symbol, price } = token;
      if (!marketcap || !name || !symbol || !price) {
        throw new Error(`Token JSON must include: marketcap, name, symbol, price`);
      }
      const erc20 = await ethers.getContract(
        'MockERC20',
        (await deployments.getOrNull(symbol.toLowerCase())).address,
        signer
      );
      addresses.push(erc20.address);
      const totalSupply = await erc20.totalSupply();
      let amountWeth = toBN(marketcap);
      if (totalSupply.eq(0)) {
        amountWeth = amountWeth.divn(10);
      }
      let amountToken = amountWeth.divn(price);
      await run('add-liquidity', {
        logger,
        symbol,
        amountToken: toHex(amountToken.mul(oneToken)),
        amountWeth: toHex(amountWeth.mul(oneToken))
      });
    }
    if (updatePrices) {
      await run('update-prices', { logger, tokens: addresses });
    }
  });

const measurements = ["years", "months", "weeks", "days", "hours", "minutes", "seconds"];
const withPadding = (duration) => {
  let step = null;
  return measurements.map((m) => duration[m]()).filter((n,i,a) => {
    var nonEmpty = Boolean(n);
    if (nonEmpty || step || i >= a.length - 2) {
        step = true;
    }
    return step;
  }).map((n) => ('0' + n).slice(-2)).join(':')
}

task('fast-forward', 'Move the node\'s clock forward')
  .addOptionalParam('seconds', 'Number of seconds to fast-forward')
  .addOptionalParam('minutes', 'Number of minutes to fast-forward')
  .addOptionalParam('hours', 'Number of hours to fast-forward')
  .addOptionalParam('days', 'Number of days to fast-forward')
  .setAction(async ({ seconds, minutes, hours, days }) => {
    const logger = Logger(undefined, 'fast-forward');
    const chainID = await getChainId();
    if (chainID != 31337 && chainID != 4) {
      throw new Error(`Must be on testnet to fast-forward`);
    }
    let totalSeconds = 0;
    totalSeconds += (seconds || 0);
    totalSeconds += (minutes || 0) * 60;
    totalSeconds += (hours || 0) * 3600;
    totalSeconds += (days || 0) * 86400;
    if (totalSeconds == 0) totalSeconds = 3600;
    const duration = withPadding(moment.duration(totalSeconds, 'seconds'));
    await run('increaseTime', { seconds: totalSeconds });
    logger.success(`Moved the node clock forward by ${duration}`)
  });

task('deploy-test-tokens', 'Deploys test tokens and Uniswap markets for them')
  .addParam('file', 'Path to JSON file with the array of tokens')
  .setAction(async ({ file }) => {
    const logger = Logger(undefined, 'deploy-test-tokens');
    if (!fs.existsSync(file)) {
      throw new Error(`Invalid path given for file: ${file}`);
    }
    const tokens = require(file);
    if (!Array.isArray(tokens)) {
      throw new Error('Tokens file must be a JSON array of token data.');
    }
    const addresses = [];
    for (let token of tokens) {
      const { marketcap, name, symbol, price } = token;
      if (!marketcap || !name || !symbol || !price) {
        throw new Error(`Token JSON must include: marketcap, name, symbol, price`);
      }
      const erc20 = await run('deploy-test-token-and-market', { logger, name, symbol });
      addresses.push(erc20.address);
      const totalSupply = await erc20.totalSupply();
      let amountWeth = toBN(marketcap);
      // let liquidity = marketcap / price;
      if (totalSupply.eq(0)) {
        amountWeth = amountWeth.divn(10);
      }
      let amountToken = amountWeth.divn(price);
      await run('add-liquidity', {
        logger,
        symbol,
        amountToken: toHex(amountToken.mul(oneToken)),
        amountWeth: toHex(amountWeth.mul(oneToken))
      });
    }
    await run('update-prices', { logger, tokens: addresses });
  });

task('create-category', 'Create a test category on the pool controller')
  .addParam('file', 'Path to JSON file with category metadata')
  .setAction(async ({ file }) => {
    const chainID = await getChainId();
    const [signer] = await ethers.getSigners();
    const logger = Logger(undefined, 'create-category');
    if (!fs.existsSync(file)) {
      throw new Error(`Invalid path given for file: ${file}`);
    }
    const metadata = require(file);
    const { name, symbol, description, tokens } = metadata;
    if (!name || !symbol || !description) {
      throw new Error('Category metadata must include name, symbol and description');
    }
    const controller = await ethers.getContract('controller', signer);
    const { sha3Hash } = await uploadFile({ name, symbol, description });
    const { events } = await controller.createCategory(sha3Hash, { gasLimit: 250000 }).then(tx => tx.wait());
    const { args: { categoryID } } = events.filter(e => e.event == 'CategoryAdded')[0];
    logger.success(`Created category with ID ${categoryID}`);
    if (tokens) {
      logger.info('Found tokens in metadata file.');
      if (!Array.isArray(tokens)) {
        throw new Error(`'tokens' field must be an array`);
      }
      const tokensAreAddresses = tokens.filter(t => isAddress(t)).length == tokens.length;
      const isTestnet = chainID == 4 || chainID == 31337;
      if (tokensAreAddresses) {
        logger.info('Adding tokens to category...');
        await controller.addTokens(categoryID, tokens, { gasLimit: 1500000 }).then(r => r.wait());
        logger.success(`Added ${tokens.length} tokens to category ${categoryID}`);
      } else {
        if (!isTestnet) {
          throw new Error(`'tokens' field in category metadata must be an array of addresses on non-test networks`);
        }
        const addresses = [];
        for (let token of tokens) {
          const erc20 = await deployments.getOrNull(token.toLowerCase());
          if (!erc20) {
            throw new Error(`Deployment not found for ${token.toLowerCase()} - try running deploy --tags Mock or providing the token addresses`);
          }
          addresses.push(erc20.address);
        }
        logger.info('Adding tokens to category...');
        await controller.addTokens(categoryID, addresses, { gasLimit: 1500000 }).then(r => r.wait());
        logger.success(`Added ${tokens.length} tokens to category ${categoryID}`);
      }
    }
  });

task('sort-category', `Sorts a category's tokens by market cap`)
  .addParam('category', 'Category ID for the pool')
  .setAction(async ({ category }) => {
    const logger = Logger(undefined, 'sort-category');
    const [signer] = await ethers.getSigners();
    const controller = await ethers.getContract('controller', signer);
    logger.info('Getting category tokens and market caps...');
    const tokens = await controller.getCategoryTokens(category);
    const marketcaps = await controller.computeAverageMarketCaps(tokens);
    const items = [];
    for (let i = 0; i < tokens.length; i++) {
      items.push({ token: tokens[i], marketcap: marketcaps[i] });
    }
    const sortArr = (arr) => arr.sort((a, b) => {
      if (a.marketcap.lt(b.marketcap)) return 1;
      if (a.marketcap.gt(b.marketcap)) return -1;
      return 0;
    });
    logger.info('Submitting sorted category tokens...');
    const sortedTokens = sortArr(items);
    await controller.orderCategoryTokensByMarketCap(
      category,
      sortedTokens.map(t => t.token)
    ).then(tx => tx.wait());
    logger.success('Sorted category tokens!');
  });  

task('deploy-index', 'Deploys an index pool for a category')
  .addParam('category', 'Category ID for the index pool')
  .addParam('size', 'Number of tokens for the index pool')
  .addParam('value', 'WETH value for the initial index balance', 10, types.int)
  .addParam('name', 'Index pool name')
  .addParam('symbol', 'Index pool symbol')
  .setAction(async ({ category, size, value, name, symbol }) => {
    const logger = Logger(undefined, 'deploy-index');
    logger.info(`Deploying index pool initializer...`);
    const [signer] = await ethers.getSigners();
    const controller = await ethers.getContract('controller', signer);
    const tokens = await controller.getCategoryTokens(category);
    if (tokens.length < size) {
      throw new Error(`Category does not have enough tokens for an index with size ${size}`);
    }
    const { events } = await controller.prepareIndexPool(
      category,
      size,
      toHex(toBN(value).mul(oneToken)),
      name,
      symbol,
      { gasLimit: 1500000 }
    ).then(r => r.wait());

    const { args: { pool, initializer } } = events.filter(e => e.event == 'NewPoolInitializer')[0];
    logger.info(`Deployed index pool ${name} (${symbol})`);
    logger.info(`Index Pool: ${pool}`);
    logger.info(`Pool Initializer: ${initializer}`);
    logger.info(`Target WETH value: ${value}`);
  });

task('print-pool', 'Print pool data')
  .addParam('pool', 'Pool address')
  .setAction(async ({ pool }) => {
    const controller = await ethers.getContract('controller');
    const iPool = await ethers.getContractAt('IPool', pool);
    const isPublic = await iPool.isPublicSwap();
    const swapFee = await iPool.getSwapFee();
    const name = await iPool.name();
    const poolSymbol = await iPool.symbol();
    const table = new Table();
    
    table.push({ [chalk.blue('Name')]: chalk.blue(name) });
    table.push({ 'Address': chalk.cyan(pool) });
    table.push({ Symbol: poolSymbol });
    table.push({ 'Swap Fee': chalk.green(`${formatEther(swapFee) * 100}%`) });
    table.push({ 'Initialized': chalk[isPublic ? 'green' : 'red'](isPublic) });
    if (isPublic) {
      const totalSupply = await iPool.totalSupply();
      table.push({ 'Total Supply': chalk.green(formatEther((totalSupply))) });
      const seller = await controller.computeSellerAddress(pool);
      table.push({ 'Unbound Token Seller': chalk.cyan(seller) });
    } else {
      const initializer = await controller.computeInitializerAddress(pool);
      const poolInitializer = await ethers.getContractAt('PoolInitializer', initializer);
      table.push({ 'Pool Initializer': chalk.cyan(initializer) });
      const tokens = await poolInitializer.getDesiredTokens();
      const amounts = await poolInitializer.getDesiredAmounts(tokens);
      
      const desiredTokens = (await Promise.all(tokens.map(async (token, i) => {
        const amount = amounts[i];
        console.log(amount)
        if (amount.eq(0)) return;
        const erc20 = await ethers.getContractAt('MockERC20', token);
        const symbol = await erc20.symbol();
        return {
          symbol,
          amount: formatEther(amount)
        }
      }))).filter(x => x);
      const isReady = desiredTokens.length == 0;
      table.push({ 'Initializer Ready': chalk[isReady ? 'green' : 'red'](isReady) });
      if (!isReady) {
        table.push({
          [chalk.blue('Desired Token')]: chalk.blue('Desired Amount')
        });
        for (let desiredtoken of desiredTokens) {
          const { symbol, amount } = desiredtoken;
          table.push([
            chalk.cyan(symbol), chalk.green(amount)
          ]);
        }
      } 
      table.push()
    }
    console.log(table.toString());
  });

task('mint-test-tokens', 'Mint test tokens')
  .addOptionalParam('file', 'Path to JSON file with list of tokens')
  .addOptionalParam('token', 'Token address or symbol')
  .addOptionalParam('amount', 'Amount of tokens to mint. Defaults to 1% of supply.')
  .addOptionalParam('account', 'Account to mint tokens for. Defaults to first account in wallet.')
  .setAction(async ({ file, token: symbolOrAddress, amount, account }) => {
    const chainID = await getChainId();
    if (chainID != 31337 && chainID != 4) {
      throw new Error(`Must be on testnet to fast-forward`);
    }
    const logger = Logger(undefined, 'mint-test-tokens');
    logger.info(`Deploying index pool initializer...`);
    const [signer] = await ethers.getSigners();
    if (!account) account = await signer.getAddress();
    if (!file || !symbolOrAddress) {
      throw new Error('Must either provide a json file or a token');
    }
    const getAmount = async (erc20) => {
      if (amount) return nTokensHex(amount);
      return (await erc20.totalSupply()).div(100);
    }
    if (file) {
      if (!fs.existsSync(file)) {
        throw new Error(`Invalid path given for file: ${file}`);
      }
      let tokens = require(file);
      if (!Array.isArray(tokens)) {
        if (Object.keys(tokens).includes('tokens')) {
          tokens = tokens.tokens;
        }
        if (!Array.isArray(tokens)) {
          throw new Error(`JSON file provided is not an array, and the root object does not have a 'tokens' array field`);
        }
      }
      for (let token of tokens) {
        if (typeof token == 'object') {
          if (Object.keys(token).includes('symbol')) {
            token = token.symbol;
          } else if (Object.keys(token).includes('address')) {
            token = token.address;
          } else {
            console.log(token);
            throw new Error(`Token object had no symbol or address field`);
          }
        }
        if (!isAddress(token)) {
          const deployment = await deployments.getOrNull(token.toLowerCase());
          if (!deployment) {
            throw new Error(`Token not found for ${token}`);
          }
          token = deployment.address;
        }
        const erc20 = await ethers.getContractAt('MockERC20', token, signer);
        await erc20.getFreeTokens(account, await getAmount(erc20));
      }
    } else {
      if (!isAddress(symbolOrAddress)) {
        const deployment = await deployments.getOrNull(symbolOrAddress.toLowerCase());
        if (!deployment) {
          throw new Error(`Token not found for ${token}`);
        }
        symbolOrAddress = deployment.address;
      }
      const erc20 = await ethers.getContractAt('MockERC20', symbolOrAddress, signer);
      await erc20.getFreeTokens(account, await getAmount(erc20));
    }

  });

module.exports = {
  abiExporter: {
    path: './abi',
    only: [
      'MarketCapSqrtController',
      'PoolFactory',
      'PoolInitializer',
      'UnboundTokenSeller',
      'UniSwapV2PriceOracle',
      'DelegateCallProxyManager',
      'IPool'
    ],
    clear: true,
  },
  etherscan: {
    url: "https://api.etherscan.io/api",
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  external: {
    artifacts: [
      "node_modules/@uniswap/v2-core/build",
      "node_modules/@uniswap/v2-periphery/build"
    ],
  },
  namedAccounts: {
    deployer: {
      default: 0
    },
  },
  networks: {
    buidlerevm: {
      live: false,
      saveDeployment: true,
      tags: ['Core']
    },
    local: {
      url: url.format({
        protocol: "http:",
        port: 8545,
        hostname: "localhost",
      }),
      saveDeployment: true,
      tags: ['Core']
    },
    rinkeby: {
      url: new InfuraProvider("rinkeby", process.env.INFURA_PROJECT_ID).connection.url,
      accounts: [keys.rinkeby],
      chainId: 4
    },
    coverage: {
      url: url.format({
        protocol: "http:",
        port: 8555,
        hostname: "localhost",
      }),
    }
  },
  paths: {
    sources: path.join(__dirname, 'contracts'),
    tests: path.join(__dirname, 'test'),
    cache: path.join(__dirname, 'cache'),
    artifacts: path.join(__dirname, 'artifacts'),
    deploy: path.join(__dirname, "deploy"),
    deployments: path.join(__dirname, "deployments")
  },
  solc: {
    version: "0.6.8",
    optimizer: {
      enabled: true,
      runs: 200
    }
  },
};
