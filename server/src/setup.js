require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Web3 = require('web3');

const Uniswap = require('../../lib/uniswap');
const MarketOracle = require('../../lib/market-oracle');
const Temporal = require('../../lib/util/temporal');
const PoolController = require('../../lib/pool-controller');
const { deployERC20 } = require('../../lib/erc20');
const { deploy } = require('../../lib/util/contracts');

const {
  abi: UniswapV2FactoryABI,
  bytecode: UniswapV2FactoryBytecode,
} = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const {
  abi: UniswapV2RouterABI,
  bytecode: UniswapV2RouterBytecode,
} = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");
const {
  abi: MockDeployerABI,
  bytecode: MockDeployerBytecode
} = require('../../artifacts/MockTokenMarketDeployer.json');


const contractExists = async (web3, address) => {
  if (!address) return false;
  const exists = await web3.eth.getCode(address);
  return exists && exists != '0x';
}

async function getUniswapAddresses(web3, from) {
  let { uniswap_factory, uniswap_router, weth, mock_deployer } = {
    uniswap_factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    uniswap_router:'0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    ...process.env
  };
  const uni_exists = await contractExists(web3, uniswap_factory);
  const weth_exists = await contractExists(web3, weth);
  const deployer_exists = await contractExists(web3, mock_deployer);
  if (!weth_exists) {
    console.log('Deploying weth')
    const _weth = await deployERC20(web3, from, 'WETH V9', 'WETH');
    weth = _weth.options.address;
  }
  if (!uni_exists) {
    console.log('Deploying uniswap factory')
    const uniswapFactory = await deploy(
      web3,
      from,
      UniswapV2FactoryABI,
      UniswapV2FactoryBytecode,
      [from]
    );
    uniswap_factory = uniswapFactory.options.address;
    console.log('Deploying uniswap router')
    const uniswapRouter = await deploy(
      web3,
      from,
      UniswapV2RouterABI,
      UniswapV2RouterBytecode,
      [uniswapFactory.options.address, weth]
    );
    uniswap_router = uniswapRouter.options.address;
  }
  if (!deployer_exists) {
    const mockDeployer = await deploy(
      web3,
      from,
      MockDeployerABI,
      MockDeployerBytecode,
      [weth, uniswap_factory, uniswap_router]
    );
    mock_deployer = mockDeployer.options.address;
  }
  return {
    uniswap_factory,
    uniswap_router,
    mock_deployer,
    weth
  };
}

async function getTemporal() {
  const { temporal_username, temporal_password } = process.env;
  const temporal = new Temporal();
  await temporal.login(temporal_username, temporal_password);
  return temporal;
}

async function setup() {
  console.log('Getting contracts...')
  let {
    market_oracle,
    pool_controller,
    PORT,
    privateKey,
    PROJECT_ID
  } = process.env;
  const temporal = await getTemporal();
  const web3 = new Web3(PROJECT_ID ? `https://rinkeby.infura.io/v3/${PROJECT_ID}` : 'http://localhost:8545');
  let from;
  if (PROJECT_ID) {
    const account = web3.eth.accounts.privateKeyToAccount(privateKey);
    web3.eth.accounts.wallet.add(account);
    web3.eth.defaultAccount = account.address;
    from = account.address
    console.log(web3.eth.defaultAccount)
  } else {
    [from] = await web3.eth.getAccounts();
  }
  const { uniswap_factory, uniswap_router, weth, mock_deployer } = await getUniswapAddresses(web3, from);
  const contracts = {
    weth,
    uniswapFactory: uniswap_factory,
    uniswapRouter: uniswap_router,
    mockDeployer: mock_deployer
  };
  const uniswap = new Uniswap(web3, contracts, from);
  let oracle, poolController;

  if (await contractExists(web3, market_oracle)) {
    oracle = new MarketOracle(web3, market_oracle, from);
  } else {
    console.log('Deploying market oracle')
    oracle = await MarketOracle.deploy(
      web3,
      uniswap.uniswapFactory.options.address,
      uniswap.weth.options.address,
      from
    );
    market_oracle = oracle.oracle.options.address;
  }

  if (await contractExists(web3, pool_controller)) {
    poolController = new PoolController(web3, pool_controller, market_oracle, from)
  } else {
    console.log('Deploying pool controller')
    poolController = await PoolController.deploy(web3, from, oracle.oracle.options.address);
    pool_controller = poolController.poolController.options.address;
  }
  console.log('Got contracts!')

  const env_path = path.join(__dirname, '.env');
  const env_file_lines = fs.readFileSync(env_path, 'utf8').split('\n').slice(0, 5);
  env_file_lines.push(`market_oracle=${market_oracle}`)
  env_file_lines.push(`uniswap_factory=${uniswap_factory}`)
  env_file_lines.push(`uniswap_router=${uniswap_router}`)
  env_file_lines.push(`pool_controller=${pool_controller}`)
  env_file_lines.push(`mock_deployer=${mock_deployer}`)
  env_file_lines.push(`weth=${weth}`)
  fs.writeFileSync(env_path, env_file_lines.join('\n'));

  return { web3, temporal, from, uniswap, oracle, poolController, PORT };
}

module.exports = setup;