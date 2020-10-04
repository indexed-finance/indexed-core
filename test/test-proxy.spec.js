const { ethers } = require("@nomiclabs/buidler");

describe('Proxies', async () => {
  let testContract;

  before(async () => {
    const ProxyTest = await ethers.getContractFactory('ProxyTest');
    testContract = await ProxyTest.deploy();
  });

  it('deployInvalidImplementation()', async () => {
    await testContract.test_deployInvalidImplementation()
  });

  it('createManyToOneProxyRelationship()', async () => {
    await testContract.test_createManyToOneProxyRelationship()
  });

  it('unapprovedDeployer()', async () => {
    await testContract.test_unapprovedDeployer()
  });

  it('approveDeployer()', async () => {
    await testContract.test_approveDeployer()
  });

  it('deployProxyManyToOne()', async () => {
    await testContract.test_deployProxyManyToOne()
  });

  it('revokeDeployerApproval()', async () => {
    await testContract.test_revokeDeployerApproval()
  });

  it('setImplementationAddressManyToOne()', async () => {
    await testContract.test_setImplementationAddressManyToOne()
  });

  it('deployProxyOneToOne()', async () => {
    await testContract.test_deployProxyOneToOne()
  });

  it('setImplementationAddressOneToOne()', async () => {
    await testContract.test_setImplementationAddressOneToOne()
  })
});