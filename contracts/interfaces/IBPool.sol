// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../interfaces/IFlashLoanRecipient.sol";

interface IBPool {
  /**
   * @dev Token record data structure
   * @param bound is token bound to pool
   * @param ready has token been initialized
   * @param lastDenormUpdate timestamp of last denorm change
   * @param denorm denormalized weight
   * @param desiredDenorm desired denormalized weight (used for incremental changes)
   * @param index index of address in tokens array
   * @param balance token balance
   */
  struct Record {
    bool bound;
    bool ready;
    uint40 lastDenormUpdate;
    uint96 denorm;
    uint96 desiredDenorm;
    uint8 index;
    uint256 balance;
  }

  /**
   * @dev Sets up the initial assets for the pool, assigns the controller
   * address and sets the name and symbol for the pool token.
   */
  function initialize(
    address controller,
    string calldata name,
    string calldata symbol,
    address[] calldata tokens,
    uint256[] calldata balances,
    uint96[] calldata denorms
  ) external;

/* ---  Configuration Actions  --- */

  /**
   * @dev Set the swap fee.
   * Note: Swap fee must be between 0.0001% and 10%
   */
  function setSwapFee(uint256 swapFee) external;

  /**
   * @dev Public swapping is enabled as soon as tokens are bound,
   * but this function exists in case of an emergency.
   */
  function setPublicSwap(bool public_) external;

/* ---  Token Management Actions  --- */

  /**
   * @dev Sets the desired weights for the pool tokens, which
   * will be adjusted over time as they are swapped.
   *
   * Note: This does not check for duplicate tokens or that the total
   * of the desired weights is equal to the target total weight (25).
   * Those assumptions should be met in the controller. Further, the
   * provided tokens should only include the tokens which are not set
   * for removal.
   */
  function reweighTokens(
    address[] calldata tokens,
    uint96[] calldata desiredDenorms
  )
    external;

  /**
   * @dev Update the underlying assets held by the pool and their associated
   * weights. Tokens which are not currently bound will be gradually added
   * as they are swapped in to reach the provided minimum balances, which must
   * be an amount of tokens worth the minimum weight of the total pool value.
   * If a currently bound token is not received in this call, the token's
   * desired weight will be set to 0.
   */
  function reindexTokens(
    address[] calldata tokens,
    uint96[] calldata desiredDenorms,
    uint256[] calldata minimumBalances
  )
    external;

  /**
   * @dev Unbinds a token from the pool and sends the remaining balance to the
   * pool controller. This should only be used as a last resort if a token is
   * experiencing a sudden crash or major vulnerability. Otherwise, tokens
   * should only be removed gradually through calls to reweighTokens.
   */
  function unbind(address token) external;

/* ---  Liquidity Provider Actions  --- */
  /**
   * @dev Mint new pool tokens by providing the proportional amount of each
   * underlying token's balance equal to the proportion of pool tokens minted.
   * For any underlying tokens which are not initialized, the caller must provide
   * the proportional share of the minimum balance for the token rather than the
   * actual balance.
   */
  function joinPool(
    uint256 poolAmountOut,
    uint256[] calldata maxAmountsIn
  ) external;

  /**
   * @dev Pay `tokenAmountIn` of `tokenIn` to mint at least `minPoolAmountOut`
   * pool tokens.
   *
   * The pool implicitly swaps `(1- weightTokenIn) * tokenAmountIn` to the other
   * underlying tokens. Thus a swap fee is charged against the input tokens.
   */
  function joinswapExternAmountIn(
    address tokenIn,
    uint256 tokenAmountIn,
    uint256 minPoolAmountOut
  )
    external
    returns (uint256 poolAmountOut);

  /**
   * @dev Pay up to `maxAmountIn` of `tokenIn` to mint exactly `poolAmountOut`.
   *
   * The pool implicitly swaps `(1- weightTokenIn) * tokenAmountIn` to the other
   * underlying tokens. Thus a swap fee is charged against the input tokens.
   */
  function joinswapPoolAmountOut(
    address tokenIn,
    uint256 poolAmountOut,
    uint256 maxAmountIn
  )
    external
    returns (uint256 tokenAmountIn);

  /**
   * @dev Burns `poolAmountIn` pool tokens in exchange for the amounts of each
   * underlying token's balance proportional to the ratio of tokens burned to
   * total pool supply. The amount of each token transferred to the caller must
   * be greater than or equal to the associated minimum output amount from the
   * `minAmountsOut` array.
   */
  function exitPool(
    uint256 poolAmountIn,
    uint256[] calldata minAmountsOut
  ) external;

  /**
   * @dev Burns `poolAmountIn` pool tokens in exchange for at least `minAmountOut`
   * of `tokenOut`. Returns the number of tokens sent to the caller.
   *
   * The pool implicitly burns the tokens for all underlying tokens and swaps them
   * to the desired output token. A swap fee is charged against the output tokens.
   */
  function exitswapPoolAmountIn(
    address tokenOut,
    uint256 poolAmountIn,
    uint256 minAmountOut
  )
    external
    returns (uint256 tokenAmountOut);

  /**
   * @dev Burn up to `maxPoolAmountIn` for exactly `tokenAmountOut` of `tokenOut`.
   * Returns the number of pool tokens burned.
   *
   * The pool implicitly burns the tokens for all underlying tokens and swaps them
   * to the desired output token. A swap fee is charged against the output tokens.
   */
  function exitswapExternAmountOut(
    address tokenOut,
    uint256 tokenAmountOut,
    uint256 maxPoolAmountIn
  )
    external
    returns (uint256 poolAmountIn);

/* ---  Other  --- */

