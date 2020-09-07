# Indexed - Index pools for Ethereum Token Markets

Indexed is a framework for creating semi-autonomous asset pools capable of modifying their internal portfolio compositions without access to external markets.

Each index pool tracks a specific token category and has a preset index size (number of underlying tokens). Index pools each have an ERC20 token which can be minted by providing the underlying assets that the fund tracks or burned to retrieve the underlying tokens. Every two weeks, the index pools reweigh their tokens proportionally to the square roots of their market caps, which are extrapolated from a UniSwap price oracle. After new weights are computed, the index fund gradually adjusts its existing weights towards the new ones as trades are executed within the pool.

<!-- Indexed is managed by the Indexed governance DAO, which creates token categories, provides liquidity to maintain stable prices for index tokens and deploys new index pools. The Indexed DAO can create token offerings which allow individuals to mint new Indexed tokens in exchange for DAI at a set price. When a sale has concluded, 50% of the raised liquidity is used to mint index tokens, then the index tokens and the remaining 50% are used to provide liquidity on UniSwap. Injecting liquidity into UniSwap markets between DAI and the index tokens will create opportunities for arbitrageurs to stabilize the price of the index tokens relative to DAI. Indexed holders receive fees when index tokens are minted, burned or swapped within index pools, and when the tokens are traded on UniSwap. -->

## Market Oracle ([MarketOracle.sol](contracts/MarketOracle.sol))
The Market Oracle contract is a UniSwap price oracle that is used in the Indexed framework to track prices and market caps for tokens in different categories. A category is meant to track a particular type of ERC20 token; for example, a category might be for USD stablecoins, Bitcoin wrapper tokens, liquidity provider tokens like Compound, governance tokens, etc. The idea is to track a particular group of assets which the governance DAO believes can be grouped together on the basis of some common attribute.

### Token Categories
The governance DAO can "whitelist" tokens on the market oracle and assign them to a particular token category. Each token can only be assigned one category. This has the dual purpose of assigning asset types that can be used in index pools and preventing an exploit where artificial markets are used to steal assets from index pools.

### Price Queries
The market oracle allows anyone to call the contract and update the price for a token or a group of tokens, which is queried from the UniSwap market between a whitelisted token and WETH. The contract does this by using the [oracle feature introduced by UniSwapV2](https://uniswap.org/blog/uniswap-v2/#price-oracles), where cumulative prices can be queried from a market and the difference between them provides a moving average of the token price over a period of time. The oracle allows each token price to be updated once per day and only allows price queries to be executed if the price is less than a day old, ensuring that prices are only available if they are representative of the recent average price of a token.

> Note: The time delay mechanism will probably be adjusted.

### Market Caps
The market oracle can extrapolate the market cap of a token by multiplying its recent moving average price by the token's total supply. Users can call the oracle to sort a token category by market cap in descending order. If a category has been sorted within the last day, other contracts can query the top $n$ tokens in the category, which is used to select assets in index pools.


## Index Pools
The index pool contract is a fork of [Balancer](https://balancer.finance)'s [BPool](https://github.com/balancer-labs/balancer-core/blob/master/contracts/BPool.sol) contract.

An index pool is a multi-asset pool which doubles as an AMM. Each token in the pool has a weight which determines the proportion of the total pool value which that token represents. Index pools can adjust their portfolios without access to external liquidity by creating targeted arbitrage opportunities that incentivize traders to adjust the token balances in particular directions. This allows pools to modify the weights assigned to assets and change which assets are held without external market access.

In the current version, pools are designed to index specific token categories by accessing the market oracle. Index pools each have a predetermined index size which determines the number of underlying tokens which the pool holds, and the category determines which tokens it can select from.

Assets within an index fund are weighed by the square root of their market cap. Ex: If Token A has a market cap of 100 USD and Token B has a market cap of 144 USD, Token A will have a weight of 10/22 and Token B will have a weight of 12/22. This dampens the effect of any massive token which might otherwise drastically outweigh all the other tokens in a pool.

### Reweighing pools

Index pools can be reweighed by the pool controller. When a pool is reweighed, it is not immediately rebalanced: the underlying token balances and weights are not immediately adjusted; instead, a *desired weight* can be set on each token which the real weight will gradually move to as swaps are executed. When a swap is executed where the incoming token is scheduled for a weight increase, its weight will be set to `min(weight * (1 + swapFee / 2), desiredWeight)`; if an outgoing token is scheduled to decrease its weight, it will be set to `max(weight * (1 - swapFee / 2), desiredWeight)`. This creates a small arbitrage opportunity which incentivizes traders to move each token's balance closer to the desired balance based on the weighted value of the pool, as the price of the input token will increase and the price of the output token will decrease by half the swap fee. In the optimal case for an arbitrager (both tokens adjust their weights maximally), the change to the spot price caused by the weight change will be roughly equivalent to the new spot price sans weight adjustment multipled by `1 / (1+swapFee)`, meaning that the fee will essentially be void for the swap that brings the token balances back within the fee range of their actual weighted values. Weight adjustments may only occur with a maximum frequency of once per hour.

> TODO: Add proof of the spot price change with the weight adjustment.

### Re-indexing pools

Index pools can be re-indexed by the pool controller. When a pool is re-indexed, the top `indexSize` assets in the pool's category are set as the desired underlying tokens in the pool. If the new list of tokens differs from the pool's existing token set, the new tokens will be gradually bound while the old tokens not included in the set will be gradually unbound.

When a new token is bound, the pool will have a balance of `0` and a weight of `0`. The index pool relies on access to the balance and weight of each asset in order to properly price it relative to other assets: each calculation uses `balance/weight` to determine the value of the token relative to its proportion of the pool value. Instead of purchasing some initial tokens from another market like UniSwap in order to have some minimum balance that can be used for swaps, we use two fake values to get around this problem. When the pool controller is re-indexing a pool, it will calculate a *minimum balance* for each asset which represents the number of tokens which would be equivalent to the minimum proportion of the pool's value that a token must have to operate within the expectations of the contract (1/25 of the total weight). When the new token is bound to the pool, it is marked as *not ready*. Swaps which send out tokens that are not ready throw an error - the pool will only allow tokens to be traded in until the minimum balance is met. Until then, the swap calculations will use `MIN_WEIGHT` as the token's weight and `minimumBalance` as the token's balance.

> Note: The minimum balance value may result in minor losses to the pool if the price of the token or the value of the pool changes dramatically, but because it is using the minimum weight, this loss should generally be negligible. The larger issue is that if the token becomes too cheap on the pool, it will not be worthwhile to swap it in. For this reason an additional function should be added to update a token's minimum balance if it is not ready and has not met the minimum balance within some timeframe.
