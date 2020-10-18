const bre = require('@nomiclabs/buidler');
const { toBN, toHex } = require('../../lib/util/bn');
const { oneToken } = require('./tokens');
const { ethers, getNamedAccounts, getChainId } = bre;

async function addLiquidity(tokenAddress, priceInWeth, liquidity) {
  const chainID = await getChainId();

  let uniswapRouter;
  if (chainID == 4) {
    uniswapRouter = await ethers.getContractAt('UniswapV2Router02', '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D');
  } else {
    uniswapRouter = await ethers.getContract('uniswapRouter');
  }
  const { deployer } = await getNamedAccounts();

  const token = await ethers.getContractAt('MockERC20', tokenAddress);
  const weth = await ethers.getContract('weth');

  const tokenAmount = toHex(toBN(liquidity).mul(oneToken));
  const wethAmount = toHex(toBN(liquidity).mul(oneToken).muln(priceInWeth));

  await token.getFreeTokens(deployer, tokenAmount).then(r => r.wait && r.wait());
  await token.approve(uniswapRouter.address, tokenAmount).then(r => r.wait && r.wait());

  await weth.getFreeTokens(deployer, wethAmount).then(r => r.wait && r.wait());
  await weth.approve(uniswapRouter.address, wethAmount).then(r => r.wait && r.wait());

  const timestamp = await bre.run('getTimestamp');

  await uniswapRouter.addLiquidity(
    token.address,
    weth.address,
    tokenAmount,
    wethAmount,
    tokenAmount,
    wethAmount,
    deployer,
    timestamp + 1000,
    { gasLimit: 250000 }
  ).then(r => r.wait && r.wait());
}

async function deployTokenMarket(tokenAddress) {
  const chainID = await getChainId();
  
  let uniswapFactory;
  if (chainID == 4) {
    uniswapFactory = await ethers.getContractAt('UniswapV2Factory', '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f');
  } else {
    uniswapFactory = await ethers.getContract('uniswapFactory');
  }
  const weth = await ethers.getContract('weth');
  const receipt = await uniswapFactory.createPair(
    tokenAddress,
    weth.address,
    { gasLimit: 2500000 }
  );

  const { events } = await receipt.wait();
  const { args: { pair } } = events.filter(e => e.event == 'PairCreated')[0];
  return pair;
}

module.exports = {
  addLiquidity,
  deployTokenMarket
}