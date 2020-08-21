# Indexed - Index Funds for Ethereum Token Markets

Indexed is a framework for creating semi-autonomous index funds that track Ethereum market sectors.

Each index fund is a Balancer pool that tracks a specific token category and has a preset index size (number of underlying tokens). Index funds each have an ERC20 token which can be minted by providing the underlying assets that the fund tracks or burned to retrieve the underlying tokens. Each week, the index funds reweigh their tokens proportionally to the square roots of their market caps, which are extrapolated from a UniSwap price oracle. After new weights are computed, the index fund gradually adjusts its existing weights towards the new ones as trades are executed within the pool.

Indexed is managed by the Indexed governance DAO, which creates token categories, provides liquidity to maintain stable prices for index tokens and deploys new index funds. The Indexed DAO can create token offerings which allow individuals to mint new Indexed tokens in exchange for DAI at a set price. When a sale has concluded, 50% of the raised liquidity is used to mint index tokens, then the index tokens and the remaining 50% are used to provide liquidity on UniSwap. Injecting liquidity into UniSwap markets between DAI and the index tokens will create opportunities for arbitrageurs to stabilize the price of the index tokens relative to DAI. Indexed holders receive fees when index tokens are minted, burned or swapped within index funds, and when the tokens are traded on UniSwap.

## Market Oracle ([MarketOracle.sol](contracts/MarketOracle.sol))
The Market Oracle contract is a UniSwap price oracle that is used in the Indexed framework to track prices and market caps for tokens in different categories. A category is meant to track a particular type of ERC20 token; for example, a category might be for USD stablecoins, Bitcoin wrapper tokens, liquidity provider tokens like Compound, governance tokens, etc. The idea is to track a particular group of assets which the governance DAO believes can be grouped together on the basis of some common attribute.

### Token Categories
The governance DAO can "whitelist" tokens on the market oracle and assign them to a particular token category. Each token can only be assigned one category. This has the dual purpose of assigning asset types that can be used in index funds and preventing an exploit where artificial markets are used to steal assets from index funds.

### Price Queries
The market oracle allows anyone to call the contract and update the price for a token or a group of tokens, which is queried from the UniSwap market between a whitelisted token and a configured stablecoin (which will probably always be DAI). The contract does this by using the [oracle feature introduced by UniSwapV2](https://uniswap.org/blog/uniswap-v2/#price-oracles), where cumulative prices can be queried from a market and the difference between them provides a moving average of the token price over a period of time. The oracle allows each token price to be updated once per day and only allows price queries to be executed if the price is less than a day old, ensuring that prices are only available if they are representative of the recent average price of a token.

### Market Caps
The market oracle can extrapolate the market cap of a token by multiplying its recent moving average price by the token's total supply. Users can call the oracle to sort a token category by market cap in descending order. If a category has been sorted within the last day, other contracts can query the top $n$ tokens in the category, which is used to select assets in index funds.

 <!-- UniSwap market between a token and a selected stablecoin (which is configured by the DAO and will almost certainly always be DAI) for the cumulative price of the token.  -->

<!-- The cumulative price on a UniSwap market is essentially a moving total price for the asset over time; by taking the cumulative price at two different times and dividing the difference between the prices by the time that occurred between them, you can compute the moving average of the price over that time period. When the market oracle queries the UniSwap cumulative price, it stores that price and the time it was collected. This cumulative price value can be updated once per day. -->

<!-- A function on the oracle `computeAveragePrice` will query the current UniSwap cumulative price and compute the average price between that value and the last one it stored. It will only allow this function to be called if the last price is more than 1 hour old and less than 1 day old, so that the returned price is averaged across many blocks. -->

## Index Funds
Index funds are asset pools for a particular category that double as automated market makers. Each token in a fund has a weight which determines the total value of the index fund which is held in that token, and users can swap between the tokens on the fund to bring it in line with those weights through arbitrage. Index funds each have a predetermined index size which determines the number of underlying tokens which the fund holds, and the category determines which tokens it can select from.

Assets within an index fund are weighed by the square root of their market cap. If Token A has a market cap of 100 USD and Token B has a market cap of 144 USD, Token A will have a weight of 10/22 and Token B will have a weight of 12/22. This dampens the effect of any massive token which would otherwise drastically outweigh all the other tokens in a pool.

### Changes to the Balancer Pool
The index funds use a fork of [Balancer](https://balancer.finance)'s [BPool](https://github.com/balancer-labs/balancer-core/blob/master/contracts/BPool.sol) contract. The fork has a number of substantial changes to the original BPool contracts.

#### Deployment
IPools are deployed as delegatecall proxies using [ProxyLib.sol](contracts/lib/ProxyLib.sol). A single IPool contract is deployed with [PoolController.sol](contracts/PoolController.sol) when the controller is deployed. The original contract is never initialized, and is only used as the runtime code for the actual index fund contracts.

#### BAL
Because IPool has been substantially modified from the BPool contract, it can not be deployed using the Balancer factory. As a result, no BAL tokens will be minted for the index funds.

#### Finalization
In Balancer, BPool contracts are "finalized" when they have been initialized with tokens and their initial weights. BPools only allow assets to be traded and liquidity tokens to be minted after finalization. In Indexed, pools are never finalized, as the underlying tokens and their weights are subject to perpetual change. Instead, pools are *initialized* with their initial tokens, balances and weights, and those assets can be traded as soon as they are initialized. 

#### Incremental Weight Adjustment
In BPools, unfinalized pools can have their token weights adjusted by the pool controller directly. The controller tells the pool what weight to change the asset to and how many tokens it should add or remove (take from/give to the controller) to bring the actual balances in line with the new weights. 

In IPools, token weight adjustments are more dynamic and gradual. Instead of relying on the pool controller to execute external trades to adjust the token balances to match new weights, the IPool contract incrementally adjusts token weights over time as they are swapped within the pool, allowing arbitrage to slowly move tokens toward their target balances.

### Rebalancing
