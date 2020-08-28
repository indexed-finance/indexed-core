const app = require('./express');
const setup = require('./setup');
const uploadFile = require('./upload');
const indexNameAndSymbol = require('../../lib/util/index-name');
const { nTokensHex } = require('../../lib/util/bn');

let web3, temporal, from, uniswap, oracle, poolController, PORT;

async function start() {
  console.log('Starting server...');
  ({ web3, temporal, from, uniswap, oracle, poolController, PORT } = await setup());
  return new Promise((resolve) =>
    app.listen(PORT, () => {
      console.log(`Server listening on ${PORT}`);
    })
  );
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