# @indexed-finance/indexed-core

[Documentation](https://docs.indexed.finance)

## Deploy

To deploy with proper verification on Etherscan, use the scripts in package.json.

The factory must be deployed first, followed by the controller. After these two, the pool, initializer and seller implementations can be deployed in any order.

The deploy scripts can be run with:

> `yarn deploy:<contract> <network>`

e.g.
> `yarn deploy:pool mainnet`

## Test

> `npm run test`

## Coverage

> `npm run coverage`

