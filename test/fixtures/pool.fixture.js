const Decimal = require('decimal.js');
const PoolHelper = require("../lib/pool-helper");
const { toWei, fromWei, getTransactionTimestamp, verifyRejection, getFakerContract } = require("../utils");
const { wrappedTokensFixture } = require("./tokens.fixture");

const swapFee = 0.025;

const { getNamedAccounts, ethers } = require('@nomiclabs/buidler')

const poolFixture = async () => {
  const { deployer } = await getNamedAccounts();

  // Set up tokens
  const {tokens: _wrappedTokens} = await wrappedTokensFixture();

  // Deploy contracts
  const IPoolFactory = await ethers.getContractFactory("IPool");
  const MockUnbindTokenHandler = await ethers.getContractFactory('MockUnbindTokenHandler');
  const unbindTokenHandler = await MockUnbindTokenHandler.deploy();
  const indexPool = await IPoolFactory.deploy();

  const wrappedTokens = [..._wrappedTokens.map(t => Object.assign({}, t))];
  for (let i = 0; i < wrappedTokens.length; i++) {
    const token = wrappedTokens[i];
    await token.token.getFreeTokens(deployer, toWei(10000));
    token.totalSupply = 10000;
    token.price = token.initialPrice;
    token.balance = 0;
  }
  const denormWeights = [];
  const balances = [];
  // Set up the weights & balances
  const poolHelper = new PoolHelper(wrappedTokens, swapFee, 0);
  const totalValue = 50;
  for (let i = 0; i < wrappedTokens.length; i++) {
    const token = wrappedTokens[i]
    const { address, symbol } = token;
    const { denorm, price } = poolHelper.records[address];
    const balance = (totalValue * denorm) / price;
    denormWeights.push(toWei(denorm));
    balances.push(toWei(balance));
    poolHelper.records[address].balance = balance;
    // Approve pool to transfer initial balances
    await token.token.approve(indexPool.address, toWei(100000))
  }

  // Initialize pool
  await indexPool.configure(deployer, "Test Pool", "TPI");
  const lastDenormUpdate = await getTransactionTimestamp(indexPool.initialize(
    wrappedTokens.map(t => t.address),
    balances,
    denormWeights,
    deployer,
    unbindTokenHandler.address
  ));

  async function getPoolData() {
    const tokens = await indexPool.getCurrentTokens();
    const denormalizedWeights = await Promise.all(tokens.map(t => indexPool.getDenormalizedWeight(t)));
    const balances = await Promise.all(tokens.map(t => indexPool.getBalance(t)));
    const denormTotal = await indexPool.getTotalDenormalizedWeight();
    const normalizedWeights = denormalizedWeights.map(
      (denorm) => Decimal(
        fromWei(denorm.eq(0) ? denormTotal.div(100) : denorm)
      ).div(fromWei(denormTotal))
    );
    return {
      tokens,
      denormalizedWeights,
      balances,
      normalizedWeights
    };
  }
  
  async function mintAndApprove(tokenAddress, amount) {
    const token = await ethers.getContractAt('MockERC20', tokenAddress);
    await token.getFreeTokens(deployer, amount);
    await token.approve(indexPool.address, amount);
    const amountDec = Decimal(fromWei(amount));
    poolHelper.records[tokenAddress].totalSupply = Decimal(
      poolHelper.records[tokenAddress].totalSupply
    ).add(amountDec);
  }
  
  const verifyRevert = (...args) => verifyRejection(indexPool, ...args);
  
  const callAndSend = async (fnName, ...args) => {
    const output = await indexPool.callStatic[fnName](...args);
    await indexPool[fnName](...args);
    return output;
  }

  const [, signer2] = await ethers.getSigners();
  const faker = getFakerContract(indexPool);
  const nonOwnerFaker = getFakerContract(indexPool, signer2);

  return {
    wrappedTokens,
    indexPool,
    unbindTokenHandler,
    poolHelper,
    getPoolData,
    mintAndApprove,
    from: deployer,
    lastDenormUpdate,
    verifyRevert,
    callAndSend,
    faker,
    nonOwnerFaker
  };
};

module.exports = { poolFixture };