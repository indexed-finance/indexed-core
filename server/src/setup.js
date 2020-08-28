require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Web3 = require('web3');

const Uniswap = require('../../lib/uniswap');
const MarketOracle = require('../../lib/market-oracle');
const Temporal = require('../../lib/util/temporal');
const PoolController = require('../../lib/pool-controller');

async function setup() {
  const {
    temporal_username,
    temporal_password,
    market_oracle,
    uniswap_factory,
    uniswap_router,
    weth,
    stablecoin,
    pool_controller,
    PORT
  } = process.env;
  const temporal = new Temporal();
  await temporal.login(temporal_username, temporal_password);
  const web3 = new Web3('http://localhost:8545');
  const [from] = await web3.eth.getAccounts();
  if (market_oracle && uniswap_factory && uniswap_router && weth && stablecoin && pool_controller) {
    console.log('Found contracts in environment.');
    // Check if the contracts still exist
    const exists = await web3.eth.getCode(market_oracle);
    if (exists && exists != '0x') {
      const contracts = {
        weth,
        stablecoin,
        uniswapFactory: uniswap_factory,
        uniswapRouter: uniswap_router
      };
      return {
        web3,
        temporal,
        from,
        uniswap: new Uniswap(web3, contracts, from),
        oracle: new MarketOracle(web3, market_oracle, from),
        poolController: new PoolController(web3, pool_controller, from),
        PORT
      };
    }
    console.log('Contracts do not exist, initiating setup...');
  }
  console.log('Deploying contracts...')
  const uniswap = await Uniswap.deploy(web3, from);
  console.log(`Deployed UniSwap`);
  const oracle = await MarketOracle.deploy(
    web3,
    uniswap.uniswapFactory.options.address,
    uniswap.stablecoin.options.address,
    from
  );
  console.log(`Deployed Market Oracle`);
  const poolController = await PoolController.deploy(web3, from, oracle.oracle.options.address);
  console.log(`Deployed Pool Controller`);
  const env_path = path.join(__dirname, '.env');
  const env_file_lines = fs.readFileSync(env_path, 'utf8').split('\n');
  env_file_lines.push(`market_oracle=${oracle.oracle.options.address}`)
  env_file_lines.push(`uniswap_factory=${uniswap.uniswapFactory.options.address}`)
  env_file_lines.push(`uniswap_router=${uniswap.uniswapRouter.options.address}`)
  env_file_lines.push(`pool_controller=${poolController.poolController.options.address}`)
  env_file_lines.push(`weth=${uniswap.weth.options.address}`)
  env_file_lines.push(`stablecoin=${uniswap.stablecoin.options.address}`)
  fs.writeFileSync(env_path, env_file_lines.join('\n'));
  return { web3, temporal, from, uniswap, oracle, poolController, PORT };
}

module.exports = setup;