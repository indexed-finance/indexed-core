const { zeroAddress, expect, verifyRejection } = require('./utils');

async function deploy(contractName, ...args) {
  const Factory = await ethers.getContractFactory(contractName);
  return Factory.deploy(...args);
}

describe('PoolFactoryAccessControl.sol', async () => {
  let access, factory;
  let owner, admin, notAdmin;

  function setupTests() {
    before(async () => {
      ([owner, admin, notAdmin] = await ethers.getSigners()
      .then(async (signers) => Promise.all(
        signers.map(async (signer) => Object.assign(signer, { address: await signer.getAddress() })))
      ));
      factory = await deploy('PoolFactory', zeroAddress);
      access = await deploy('PoolFactoryAccessControl', factory.address);
      await factory.transferOwnership(access.address);
    })
  }

  describe('poolFactory()', async () => {
    setupTests();
    
    it('Has correct address', async () => {
      expect(await access.poolFactory()).to.eq(factory.address);
    })
  })

  describe('grantAdminAccess()', async () => {
    setupTests();
    
    it('Reverts if not called by owner', async () => {
      await verifyRejection(
        access.connect(notAdmin),
        'grantAdminAccess',
        /Ownable: caller is not the owner/g,
        notAdmin.address
      )
    })

    it('Marks account as admin', async () => {
      await access.grantAdminAccess(admin.address);
      expect(await access.hasAdminAccess(admin.address)).to.be.true;
    })
  })

  describe('revokeAdminAccess()', async () => {
    setupTests();

    it('Reverts if not called by owner', async () => {
      await verifyRejection(
        access.connect(notAdmin),
        'revokeAdminAccess',
        /Ownable: caller is not the owner/g,
        notAdmin.address
      )
    })

    it('Marks account as not admin', async () => {
      await access.grantAdminAccess(admin.address);
      expect(await access.hasAdminAccess(admin.address)).to.be.true;
      await access.revokeAdminAccess(admin.address);
      expect(await access.hasAdminAccess(admin.address)).to.be.false;
    })
  })

  describe('approvePoolController()', async () => {
    setupTests();

    it('Reverts if not called by owner or admin', async () => {
      await verifyRejection(
        access.connect(notAdmin),
        'approvePoolController',
        /ERR_NOT_ADMIN_OR_OWNER/g,
        notAdmin.address
      )
    })

    it('Marks account as approved to deploy pools', async () => {
      await access.approvePoolController(admin.address);
      expect(await factory.isApprovedController(admin.address)).to.be.true;
    })

    it('Can be called by admin', async () => {
      await access.grantAdminAccess(admin.address);
      await access.connect(admin).approvePoolController(notAdmin.address);
      expect(await factory.isApprovedController(notAdmin.address)).to.be.true;
    })
  })

  describe('disapprovePoolController()', async () => {
    setupTests();

    it('Reverts if not called by owner', async () => {
      await verifyRejection(
        access.connect(notAdmin),
        'disapprovePoolController',
        /Ownable: caller is not the owner/g,
        notAdmin.address
      )
    })

    it('Marks account as not approved to deploy pools', async () => {
      await access.approvePoolController(admin.address);
      expect(await factory.isApprovedController(admin.address)).to.be.true;
      await access.disapprovePoolController(admin.address);
      expect(await factory.isApprovedController(admin.address)).to.be.false;
    })
  })

  describe('transferPoolFactoryOwnership()', async () => {
    setupTests();

    it('Reverts if not called by owner', async () => {
      await verifyRejection(
        access.connect(notAdmin),
        'transferPoolFactoryOwnership',
        /Ownable: caller is not the owner/g,
        notAdmin.address
      )
    })

    it('Transfers ownership of the pool factory', async () => {
      await access.transferPoolFactoryOwnership(notAdmin.address);
      expect(await factory.owner()).to.eq(notAdmin.address)
    })
  })
})