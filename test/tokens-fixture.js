const wrappedTokens = [
  {
    "name": "Wrapped Bitcoin",
    "symbol": "WBTC",
    "initialPrice": 10
  },
  {
    "name": "Wrapped Litecoin",
    "symbol": "WLTC",
    "initialPrice": 1
  },
  {
    "name": "Wrapped Token",
    "symbol": "WTKN",
    "initialPrice": 2
  }
]

const wrappedTokensFixture = deployments.createFixture(async ({
  deployments,
  getNamedAccounts,
  ethers
}) => {
  const { save } = deployments;
  const { deployer } = await getNamedAccounts();
  const [ signer ] = await ethers.getSigners();

  const deploy = async (name, contractName, opts, returnContract = false) => {
    const deployment = await deployments.deploy(name, {
      ...opts,
      contractName
    });
    await save(contractName, deployment);
    if (returnContract) {
      const contract = await ethers.getContractAt(deployment.abi, deployment.address, signer);
      return contract;
    }
    return deployment;
  }

  const weth = await ethers.getContract('weth');
  uniswapFactory = await ethers.getContract('uniswapFactory');
  uniswapRouter = await ethers.getContract('uniswapRouter');

  const tokens = [];
  for (let token of wrappedTokens) {
    const { name, symbol } = token;
    const erc20 = await deploy('MockERC20', symbol.toLowerCase(), {
      from: deployer,
      gas: 4000000,
      args: [name, symbol]
    }, true);
    const receipt = await uniswapFactory.createPair(
      erc20.address,
      weth.address
    );
    const { events } = await receipt.wait();
    const { args: { pair } } = events.filter(e => e.event == 'PairCreated')[0];
    tokens.push({
      ...token,
      token: erc20,
      address: erc20.address,
      pair: await ethers.getContractAt('UniswapV2Pair', pair, signer)
    });
  }
  return tokens;
});

module.exports = {wrappedTokensFixture};