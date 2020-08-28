const Web3 = require('web3');
const rp = require('request-promise');
const { expect } = require('chai');

const { hashJSON } = require('../../lib/util/ipfs');
const { deployERC20 } = require('../../lib/erc20');
const Uniswap = require('../../lib/uniswap');

const url = 'http://localhost:3030/';

/* This should be run after the server has been started with a fresh ganache node. */
describe('Server', () => {
  let web3, from;
  let contracts, uniswap;
  let wbtc, wltc, wtc;
  before(async () => {
    web3 = new Web3('http://localhost:8545');
    [from] = await web3.eth.getAccounts();
    contracts = await rp.get(`${url}contracts`, { json: true });
    uniswap = new Uniswap(web3, contracts, from);
    console.log(contracts)
  });

  it('Creates a new token category', async () => {
    const name = 'Wrapped Tokens';
    const symbol = 'WTI';
    const description = 'Tokens which wrap other assets.';
    const { json, sha3Hash, ipfsHash } = hashJSON({ name, symbol, description });
    const { metadata, categoryID } = await rp.post(`${url}createCategory`, {
      body: {
        name,
        symbol,
        description
      },
      json: true
    });
    expect(categoryID).to.eq('1');
    expect(metadata.metadata).to.equal(json);
    expect(metadata.metadataHash).to.equal(sha3Hash);
    expect(metadata.ipfsHash).to.equal(ipfsHash);
  });

  it('Deploys some tokens', async () => {
    wbtc = await deployERC20(web3, from, 'Wrapped Bitcoin', 'WBTC');
    wltc = await deployERC20(web3, from, 'Wrapped Litecoin', 'WLTC');
    wtc = await deployERC20(web3, from, 'Wrapped Token Coin', 'WTC');
  });

  it('Creates markets for the tokens', async () => {
    await uniswap.deployMarket(wbtc.options.address);
    await uniswap.deployMarket(wltc.options.address);
    await uniswap.deployMarket(wtc.options.address);
  });

  it('Adds liquidity to the markets', async () => {
    await uniswap.addMarketLiquidity(wbtc.options.address, 12000, 1000);
    await uniswap.addMarketLiquidity(wltc.options.address, 8000, 1500);
    await uniswap.addMarketLiquidity(wtc.options.address, 4000, 3000);
  });

  it('Adds tokens to the category', async () => {
    await rp.post(`${url}addToken`, {
      body: {
        categoryID: 1,
        token: wbtc.options.address
      },
      json: true
    });
    await rp.post(`${url}addToken`, {
      body: {
        categoryID: 1,
        token: wltc.options.address
      },
      json: true
    });
    await rp.post(`${url}addToken`, {
      body: {
        categoryID: 1,
        token: wtc.options.address
      },
      json: true
    });
  });
});