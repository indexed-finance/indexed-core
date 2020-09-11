const app = require('./express');
const setup = require('./setup');
const uploadFile = require('./upload');
const indexNameAndSymbol = require('../../lib/util/index-name');
const fs = require('fs');
const path = require('path');
const { nTokensHex } = require('../../lib/util/bn');
const { deployERC20, getERC20 } = require('../../lib/erc20');
const { toContract, deploy } = require('../../lib/util/contracts');
const {
  abi: PoolABI,
} = require('../../artifacts/BPool.json');

let web3, temporal, from, uniswap, oracle, poolController, PORT;

async function start() {
  console.log('Starting server...');
  ({ web3, temporal, from, uniswap, oracle, poolController, PORT } = await setup());
  // await setupDemoCategory_USD()
  // await deployIndex1()
  await deployIndexFunds();
  return new Promise((resolve) =>
    app.listen(PORT, () => {
      console.log(`Server listening on ${PORT}`);
    })
  );
}

let mockDeployer;

async function deployIndexCategory(category_file) {
  const category = require(category_file);
  const { name, symbol, description, tokens } = category;
  console.log('deploying demo index fund', name);

  const { sha3Hash } = await uploadFile(
    temporal,
    { name, symbol, description }
  );
  console.log('Uploaded category metadata to IPFS');
  const categoryID = await oracle.createCategory(sha3Hash);
  console.log(`Created category ${name} | ID ${categoryID}`);

  for (let token of tokens) {
    const tokenAddress = await uniswap.deployTokenAndMarketWithLiquidity(
      token.name,
      token.symbol,
      token.price,
      token.totalSupply / 2
    );
    await oracle.addTokenToCategory(tokenAddress, categoryID);
    console.log(`Added ${token.name} to ${name} category`);
    await uniswap.addMarketLiquidity(tokenAddress, token.price, token.totalSupply / 2);
    token.address = tokenAddress;
  }
  fs.writeFileSync(category_file, JSON.stringify(category, null, 2));
  
  console .log('Sorting category #', categoryID);
  await oracle.sortCategoryTokens(categoryID);
}

async function deployIndexFunds() {
  const id = await oracle.oracle.methods.categoryIndex().call();

  if (id == 1) {
    await deployIndexCategory(path.join(__dirname, 'demo-data', 'usd-category.json'));
    const usdIndex = await poolController.deployPool(
      1,
      3,
      'USD Index 3',
      'USDI3',
      1
    );
    console.log('Deployed index fund for USD category');
    const usdPrice = await oracle.getIndexTokenPrice(uniswap.mockDeployer, usdIndex);
    await uniswap.deployPoolMarketWithLiquidity(
      usdIndex.options.address,
      usdPrice,
      20
    );
    await oracle.getIndexTokenPrice(uniswap.mockDeployer, usdIndex);

    await deployIndexCategory(path.join(__dirname, 'demo-data', 'defi-category.json'));
    const defiIndex = await poolController.deployPool(
      2,
      5,
      'DEFI Index 5',
      'DEFII5',
      1
    );
    console.log('Deployed index fund for DEFI category');
    const defiPrice = await oracle.getIndexTokenPrice(uniswap.mockDeployer, defiIndex);
    await uniswap.deployPoolMarketWithLiquidity(
      defiIndex.options.address,
      defiPrice,
      20
    );
    await oracle.getIndexTokenPrice(uniswap.mockDeployer, defiIndex);
  }
}

app.post('/createCategory', async (req, res) => {
  const { name, symbol, description } = req.body;
  if (
    typeof name != 'string' ||
    typeof symbol != 'string' ||
    typeof description != 'string'
  ) {
    throw new Error('Category must have name, symbol and description');
  }
  const {
    json: metadata,
    sha3Hash: metadataHash,
    ipfsHash
  } = await uploadFile(temporal, { name, symbol, description });
  const categoryID = await oracle.createCategory(metadataHash);
  return res.json({
    metadata: { metadata, metadataHash, ipfsHash },
    categoryID
  });
});

app.post('/addToken', async (req, res) => {
  const { token, categoryID } = req.body;
  await oracle.addTokenToCategory(token, categoryID);
  return res.sendStatus(200);
});

app.post('/deployIndexFund', async (req, res) => {
  const { categoryID, indexSize, initialStablecoinValue } = req.body;
  if (!categoryID || !indexSize || !initialStablecoinValue) {
    throw new Error('Fund must have category ID, index size and stablecoin value.');
  }
  const metadata = await oracle.getCategoryMetadata(categoryID);
  const { name, symbol } = indexNameAndSymbol(metadata, indexSize);
  const stablecoinAmount = nTokensHex(initialStablecoinValue);
  const contract = await poolController.deployPool(
    categoryID,
    indexSize,
    name,
    symbol,
    stablecoinAmount
  );
  return res.json({
    name,
    symbol,
    address: contract.options.address
  });
});

app.get('/contracts', (req, res) => {
  return res.json({
    uniswapFactory: uniswap.uniswapFactory.options.address,
    uniswapRouter: uniswap.uniswapRouter.options.address,
    weth: uniswap.weth.options.address,
    stablecoin: uniswap.stablecoin.options.address,
    marketOracle: oracle.oracle.options.address
  });
});

start();