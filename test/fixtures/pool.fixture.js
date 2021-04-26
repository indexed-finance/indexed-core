const Decimal = require('decimal.js');
const PoolHelper = require("../lib/pool-helper");
const { toWei, fromWei, getTransactionTimestamp, verifyRejection, getFakerContract } = require("../utils");
const { wrappedTokensFixture } = require("./tokens.fixture");
const { uniswapFixture } = require('./uniswap.fixture');

const swapFee = 0.02;

const poolFixture = async ({ getNamedAccounts, ethers, tokens: _wrappedTokens }) => {
  const { deployer } = await getNamedAccounts();
  const feeRecipient = `0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF`;

  // Deploy contracts
  const IPoolFactory = await ethers.getContractFactory("IndexPool");
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
  await indexPool.configure(deployer, "Test Pool", "TPI", feeRecipient);
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
    nonOwnerFaker,
    feeRecipient
  };
};

async function poolFixtureWithDefaultTokens(_bre) {
  const { tokens } = await deployments.createFixture(wrappedTokensFixture)();
  return poolFixture({ ..._bre, tokens });
}


async function poolFixtureWithMaxTokens(_bre) {
  const { deployments } = _bre;
  const uniswapFixtures = await deployments.createFixture(uniswapFixture)();
  // const wrappedTokens = testTokens.map(({ symbol, name, price }, i) => ({ symbol, name, initialPrice: price }));
  const tokens = [];
  for (let i = 0; i < 10; i++) {
    const name = `TEST TOKEN ${i}`;
    const symbol = `TT${i}`;
    const initialPrice = i + 2;
    const tokenAndPairData = await uniswapFixtures.deployTokenAndMarket(name, symbol);
    tokens.push({ name, symbol, initialPrice, ...tokenAndPairData });
  }
  return poolFixture({ ..._bre, tokens });
}

module.exports = { poolFixture: poolFixtureWithDefaultTokens, poolFixtureWithMaxTokens };