const bre = require("@nomiclabs/buidler");

const { deployments, ethers } = bre;

describe('MarketCapSortedTokenCategories.sol', () => {
  let testContract;

  before(async () => {
    await deployments.fixture();
    const controller = await ethers.getContract('controller');
    const CategoriesTest = await ethers.getContractFactory('CategoriesTest');
    testContract = await CategoriesTest.deploy(
      (await ethers.getContract("weth")).address,
      (await ethers.getContract('uniswapFactory')).address,
      (await ethers.getContract('uniswapRouter')).address,
      controller.address
    );
    await controller.setOwner(testContract.address);
  });
  
  it('init', async () => {
    await testContract.init();
    for (let i = 0; i < 5; i++) await testContract.init2();
  });
  
  it('createCategory', async () => {
    await testContract.test_createCategory();
  });
  
  it('addToken', async () => {
    await testContract.test_addToken();
  });
  
  it('addTokens', async () => {
    await testContract.test_addTokens();
    await bre.run('increaseTime', { days: 2 });
  });
  
  it('orderCategoryTokensByMarketCap', async () => {
    await testContract.test_orderCategoryTokensByMarketCap();
  });
  
  it('getTopCategoryTokens', async () => {
    await testContract.test_getTopCategoryTokens();
  });
  
  it('computeAverageMarketCaps', async () => {
    await testContract.test_computeAverageMarketCaps();
  });
  
  it('returnOwnership', async () => {
    await testContract.returnOwnership();
  });
});