const path = require('path');
const url = require('url');

require('dotenv').config();

const { InfuraProvider } = require('@ethersproject/providers');
const { fromPrivateKey } = require('ethereumjs-wallet');
const { randomBytes } = require('crypto');

const { types, internalTask } = require("@nomiclabs/buidler/config")

usePlugin("@nomiclabs/buidler-web3");
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
  gasReporter: {
    currency: "USD",
    showTimeSpent: true,
    enabled: true,
    currency: "USD",
  },
  namedAccounts: {
    deployer: {
      default: 0
    },
  },
  networks: {
    buidlerevm: {
      live: false,
      saveDeployment: false
    },
    local: {
      url: url.format({
        protocol: "http:",
        port: 8545,
        hostname: "localhost",
      }),
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
