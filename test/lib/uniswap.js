const bre = require('@nomiclabs/buidler');
const { nTokensHex } = require('./tokens');
const { ethers, getNamedAccounts } = bre;

async function addLiquidity(tokenAddress, priceInWeth, liquidity) {
  const uniswapRouter = await ethers.getContract('uniswapRouter');
  const { deployer } = await getNamedAccounts();

  const token = await ethers.getContractAt('MockERC20', tokenAddress);
  const weth = await ethers.getContract('weth');

  const tokenAmount = nTokensHex(liquidity);
  const wethAmount = nTokensHex(priceInWeth * liquidity);

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
    timestamp + 1000
  );
}

async function deployTokenMarket(tokenAddress) {
  const uniswapFactory = await ethers.getContract('uniswapFactory');
  const weth = await ethers.getContract('weth');
  const receipt = await uniswapFactory.createPair(
    tokenAddress,
    weth.address
  );

  const { events } = await receipt.wait();
  const { args: { pair } } = events.filter(e => e.event == 'PairCreated')[0];
  return pair;
}

module.exports = {
  addLiquidity,
  deployTokenMarket
}