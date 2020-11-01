const bre = require("@nomiclabs/buidler");
const { fastForward } = require("./utils");

const { deployments, ethers } = bre;

describe('UnboundTokenSeller.sol', () => {
  let testContract;

  before(async () => {
    await deployments.fixture('Core');
    const SellerTest = await ethers.getContractFactory('SellerTest');
    testContract = await SellerTest.deploy(
      (await ethers.getContract("weth")).address,
      (await ethers.getContract('uniswapFactory')).address,
      (await ethers.getContract('uniswapRouter')).address,
      (await ethers.getContract('uniswapOracle')).address
    );
  });

  it('initialize()', async () => {
    await testContract.test_initialize();
  });
  
  it('init', async () => {
    await testContract.init();
    for (let i = 0; i < 5; i++) await testContract.init2();
    await testContract.init3();
    await fastForward(7200)
  });

  it('setPremiumPercent()', async () => {
    await testContract.test_setPremiumPercent();
  });

  it('handleUnbindToken()', async () => {
    await testContract.test_handleUnbindToken();
  });

  it('calcInGivenOut()', async () => {
    await testContract.test_calcInGivenOut();
  });

  it('calcOutGivenIn()', async () => {
    await testContract.test_calcOutGivenIn();
  });

  it('swapExactTokensForTokens()', async () => {
    await testContract.test_swapExactTokensForTokens();
  });

  it('swapTokensForExactTokens()', async () => {
    await testContract.test_swapTokensForExactTokens();
  });

  it('executeSwapTokensForExactTokens()', async () => {
    await testContract.callStatic.test_executeSwapTokensForExactTokens();
  });

  it('executeSwapExactTokensForTokens()', async () => {
    await testContract.callStatic.test_executeSwapExactTokensForTokens();
  });
});