# indexed-core

[Documentation](https://docs.indexed.finance)

## Tests

## Test coverage

`npm run coverage`

Runs solidity-coverage with all the tests.

### Test pool

`npm run test:pool`

This tests the `Ipool.sol` contract only, using a mock contract for the unbound token handler.

### Test controller

`npm run test:controller`

This tests the `MarketCapSqrtController.sol` contract and some of the interactions between the controller and the pool, token seller and pool initializer contracts.

### Test category management

`npm run test:categories`

This tests the `MarketCapSortedTokenCategories.sol` contract and its interactions with the price oracle.

The controller inherits this contract, but they are separated for clarity.

### Test proxies

`npm run test:proxies`

This tests the proxy contracts using mock implementations.

### Test token seller

`npm run test:seller`

Tests the `UnboundTokenSeller.sol` contract using a mock pool.

### Test oracle

`npm run test:oracle`

Tests the `UniSwapV2PriceOracle.sol` contract using mock tokens and markets.
