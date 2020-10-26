const chai = require("chai");
const { BigNumber } = require("ethers");
chai.use(require('chai-as-promised'));
const {expect} = chai;

const borrowAmount = BigNumber.from(100).mul(BigNumber.from(10).pow(18));
const denorm = BigNumber.from(12).mul(BigNumber.from(10).pow(18));

describe('Flash Loans', async () => {
  let mockBorrower, pool, from;
  let unboundToken, tokenA, tokenB;

  before(async () => {
    [from] = await web3.eth.getAccounts();
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    unboundToken = await MockERC20.deploy('Unbound', 'UB');
    tokenA = await MockERC20.deploy('TokenA', 'A');
    tokenB = await MockERC20.deploy('TokenB', 'B');
    const IPool = await ethers.getContractFactory('IPool');
    pool = await IPool.deploy();
    await pool.configure(
      from,
      "Test Pool",
      "TPI"
    );
    await tokenA.getFreeTokens(from, borrowAmount);
    await tokenB.getFreeTokens(from, borrowAmount);

    await tokenA.approve(pool.address, borrowAmount);
    await tokenB.approve(pool.address, borrowAmount);

    await pool.initialize(
      [tokenA.address, tokenB.address],
      [borrowAmount, borrowAmount],
      [denorm, denorm],
      from,
      `0x${'00'.repeat(20)}`
    );
    const MockBorrower = await ethers.getContractFactory('MockBorrower');
    mockBorrower = await MockBorrower.deploy();
  });

  it('Reverts when requested token is not bound', async () => {
    await expect(
      pool.flashBorrow(mockBorrower.address, unboundToken.address, borrowAmount, '0x')
    ).to.be.rejectedWith(/ERR_NOT_BOUND/g);
  });

  it('Reverts when requested amount exceeds balance', async () => {
    await expect(
      pool.flashBorrow(mockBorrower.address, tokenA.address, borrowAmount.add(1), '0x')
    ).to.be.rejectedWith(/ERR_INSUFFICIENT_BAL/g);
  });

  it('Reverts when the fee is not paid', async () => {
    const testScenarioBytes = web3.eth.abi.encodeParameter('uint256', '1');
    await expect(
      pool.flashBorrow(mockBorrower.address, tokenA.address, borrowAmount, testScenarioBytes)
    ).to.be.rejectedWith(/ERR_INSUFFICIENT_PAYMENT/g);
  });

  it('Reverts if reentry is attempted', async () => {
    const testScenarioBytes = web3.eth.abi.encodeParameter('uint256', '2');
    await expect(
      pool.flashBorrow(mockBorrower.address, tokenA.address, borrowAmount, testScenarioBytes)
    ).to.be.rejectedWith(/ERR_REENTRY/g);
  });

  it('Succeeds when the full amount due is paid, and sets the correct balance in the token record', async () => {
    const testScenarioBytes = web3.eth.abi.encodeParameter('uint256', '0');
    const amountDue = borrowAmount.mul(1025).div(1000);
    await pool.flashBorrow(mockBorrower.address, tokenA.address, borrowAmount, testScenarioBytes);
    const newBalance = await pool.getBalance(tokenA.address);
    expect(newBalance.eq(amountDue)).to.be.true;
  });
});