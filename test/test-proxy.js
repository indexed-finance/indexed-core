const { expect } = require("chai");
const { abi: proxyLogicABI } = require('../artifacts/MockProxyLogic.json')

describe('Mock Proxy Factory', async () => {
  let proxyFactory;
  let proxyAddress, from;
  let proxy;

  before(async () => {
    const factory = await ethers.getContractFactory("MockProxyFactory");
    proxyFactory = await factory.deploy();
    [from] = await web3.eth.getAccounts();
  });

  it('Deploys a proxy contract', async () => {
    const salt = '0x' + 'ab'.repeat(32);
    const receipt = await proxyFactory.deployProxy(salt).then(r => r.wait());
    ({ proxyAddress } = receipt.events[0].args);
    expect(await proxyFactory.getProxyAddress(salt)).to.equal(proxyAddress);
    const codeMatches = await proxyFactory.compareCodeHash(salt);
    expect(codeMatches).to.be.true;
    proxy = new web3.eth.Contract(proxyLogicABI, proxyAddress);
    console.log(`Proxy Deployment Cost: ${receipt.gasUsed}`);
  });

  it('Queries the stored value', async () => {
    const result = await proxy.methods.getValue().call();
    expect(result).to.equal('0');
  });

  it('Increments the stored value', async () => {
    await proxy.methods.incrementValue().send({ from });
    const result = await proxy.methods.getValue().call();
    expect(result).to.equal('1');
  });

  it('Decrements the stored value', async () => {
    await proxy.methods.decrementValue().send({ from });
    const result = await proxy.methods.getValue().call();
    expect(result).to.equal('0');
  });
});