  /**
   * @dev Absorb any tokens that have been sent to the pool.
   * If the token is not bound, it will be sent to the controller.
   */
  function gulp(address token) external;

/* ---  Flash Loan  --- */

  /**
   * @dev Execute a flash loan, transferring `amount` to `recipient`.
   *
   * @param recipient Must implement the IFlashLoanRecipient interface
   * @param token Token to borrow
   * @param amount Amount to borrow
   * @param data Data to send to the recipient in `receiveFlashLoan` call
   */
  function flashBorrow(
    IFlashLoanRecipient recipient,
    address token,
    uint256 amount,
    bytes calldata data
  )
    external;

/* ---  Token Swaps  --- */

  /**
   * @dev Execute a token swap with a specified amount of input
   * tokens and a minimum amount of output tokens.
   * Note: Will throw if `tokenOut` is uninitialized.
   */
  function swapExactAmountIn(
    address tokenIn,
    uint256 tokenAmountIn,
    address tokenOut,
    uint256 minAmountOut,
    uint256 maxPrice
  )
    external
    returns (uint256 tokenAmountOut, uint256 spotPriceAfter);

  /**
   * @dev Trades at most `maxAmountIn` of `tokenIn` for exactly `tokenAmountOut`
   * of `tokenOut`.
   * Returns the actual input amount and the new spot price after the swap,
   * which can not exceed `maxPrice`.
   */
  function swapExactAmountOut(
    address tokenIn,
    uint256 maxAmountIn,
    address tokenOut,
    uint256 tokenAmountOut,
    uint256 maxPrice
  )
    external
    returns (uint256 tokenAmountIn, uint256 spotPriceAfter);

/* ---  Config Queries  --- */
  /**
   * @dev Check if swapping tokens and joining the pool is allowed.
   */
  function isPublicSwap() external view returns (bool isPublic);

  function getSwapFee() external view returns (uint256 swapFee);

  /**
   * @dev Returns the controller address.
   */
  function getController() external view returns (address controller);

/* ---  Token Queries  --- */
  /**
   * @dev Check if a token is bound to the pool.
   */
  function isBound(address t) external view returns (bool);

  /**
   * @dev Get the number of tokens bound to the pool.
   */
  function getNumTokens() external view returns (uint256 num);

  /**
   * @dev Get all bound tokens.
   */
  function getCurrentTokens()
    external
    view
    returns (address[] memory tokens);

  /**
   * @dev Returns the list of tokens which have a desired weight above 0.
   * Tokens with a desired weight of 0 are set to be phased out of the pool.
   */
  function getCurrentDesiredTokens()
    external
    view
    returns (address[] memory tokens);

  /**
   * @dev Get the denormalized weight of a bound token.
   */
  function getDenormalizedWeight(address token)
    external
    view
    returns (uint256 denorm);

  /**
   * @dev Get the record for a token bound to the pool.
   */
  function getTokenRecord(address token)
    external
    view
    returns (Record memory record);

  /**
   * @dev Finds the first token which is initialized and
   * returns the address of that token and the extrapolated
   * value of the pool in that token.
   * 
   * The value is extrapolated by multiplying the token's
   * balance by the reciprocal of its normalized weight.
   */
  function extrapolatePoolValueFromToken()
    external
    view
    returns (address token, uint256 extrapolatedValue);

  /**
   * @dev Get the total denormalized weight of the pool.
   */
  function getTotalDenormalizedWeight()
    external
    view
    returns (uint256 totalDenorm);

  /**
   * @dev Get the stored balance of a bound token.
   */
  function getBalance(address token)
    external
    view
    returns (uint256 balance);

  /**
   * @dev Get the minimum balance of an uninitialized token.
   * Note: Throws if the token is initialized.
   */
  function getMinimumBalance(address token)
    external
    view
    returns (uint256 minimumBalance);

  /**
   * @dev Get the balance of a token which is used in price
   * calculations. If the token is initialized, this is the
   * stored balance; if not, this is the minimum balance.
   */
  function getUsedBalance(address token)
    external
    view
    returns (uint256 usedBalance);

/* ---  Price Queries  --- */
  /**
   * @dev Get the spot price for `tokenOut` in terms of `tokenIn`.
   */
  function getSpotPrice(address tokenIn, address tokenOut)
    external
    view
    returns (uint256 spotPrice);

  /**
   * @dev Get the spot price for `tokenOut` in terms of `tokenIn` ignoring swap fees.
   */
  function getSpotPriceSansFee(address tokenIn, address tokenOut)
    external
    view
    returns (uint256 spotPrice);

  /**
   * @dev Calculate the amount of `tokenIn` needed to receive
   * `tokenAmountOut` of `tokenOut`.
   */
  function getInGivenOut(
    address tokenIn,
    address tokenOut,
    uint256 tokenAmountOut
  )
    external
    view
    returns (uint256 tokenAmountIn);

  /**
   * @dev Calculate the amount of `tokenOut` which can be
   * received for `tokenAmountIn` of `tokenIn`.
   */
  function getOutGivenIn(
    address tokenIn,
    address tokenOut,
    uint256 tokenAmountIn
  )
    external
    view
    returns (uint256 tokenAmountOut);
}