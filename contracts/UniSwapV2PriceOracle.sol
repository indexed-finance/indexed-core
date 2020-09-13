pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import {
  UniswapV2OracleLibrary as UniV2Oracle
} from "./lib/UniswapV2OracleLibrary.sol";
import "./lib/FixedPoint.sol";
import "./interfaces/IERC20.sol";


contract UniSwapV2PriceOracle {
  /* ---  Constants  --- */

  // Period over which prices are observed, each period should have 1 price observation.
  uint32 public constant OBSERVATION_PERIOD = 3.5 days;

  // Minimum time elapsed between price observations
  uint32 public constant MINIMUM_OBSERVATION_DELAY = OBSERVATION_PERIOD / 2;

  // Maximum age an observation can have to still be usable in standard price queries.
  uint32 public constant MAXIMUM_OBSERVATION_AGE = OBSERVATION_PERIOD * 2;

  /* ---  Structs  --- */

  struct PriceObservation {
    uint32 timestamp;
    uint224 priceCumulativeLast;
  }

  /* ---  Events  --- */

  event PriceUpdated(address token, uint224 priceCumulativeLast);

  /* ---  Storage  --- */

  // Uniswap factory address
  address internal _uniswapFactory;

  // Wrapped ether token address
  address internal _weth;

  // Price observations for tokens indexed by time period.
  mapping(
    address => mapping(uint256 => PriceObservation)
  ) internal _priceObservations;

  constructor(address uniswapFactory, address weth) public {
    _uniswapFactory = uniswapFactory;
    _weth = weth;
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
    PriceObservation memory _new = _observePrice(token);
    // We use the observation's timestamp rather than `now` because the
    // UniSwap pair may not have updated the price this block.
    uint256 observationIndex = observationIndexOf(_new.timestamp);

    PriceObservation storage current = _priceObservations[token][observationIndex];
    if (current.timestamp != 0) {
      // If an observation has already been made for this period, do not update.
      return false;
    }

    PriceObservation memory previous = _priceObservations[token][observationIndex - 1];
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

  /* ---  Queries  --- */

  /**
   * @dev Gets the price observation at `observationIndex` for `token`.
   *
   * Note: This does not assert that there is an observation for that index,
   * this should be verified by the recipient.
   */
  function getPriceObservation(address token, uint256 observationIndex)
    external
    view
    returns (PriceObservation memory)
  {
    return _priceObservations[token][observationIndex];
  }

  /**
   * @dev Gets the observation index for `timestamp`
   */
  function observationIndexOf(uint256 timestamp) public pure returns (uint256) {
    return timestamp / OBSERVATION_PERIOD;
  }

  function canUpdatePrice(address token) external view returns (bool) {
    PriceObservation memory _new = _observePrice(token);
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

  /**
   * @dev Compute the average value in _weth of a given amount
   * of a token. Queries the current cumulative price and retrieves
   * the last stored cumulative price, then calculates the average
   * price and multiplies it by the input amount.
   */
  function computeAverageAmountOut(address token, uint256 amountIn)
    public
    view
    returns (uint144 amountOut)
  {
    // Get the current cumulative price
    PriceObservation memory current = _observePrice(token);

    // Get the latest usable price
    PriceObservation memory previous = _getLatestUsableObservation(
      token,
      current.timestamp
    );

    return
      UniV2Oracle.computeAverageAmountOut(
        previous.priceCumulativeLast,
        current.priceCumulativeLast,
        uint32(current.timestamp - previous.timestamp),
        amountIn
      );
  }

  /**
   * @dev Compute the average market cap of a token over the recent period.
   * Queries the current cumulative price and retrieves the last stored
   * cumulative price, then calculates the average price and multiplies it
   * by the token's total supply.
   * Note: Price must have been updated within the last MINIMUM_OBSERVATION_DELAY
   * seconds.
   */
  function computeAverageMarketCap(address token)
    public
    view
    returns (uint144 marketCap)
  {
    uint256 totalSupply = IERC20(token).totalSupply();
    return computeAverageAmountOut(token, totalSupply);
  }

  /**
   * @dev Returns the average market cap for each token.
   */
  function computeAverageMarketCaps(address[] memory tokens)
    public
    view
    returns (uint144[] memory marketCaps)
  {
    uint256 len = tokens.length;
    marketCaps = new uint144[](len);
    for (uint256 i = 0; i < len; i++) {
      marketCaps[i] = computeAverageMarketCap(tokens[i]);
    }
  }

  /**
   * @dev Returns the UQ112x112 struct representing the average price.
   */
  function computeAveragePrice(address token)
    public
    view
    returns (FixedPoint.uq112x112 memory priceAverage)
  {
    // Get the current cumulative price
    PriceObservation memory current = _observePrice(token);
    // Get the latest usable price
    PriceObservation memory previous = _getLatestUsableObservation(
      token,
      current.timestamp
    );

    return
      UniV2Oracle.computeAveragePrice(
        previous.priceCumulativeLast,
        current.priceCumulativeLast,
        uint32(current.timestamp - previous.timestamp)
      );
  }

  /**
   * @dev Returns the average market caps for each token.
   */
  function computeAveragePrices(address[] memory tokens)
    public
    view
    returns (FixedPoint.uq112x112[] memory averagePrices)
  {
    uint256 len = tokens.length;
    averagePrices = new FixedPoint.uq112x112[](len);
    for (uint256 i = 0; i < len; i++) {
      averagePrices[i] = computeAveragePrice(tokens[i]);
    }
  }

  /* ---  Internal Observation Functions  --- */

  /**
   * @dev Query the current cumulative price for a token.
   */
  function _observePrice(address token)
    internal
    view
    returns (PriceObservation memory)
  {
    (uint256 priceCumulative, uint32 blockTimestamp) = UniV2Oracle
      .getCurrentCumulativePrice(_uniswapFactory, token, _weth);
    return PriceObservation(blockTimestamp, uint224(priceCumulative));
  }

  /**
   * @dev Gets the latest price observation which is at least half a period older
   * than `timestamp` and at most 2 periods older.
   * @param token Token to get the latest price for
   * @param timestamp Reference timestamp for comparison
   */
  function _getLatestUsableObservation(address token, uint32 timestamp)
    internal
    view
    returns (PriceObservation memory observation)
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
