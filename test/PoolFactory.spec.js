const { sha3, verifyRejection, expect, zeroAddress } = require("./utils");

const poolImplementationID = sha3('IndexPool.sol');

const salt = '0x'+'ff'.repeat(32);

describe('PoolFactory.sol', async () => {
  let poolFactory, verifyRevert;
  let signer1, signer2, address1, address2;
  let poolAddress;

  before(async () => {
    const deploy = async (name, ...args) => (await ethers.getContractFactory(name)).deploy(...args);
    const proxyManager = await deploy('DelegateCallProxyManager');
    const poolImplementation = await deploy('IndexPool');
    await proxyManager.createManyToOneProxyRelationship(poolImplementationID, poolImplementation.address);
    poolFactory = await deploy('PoolFactory', proxyManager.address);
    await proxyManager.approveDeployer(poolFactory.address).then(r => r.wait());

    const signers = await ethers.getSigners();
    [signer1, signer2] = signers;
    [address1, address2] = await Promise.all(signers.map(s => s.getAddress()));
  });

  describe('approvePoolController()', async () => {
    it('Reverts if not called by owner', async () => {
      await verifyRejection(poolFactory.connect(signer2), 'approvePoolController', /Ownable: caller is not the owner/g, address2);
    });

    it('Marks account as approved controller', async () => {
      await poolFactory.approvePoolController(address2);
      expect(await poolFactory.isApprovedController(address2)).to.be.true;
    });
  });

  describe('disapprovePoolController()', async () => {
    it('Reverts if not called by owner', async () => {
      await verifyRejection(poolFactory.connect(signer2), 'disapprovePoolController', /Ownable: caller is not the owner/g, address2);
    });

    it('Marks account as unapproved controller', async () => {
      expect(await poolFactory.isApprovedController(address2)).to.be.true;
      await poolFactory.disapprovePoolController(address2);
      expect(await poolFactory.isApprovedController(address2)).to.be.false;
    });
  });

  describe('deployPool()', async () => {
    let eventArgs;

    it('Reverts if not called by approved controller', async () => {
      await verifyRejection(
        poolFactory.connect(signer2),
        'deployPool',
        /ERR_NOT_APPROVED/g,
        '0x'+'ff'.repeat(32),
        salt
      );
    });

    it('Deploys pool', async () => {
      await poolFactory.approvePoolController(address2);
      const tx = await poolFactory.connect(signer2).deployPool(poolImplementationID, salt);
      const { events } = await tx.wait();
      const { args } = events.filter(e => e.event == 'NewPool')[0];
      eventArgs = args;

    });

    it('Emits NewPool event with pool info', async () => {
      expect(eventArgs.controller).to.eq(address2);
      expect(eventArgs.pool).to.not.be.null;
      expect(eventArgs.implementationID).to.eq(poolImplementationID);
      poolAddress = eventArgs.pool;
    });

    it('Stores the pool implementation ID', async () => {
      const actual = await poolFactory.getPoolImplementationID(poolAddress);
      expect(actual).to.eq(poolImplementationID);
    });
  });

  describe('computePoolAddress()', async () => {
    it('Returns same address as deployment', async () => {
      const actual = await poolFactory.computePoolAddress(poolImplementationID, address2, salt);
      expect(actual).to.eq(poolAddress);
    });
  });

  describe('isRecognizedPool()', async () => {
    it('Returns true for deployed pool', async () => {
      expect(await poolFactory.isRecognizedPool(poolAddress)).to.be.true;
    });

    it('Returns false for any other account', async () => {
      expect(await poolFactory.isRecognizedPool(zeroAddress)).to.be.false;
    });
  });
});