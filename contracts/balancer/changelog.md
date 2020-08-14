# Balancer Contracts Changelog
Description of modifications to the Balancer contracts.

# BFactory

### `newBPool(...)`
Replaced pool deployment with a create2 delegatecall proxy deployment.

Added the following parameters:
- `categoryID` Identifier for the category the pool will index.
- `indexSize` Number of tokens the index will hold.
- `name` Name of the pool, used for the liquidity token.
- `symbol` Symbol for the pool's liquidity token.

The create2 salt is computed as `keccak256(abi.encodePacked(categoryID, indexSize))`

### `computePoolAddress(...)`

Added function to compute the pool address for a given `categoryID` and `indexSize`.

# BToken

### `_initializeToken(name, symbol)`
Added an initializer for the `name` and `symbol` values.
`_initializeToken` is an internal function which is called by the pool's external initializer.

# BPool

The BPool contract was split into different contracts which each handle a part of the functionality.
This was mostly done to improve readability.

Because the index fund will regularly adjust its balance, we decided to have the weights update gradually over time when
a new desired weight is set in order to avoid large impermanent losses; further, the pool will not update token balances
when pool weights are adjusted. Instead, the pool will restrict each weight adjustment to the proportion of the existing
weight represented by the swap fee. i.e. If the weight is 50% and the swap fee is 10%, the weight can move up to 5% in either
direction at a time. This should result in automatic value adjustment from arbitrage, rather than requiring external markets.

## Structs

### `Record`
Added two variables:
- `lastDenormUpdate` Timestamp of the last change to the weight
- `desiredDenorm` Target weight for the token

Changed `denorm` to a `uint96` to save on storage costs.
This will never overflow because the maximum total weight is significantly less than
the maximum 96 bit integer.

Changed `index` to a `uint8` to save on storage costs.
The contract does not allow more than 8 tokens in a pool, so this will not overflow.

## Functions

### `constructor()` **(REMOVED)**
Replaced with `initialize()` to support delegatecall proxies.

### `finalize()` **(REMOVED)**
Removed the finalize function because there is nothing in the index framework
which would make this relevant.

`isFinalized()` is kept to avoid any kind of conflict with balancer libraries, but it just returns `_publicSwap`

### `joinPool()`
Replaced `require(_finalize)` with `require(_publicSwap)`

### `joinswapExternAmountIn()`
Replaced `require(_finalize)` with `require(_publicSwap)`

### `joinswapPoolAmountOut()`
Replaced `require(_finalize)` with `require(_publicSwap)`

### `rebind()` **(REMOVED)**
Removed the rebind function.
Token weights are now adjusted through the `setDesiredDenorm()` function.

### `bindInitial(tokens, balances, denorms)` **(NEW)**
> Requires **CONTROL**.

> Can only be called when the tokens array is empty.

**Parameters**:
- `address[] tokens` Array of tokens to bind
- `uint256[] balances` Balances to transfer from the controller
- `uint96[] denorms` Initial token weights

**Description**

This sets the initial tokens and their weights, then sets `_publicSwap` to true.

### `setDesiredDenorm(token, denorm)` **(NEW)**
> **NOTE:** Requires **CONTROL**

Set `desiredDenorm`

### `updateDenorm(token)` **(NEW)**
