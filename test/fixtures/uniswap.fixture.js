const LiquidityManager = require('../lib/liquidity-manager');

let _i = 1;

const toAddress = (token) => typeof token == 'string' ? token : token.address;

const uniswapFixture = async ({ deployments, ethers }) => {
  await deployments.fixture('None');
  const [ signer ] = await ethers.getSigners();

  const deploy = async (name, ...args) => {
    return (await ethers.getContractFactory(name, signer)).deploy(...args);
  }

  const weth = await deploy('MockERC20', "Wrapped Ether V9", "WETH9");
  const uniswapFactory = await deploy("UniswapV2Factory", `0x${_i.toString().repeat(40).slice(0, 40)}`);
  const uniswapRouter = await deploy('UniswapV2Router02', uniswapFactory.address, weth.address);
  const uniswapOracle = await deploy("IndexedUniswapV2Oracle", uniswapFactory.address, weth.address);

  const liquidityAdder = await deploy('LiquidityAdder', weth.address, uniswapFactory.address, uniswapRouter.address);

  const liquidityManager = new LiquidityManager(liquidityAdder, uniswapOracle);

  const addLiquidity = (erc20, amountToken, amountWeth) => liquidityManager.addLiquidity(erc20, amountToken, amountWeth);
  const updatePrice = (token) => liquidityManager.updatePrice(token);
  const updatePrices = (tokens) => liquidityManager.updatePrices(tokens);
  const getTokenValue = (token, amountToken) => liquidityManager.getTokenValue(token, amountToken);
  const getEthValue = (token, amountWeth) => liquidityManager.getEthValue(token, amountWeth);
  const getAverageTokenPrice = (token) => liquidityManager.getAverageTokenPrice(token);
  const getAverageEthPrice = (token) => liquidityManager.getAverageEthPrice(token);

  const deployTokenAndMarket = async (name, symbol) => {
    const erc20 = await deploy('MockERC20', `${name}${_i++}`, symbol);
    const receipt = await uniswapFactory.createPair(erc20.address, weth.address);
    const { events } = await receipt.wait();
    const { args: { pair } } = events.filter(e => e.event == 'PairCreated')[0];
    return {
      token: erc20,
      address: erc20.address,
      pair: await ethers.getContractAt('UniswapV2Pair', pair, signer)
    };
  }
  // expectedPrice1 = encodePrice(token1Amount, wethAmount, +timestamp, expectedPrice1);

  return {
    weth,
    uniswapFactory,
    uniswapRouter,
    deployTokenAndMarket,
    liquidityManager,
    addLiquidity,
    uniswapOracle,
    updatePrice,
    updatePrices,
    getTokenValue,
    getEthValue,
    getAverageTokenPrice,
    getAverageEthPrice
  };
};

module.exports = { uniswapFixture };