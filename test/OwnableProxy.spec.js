const { verifyRejection, zeroAddress, expectEvent, expect, sha3 } = require('./utils');

describe('OwnableProxy.sol', function () {
  let owner, other;
  let owned;
  let implementation;

  before(async () => {
    [owner, other] = await ethers.getSigners();
  })

  beforeEach(async function () {
    const deploy = async (name, ...args) => (await ethers.getContractFactory(name)).deploy(...args);
    const proxyManager = await deploy('DelegateCallProxyManager');
    implementation = await deploy('OwnableProxyMock');
    const proxyAddress = await proxyManager.computeProxyAddressOneToOne(await owner.getAddress(), sha3('OwnableProxyMock.sol'));
    await proxyManager.deployProxyOneToOne(sha3('OwnableProxyMock.sol'), implementation.address);
    owned = await ethers.getContractAt('OwnableProxyMock', proxyAddress);
  });

  it('locks the base implementation contract', async () => {
    expect(await implementation.owner()).to.equal(`0x${'1'.padStart(40, '0')}`);
  });

  describe('initialize ownership', function () {
    it('has null owner before initialization', async function () {
      expect(await owned.owner()).to.eq(`0x${'00'.repeat(20)}`);
    });

    it('sets owner', async function () {
      const receipt = await owned.initialize();
      await expectEvent(receipt, 'OwnershipTransferred');
      expect(await owned.owner()).to.equal(await owner.getAddress());
    });

    it('prevents initialized contract from being initialized', async function () {
      await owned.initialize();
      await verifyRejection(owned, 'initialize', /Ownable: owner has already been initialized/);
    })
  });

  describe('transfer ownership', function () {
    it('changes owner after transfer', async function () {
      await owned.initialize();
      let newOwner = await other.getAddress();
      await owned.transferOwnership(newOwner);
      expect(await owned.owner()).to.equal(newOwner);
    });

    it('prevents non-owners from transferring', async function () {
      await owned.initialize();
      await verifyRejection(owned.connect(other), 'transferOwnership', /Ownable: caller is not the owner/, await other.getAddress());
    });

    it('guards ownership against stuck state', async function () {
      await owned.initialize();
      await verifyRejection(owned, 'transferOwnership', /Ownable: new owner is the zero address/, zeroAddress);
    });
  });

  describe('renounce ownership', function () {
    it('loses owner after renouncement', async function () {
      await owned.initialize();
      const receipt = await owned.renounceOwnership();
      await expectEvent(receipt, 'OwnershipTransferred');

      expect(await owned.owner()).to.equal(`0x${'1'.padStart(40, '0')}`);
    });

    it('prevents non-owners from renouncement', async function () {
      await owned.initialize();
      await verifyRejection(
        owned.connect(other),
        'renounceOwnership',
        /Ownable: caller is not the owner/,
        []
      );
    });
  });
});