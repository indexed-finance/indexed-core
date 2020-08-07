const {
  abi: UniswapV2FactoryABI,
  bytecode: UniswapV2FactoryBytecode,
} = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const {
  abi: WETH9ABI,
  bytecode: WETH9Bytecode,
} = require("@uniswap/v2-periphery/build/WETH9.json");
const {
  abi: UniswapV2RouterABI,
  bytecode: UniswapV2RouterBytecode,
} = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");

function deploy(web3, from, abi, bytecode, args = []) {
  return new web3.eth.Contract(abi).deploy({
    data: bytecode,
    arguments: args,
  })
  .send({ from });
}

async function setupUniSwapV2(web3, from) {
  const uniswapFactory = await deploy(web3, from, UniswapV2FactoryABI, UniswapV2FactoryBytecode, [from]);
  const weth = await deploy(web3, from, WETH9ABI, WETH9Bytecode, [from]);
  const uniswapRouter = await deploy(
    web3,
    from,
    UniswapV2RouterABI,
    UniswapV2RouterBytecode,
    [uniswapFactory.options.address, weth.options.address]
  );
  return {
    uniswapFactory,
    uniswapRouter,
    weth
  };
}

module.exports = {
  deploy,
  setupUniSwapV2
};