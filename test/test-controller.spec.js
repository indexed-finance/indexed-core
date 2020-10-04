const bre = require("@nomiclabs/buidler");

const { deployments, ethers } = bre;

describe('MarketCapSqrtController.sol', () => {
  let testContract;

  before(async () => {
    await deployments.fixture();
    const controller = await ethers.getContract('controller');
    const ControllerTest = await ethers.getContractFactory('ControllerTest');
    testContract = await ControllerTest.deploy(
      (await ethers.getContract("weth")).address,
      (await ethers.getContract('uniswapFactory')).address,
      (await ethers.getContract('uniswapRouter')).address,
      controller.address,
      (await ethers.getContract('HourlyTWAPUniswapV2Oracle')).address
    );
    await controller.setOwner(testContract.address);
  });
  
  it('init', async () => {
    await testContract.init();
    for (let i = 0; i < 5; i++) await testContract.init2();
    await testContract.init3();
    await bre.run('increaseTime', { days: 2 });
    await testContract.init4();
    await bre.run('increaseTime', { hours: 1 });
  });

  it('getInitialTokensAndBalances', async () => {
    await testContract.test_getInitialTokensAndBalances();
  });
  
  it('prepareIndexPool', async () => {
    await testContract.test_prepareIndexPool();
  });

  it('finishPreparedIndexPool', async () => {
    await testContract.test_finishPreparedIndexPool();
  });

  it('setMaxPoolTokens', async () => {
    await testContract.test_setMaxPoolTokens();
  });
  
  it('setDefaultSellerPremium', async () => {
    await testContract.test_setDefaultSellerPremium();
  });
  
  it('updateSellerPremiumToDefault', async () => {
    await testContract.test_updateSellerPremiumToDefault();
  });
  
  it('setSwapFee', async () => {
    await testContract.test_setSwapFee();
  });
});