// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

// import {
//   UniswapV2OracleLibrary as UniV2Oracle
// } from "./lib/UniswapV2OracleLibrary.sol";
import "./lib/FixedPoint.sol";
import { PriceLibrary as Prices } from "./lib/PriceLibrary.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";


/**
 * @dev This contract is a UniSwapV2 price oracle that tracks the
 * time weighted moving average price of tokens in terms of WETH.
 *
 * The price oracle is deployed with an observation period parameter
 * which defines the default time over which the oracle should average
 * prices.
 *
 * In order to query the price of a token from the oracle, the latest
 * price observation from UniSwap must be at least half the observation
 * period old and at most twice the observation period old.
 *
 * For further reading, see:
 * https://uniswap.org/blog/uniswap-v2/#price-oracles
 * https://uniswap.org/whitepaper.pdf#subsection.2.2
 */
contract UniSwapV2PriceOracle {
  using Prices for address;
  using Prices for Prices.PriceObservation;
  using Prices for Prices.TwoWayAveragePrice;
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;

/* ---  Constants  --- */

  // Period over which prices are observed, each period should have 1 price observation.
  uint32 public immutable OBSERVATION_PERIOD;

  // Minimum time elapsed between price observations
  uint32 public immutable MINIMUM_OBSERVATION_DELAY;

  // Maximum age an observation can have to still be usable in standard price queries.
  uint32 public immutable MAXIMUM_OBSERVATION_AGE;

/* ---  Events  --- */

  event PriceUpdated(address token, uint224 priceCumulativeLast);

/* ---  Storage  --- */

  // Uniswap factory address
  address internal immutable _uniswapFactory;

  // Wrapped ether token address
  address internal immutable _weth;

  // Price observations for tokens indexed by time period.
  mapping(
    address => mapping(uint256 => Prices.PriceObservation)
  ) internal _priceObservations;

  constructor(
    address uniswapFactory,
    address weth,
    uint32 observationPeriod
  ) public {
    _uniswapFactory = uniswapFactory;
    _weth = weth;
    OBSERVATION_PERIOD = observationPeriod;
    MINIMUM_OBSERVATION_DELAY = observationPeriod / 2;
    MAXIMUM_OBSERVATION_AGE = observationPeriod * 2;
  }

/* ---  Price Updates  --- */

  /**
   * @dev Updates the latest price observation for a token if allowable.
   *
   * Note: The price can only be updated once per period, and price
   * observations must be made at least half a period apart.
   *
   * @param token Token to update the price of
   * @return didUpdate Whether the token price was updated.
   */
  function updatePrice(address token) public returns (bool didUpdate) {
    Prices.PriceObservation memory _new = _uniswapFactory.observePrice(token, _weth);
    // We use the observation's timestamp rather than `now` because the
    // UniSwap pair may not have updated the price this block.
    uint256 observationIndex = observationIndexOf(_new.timestamp);

    Prices.PriceObservation storage current = _priceObservations[token][observationIndex];
    if (current.timestamp != 0) {
      // If an observation has already been made for this period, do not update.
      return false;
    }

    Prices.PriceObservation memory previous = _priceObservations[token][observationIndex - 1];
    uint256 timeElapsed = _new.timestamp - previous.timestamp;
    if (timeElapsed < MINIMUM_OBSERVATION_DELAY) {
      // If less than half a period has passed since the previous observation, do not update.
      return false;
    }
    _priceObservations[token][observationIndex] = _new;
    emit PriceUpdated(token, _new.priceCumulativeLast);
    return true;
  }

  /**
   * @dev Updates the prices of multiple tokens.
   *
   * @param tokens Array of tokens to update the prices of
   * @return updates Array of boolean values indicating which tokens
   * successfully updated their prices.
   */
  function updatePrices(address[] memory tokens)
    public
    returns (bool[] memory updates)
  {
    updates = new bool[](tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      updates[i] = updatePrice(tokens[i]);
    }
  }

/* ---  Observation Queries  --- */

  /**
   * @dev Gets the price observation at `observationIndex` for `token`.
   *
   * Note: This does not assert that there is an observation for that index,
   * this should be verified by the recipient.
   */
  function getPriceObservation(address token, uint256 observationIndex)
    external
    view
    returns (Prices.PriceObservation memory)
  {
    return _priceObservations[token][observationIndex];
  }

  /**
   * @dev Gets the observation index for `timestamp`
   */
  function observationIndexOf(uint256 timestamp) public view returns (uint256) {
    return timestamp / OBSERVATION_PERIOD;
  }

  function canUpdatePrice(address token) external view returns (bool) {
    Prices.PriceObservation memory _new = _uniswapFactory.observePrice(token, _weth);
    // We use the observation's timestamp rather than `now` because the
    // UniSwap pair may not have updated the price this block.
    uint256 observationIndex = observationIndexOf(_new.timestamp);
    // If this period already has an observation, return false.
    if (_priceObservations[token][observationIndex].timestamp != 0)
      return false;
    // An observation can be made if the last update was at least half a period ago.
    uint32 timeElapsed = _new.timestamp -
      _priceObservations[token][observationIndex - 1].timestamp;
    return timeElapsed >= MINIMUM_OBSERVATION_DELAY;
  }

/* ---  Value Queries  --- */

  /**
   * @dev Computes the average value in weth of `amountIn` of `token`.
   */
  function computeAverageAmountOut(address token, uint256 amountIn)
    public
    view
    returns (uint144 amountOut)
  {
    FixedPoint.uq112x112 memory priceAverage = computeAverageTokenPrice(token);
    return priceAverage.mul(amountIn).decode144();
  }

  /**
   * @dev Computes the average value in `token` of `amountOut` of weth.
   */
  function computeAverageAmountIn(address token, uint256 amountOut)
    public
    view
    returns (uint144 amountIn)
  {
    FixedPoint.uq112x112 memory priceAverage = computeAverageEthPrice(token);
    return priceAverage.mul(amountOut).decode144();
  }

  /**
   * @dev Compute the average value in weth of each token in `tokens`
   * for the corresponding token amount in `amountsIn`.
   */
  function computeAverageAmountsOut(
    address[] calldata tokens,
    uint256[] calldata amountsIn
  )
    external
    view
    returns (uint144[] memory amountsOut)
  {
    uint256 len = tokens.length;
    require(amountsIn.length == len, "ERR_ARR_LEN");
    amountsOut = new uint144[](len);
    for (uint256 i = 0; i < len; i++) {
      amountsOut[i] = computeAverageAmountOut(tokens[i], amountsIn[i]);
    }
  }


  /**
   * @dev Compute the average value of each amount of weth in `amountsOut`
   * in terms of the corresponding token in `tokens`.
   */
  function computeAverageAmountsIn(
    address[] calldata tokens,
    uint256[] calldata amountsOut
  )
    external
    view
    returns (uint144[] memory amountsIn)
  {
    uint256 len = tokens.length;
    require(amountsOut.length == len, "ERR_ARR_LEN");
    amountsIn = new uint144[](len);
    for (uint256 i = 0; i < len; i++) {
      amountsIn[i] = computeAverageAmountIn(tokens[i], amountsOut[i]);
    }
  }

/* ---  Price Queries  --- */

  /**
   * @dev Returns the UQ112x112 struct representing the average price of
   * `token` in terms of weth.
   *
   * Note: Requires that the token has a price observation between 0.5
   * and 2 periods old.
   */
  function computeAverageTokenPrice(address token)
    public
    view
    returns (FixedPoint.uq112x112 memory priceAverage)
  {
    // Get the current cumulative price
    Prices.PriceObservation memory current = _uniswapFactory.observePrice(token, _weth);
    // Get the latest usable price
    Prices.PriceObservation memory previous = _getLatestUsableObservation(
      token,
      current.timestamp
    );

    return previous.computeAverageTokenPrice(current);
  }

  /**
   * @dev Returns the UQ112x112 struct representing the average price of
   * weth in terms of `token`.
   *
   * Note: Requires that the token has a price observation between 0.5
   * and 2 periods old.
   */
  function computeAverageEthPrice(address token)
    public
    view
    returns (FixedPoint.uq112x112 memory priceAverage)
  {
    // Get the current cumulative price
    Prices.PriceObservation memory current = _uniswapFactory.observePrice(token, _weth);
    // Get the latest usable price
    Prices.PriceObservation memory previous = _getLatestUsableObservation(
      token,
      current.timestamp
    );

    return previous.computeAverageEthPrice(current);
  }

  /**
   * @dev Returns the TwoWayAveragePrice struct representing the average price of
   * weth in terms of `token` and the average price of `token` in terms of weth.
   *
   * Note: Requires that the token has a price observation between 0.5
   * and 2 periods old.
   */
  function computeTwoWayAveragePrice(address token)
    public
    view
    returns (Prices.TwoWayAveragePrice memory)
  {
    // Get the current cumulative price
    Prices.PriceObservation memory current = _uniswapFactory.observePrice(token, _weth);
    // Get the latest usable price
    Prices.PriceObservation memory previous = _getLatestUsableObservation(
      token,
      current.timestamp
    );

    return previous.computeTwoWayAveragePrice(current);
  }

  /**
   * @dev Returns the UQ112x112 structs representing the average price of
   * each token in `tokens` in terms of weth.
   */
  function computeAverageTokenPrices(address[] memory tokens)
    public
    view
    returns (FixedPoint.uq112x112[] memory averagePrices)
  {
    uint256 len = tokens.length;
    averagePrices = new FixedPoint.uq112x112[](len);
    for (uint256 i = 0; i < len; i++) {
      averagePrices[i] = computeAverageTokenPrice(tokens[i]);
    }
  }

  /**
   * @dev Returns the UQ112x112 structs representing the average price of
   * weth in terms of each token in `tokens`.
   */
  function computeAverageEthPrices(address[] memory tokens)
    public
    view
    returns (FixedPoint.uq112x112[] memory averagePrices)
  {
    uint256 len = tokens.length;
    averagePrices = new FixedPoint.uq112x112[](len);
    for (uint256 i = 0; i < len; i++) {
      averagePrices[i] = computeAverageEthPrice(tokens[i]);
    }
  }

  /**
   * @dev Returns the TwoWayAveragePrice structs representing the average price of
   * weth in terms of each token in `tokens` and the average price of each token
   * in terms of weth.
   *
   * Note: Requires that the token has a price observation between 0.5
   * and 2 periods old.
   */
  function computeTwoWayAveragePrices(address[] memory tokens)
    public
    view
    returns (Prices.TwoWayAveragePrice[] memory averagePrices)
  {
    uint256 len = tokens.length;
    averagePrices = new Prices.TwoWayAveragePrice[](len);
    for (uint256 i = 0; i < len; i++) {
      averagePrices[i] = computeTwoWayAveragePrice(tokens[i]);
    }
  }

/* ---  Internal Observation Functions  --- */

  /**
   * @dev Gets the latest price observation which is at least half a period older
   * than `timestamp` and at most 2 periods older.
   *
   * @param token Token to get the latest price for
   * @param timestamp Reference timestamp for comparison
   */
  function _getLatestUsableObservation(address token, uint32 timestamp)
    internal
    view
    returns (Prices.PriceObservation memory observation)
  {
    uint256 observationIndex = observationIndexOf(timestamp);
    uint256 periodTimeElapsed = timestamp % OBSERVATION_PERIOD;
    // Before looking at the current observation period, check if it is possible
    // for an observation in the current period to be more than half a period old.
    if (periodTimeElapsed >= MINIMUM_OBSERVATION_DELAY) {
      observation = _priceObservations[token][observationIndex];
      if (
        observation.timestamp != 0 &&
        timestamp - observation.timestamp >= MINIMUM_OBSERVATION_DELAY
      ) {
        return observation;
      }
    }
    // Check the observation for the previous period
    observation = _priceObservations[token][observationIndex - 1];
    uint256 timeElapsed = timestamp - observation.timestamp;
    if (
      observation.timestamp != 0 && timeElapsed >= MINIMUM_OBSERVATION_DELAY
    ) {
      return observation;
    }
    // Check the observation from 2 periods ago.
    observation = _priceObservations[token][observationIndex - 2];
    timeElapsed = timestamp - observation.timestamp;
    require(
      observation.timestamp != 0 && timeElapsed <= MAXIMUM_OBSERVATION_AGE,
      "ERR_USABLE_PRICE_NOT_FOUND"
    );
  }
}
