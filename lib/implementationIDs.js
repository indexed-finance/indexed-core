const { sha3 } = require('../test/utils');

module.exports = {
  poolInitializerID: sha3('PoolInitializer.sol'),
  poolImplementationID: sha3('IndexPool.sol'),
  sellerImplementationID: sha3('UnboundTokenSeller.sol'),
  controllerImplementationSalt: sha3('MarketCapSqrtController.sol')
}