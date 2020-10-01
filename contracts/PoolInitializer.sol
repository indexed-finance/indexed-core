// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import { IPool } from "./balancer/IPool.sol";
import { UniSwapV2PriceOracle } from "./UniSwapV2PriceOracle.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";


/**
 * @title PoolInitializer
 * @author d1ll0n
 * @dev Contract that acquires the initial balances for an index pool.
 *
 * This uses a short-term UniSwap price oracle to determine the ether
 * value of tokens sent to the contract. When users contribute tokens,
 * they are credited for the moving average ether value of said tokens.
 * When all the tokens needed are acquired, the index pool will be
 * initialized and this contract will receive the initial token supply (100).
 *
 * Once the contract receives the index pool tokens, users can claim their
 * share of the tokens proportional to their credited contribution value.
 */
contract PoolInitializer {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

/* ---  Constants  --- */

  address internal immutable _controller;
  UniSwapV2PriceOracle internal immutable _oracle;

/* ---  Events  --- */

  event TokensContributed(
    address from,
    address token,
    uint256 amount,
    uint256 credit
  );

/* ---  Storage  --- */
  // Token amounts to purchase
  mapping(address => uint256) internal _remainingDesiredAmounts;
  // Value contributed in ether
  mapping(address => uint256) internal _credits;
  address[] internal _tokens;
  // Total value in ether contributed to the pool, computed at the time
  // of receipt.
  uint256 internal _totalCredit;
  // Whether all the desired tokens have been received.
  bool internal _finished;
  address internal _poolAddress;
  bool internal _mutex;
  uint256 internal constant TOKENS_MINTED = 1e20;

/* ---  Modifiers  --- */

  modifier _lock_ {
    require(!_mutex, "ERR_REENTRY");
    _mutex = true;
    _;
    _mutex = false;
  }

  modifier _control_ {
    require(msg.sender == _controller, "ERR_NOT_CONTROLLER");
    _;
  }

  modifier _finished_ {
    require(_finished, "ERR_NOT_FINISHED");
    _;
  }

  modifier _not_finished_ {
    require(!_finished, "ERR_FINISHED");
    _;
  }

/* ---  Constructor  --- */

  constructor(
    UniSwapV2PriceOracle oracle,
    address controller
  ) public {
    _oracle = oracle;
    _controller = controller;
  }

/* ---  Start & Finish Functions  --- */

  /**
   * @dev Sets up the pre-deployment pool.
   *
   * @param poolAddress Address of the pool this pre-deployment pool is for
   * @param tokens Array of desired tokens
   * @param amounts Desired amounts of the corresponding `tokens`
   */
  function initialize(
    address poolAddress,
    address[] calldata tokens,
    uint256[] calldata amounts
  )
    external
    _control_
  {
    require(_poolAddress == address(0), "ERR_INITIALIZED");
    _poolAddress = poolAddress;
    uint256 len = tokens.length;
    require(amounts.length == len, "ERR_ARR_LEN");
    _tokens = tokens;
    for (uint256 i = 0; i < len; i++) {
      _remainingDesiredAmounts[tokens[i]] = amounts[i];
    }
  }

  /**
   * @dev Finishes the pre-deployment pool and triggers pool initialization.
   *
   * Note: The desired amounts of all tokens must be 0.
  */
  function finish()
    external
    _lock_
    _not_finished_
  {
    uint256 len = _tokens.length;
    address controller = _controller;
    address[] memory tokens = new address[](len);
    uint256[] memory balances = new uint256[](len);
    for (uint256 i = 0; i < len; i++) {
      address token = _tokens[i];
      tokens[i] = token;
      uint256 balance = IERC20(token).balanceOf(address(this));
      balances[i] = balance;
      IERC20(token).safeApprove(_poolAddress, balance);
      require(
        _remainingDesiredAmounts[token] == 0,
        "ERR_PENDING_TOKENS"
      );
    }
    PoolController(controller).finishPreparedIndexPool(
      _poolAddress,
      tokens,
      balances
    );
    _finished = true;
  }

/* ---  Pool Token Claims  --- */

  /**
   * @dev Claims the tokens owed to `msg.sender` based on their proportion
   * of the total credits.
  */
  function claimTokens() external _lock_ _finished_ {
    _claimTokens(msg.sender);
  }

  /**
   * @dev Claims the tokens owed to `account` based on their proportion
   * of the total credits.
  */
  function claimTokens(address account) external _lock_ _finished_ {
    _claimTokens(account);
  }

  /**
   * @dev Claims the tokens owed to `account` based on their proportion
   * of the total credits.
  */
  function claimTokens(address[] calldata accounts) external _lock_ _finished_ {
    for (uint256 i = 0; i < accounts.length; i++) {
      _claimTokens(accounts[i]);
    }
  }

/* ---  Contribution  --- */

  /**
   * @dev Contribute up to `amountIn` of `token` to the pool for credit.
   * The caller will be credited for the average weth value of the provided
   * tokens.
   *
   * Caller must receive at least `minimumCredit` to not revert.
   *
   * If `amountIn` is greater than the desired amount of `token`, the
   * desired amount will be used instead. 
   */
  function contributeTokens(
    address token,
    uint256 amountIn,
    uint256 minimumCredit
  )
    external
    _lock_
    _not_finished_
    returns (uint256 credit)
  {
    uint256 desiredAmount = _remainingDesiredAmounts[token];
    require(desiredAmount > 0, "ERR_NOT_NEEDED");
    if (amountIn > desiredAmount) {
      amountIn = desiredAmount;
    }
    credit = _oracle.computeAverageAmountOut(token, amountIn);
    require(credit > 0 && amountIn > 0, "ERR_ZERO_AMOUNT");
    require(credit >= minimumCredit, "ERR_MIN_CREDIT");
    IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
    _remainingDesiredAmounts[token] = desiredAmount.sub(amountIn);
    _credits[msg.sender] = _credits[msg.sender].add(credit);
    _totalCredit = _totalCredit.add(credit);
    emit TokensContributed(msg.sender, token, amountIn, credit);
  }

  /**
   * @dev Contribute maximum values from `amountsIn` of the corresponding
   * tokens in `tokens` to the pool for credit.
   *
   * The caller will be credited for the average weth value of the provided
   * tokens.
   *
   * Caller must receive at least `minimumCredit` to not revert.
   *
   * If any input amount is greater than the desired amount of the corresponding
   * token, the desired amount will be used instead.
   */
  function contributeTokens(
    address[] calldata tokens,
    uint256[] calldata amountsIn,
    uint256 minimumCredit
  )
    external
    _lock_
    _not_finished_
    returns (uint256 credit)
  {
    uint256 len = tokens.length;
    require(amountsIn.length == len, "ERR_ARR_LEN");
    credit = 0;
    for (uint256 i = 0; i < len; i++) {
      address token = tokens[i];
      uint256 amountIn = amountsIn[i];
      uint256 desiredAmount = _remainingDesiredAmounts[token];
      require(desiredAmount > 0, "ERR_NOT_NEEDED");
      if (amountIn > desiredAmount) {
        amountIn = desiredAmount;
      }
      uint256 creditOut = _oracle.computeAverageAmountOut(token, amountIn);
      require(creditOut > 0 && amountIn > 0, "ERR_ZERO_AMOUNT");
      IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
      _remainingDesiredAmounts[token] = desiredAmount.sub(amountIn);
      credit = credit.add(creditOut);
      emit TokensContributed(msg.sender, token, amountIn, creditOut);
    }
    require(credit >= minimumCredit, "ERR_MIN_CREDIT");
    _credits[msg.sender] = _credits[msg.sender].add(credit);
    _totalCredit = _totalCredit.add(credit);
  }

/* ---  Price Actions  --- */

  /**
   * @dev Updates the prices of all tokens.
   */
  function updatePrices() external {
    _oracle.updatePrices(_tokens);
  }

/* ---  Status Queries  --- */

  /**
   * @dev Returns whether the pool has been initialized.
   */
  function isFinished() external view returns (bool) {
    return _finished;
  }

/* ---  Status Queries  --- */

  /**
   * @dev Returns the total value credited for token contributions.
   */
  function getTotalCredit() external view returns (uint256) {
    return _totalCredit;
  }

  /**
   * @dev Returns the amount of credit owed to `account`.
   */
  function getCreditOf(address account)
    external
    view
    returns (uint256)
  {
    return _credits[account];
  }

/* ---  Token Queries  --- */

  function getDesiredTokens()
    external
    view
    returns (address[] memory tokens)
  {
    tokens = _tokens;
  }

  function getDesiredAmount(address token)
    external
    view
    returns (uint256)
  {
    return _remainingDesiredAmounts[token];
  }

  function getDesiredAmounts(address[] calldata tokens)
    external
    view
    returns (uint256[] memory amounts)
  {
    amounts = new uint256[](tokens.length);
    for (uint256 i = 0; i < tokens.length; i++) {
      amounts[i] = _remainingDesiredAmounts[tokens[i]];
    }
  }

/* ---  External Price Queries --- */
  /**
   * @dev Get the amount of WETH the contract will credit a user
   * for providing `amountIn` of `token`.
   *
   * Note: If `amountIn` is greater than the desired amount of
   * `token`, this will calculate the output using the desired
   * amount instead of `amountIn`.
   */
  function getCreditForTokens(address token, uint256 amountIn)
    external
    view
    returns (uint144 amountOut)
  {
    uint256 desiredAmount = _remainingDesiredAmounts[token];
    require(desiredAmount > 0, "ERR_NOT_NEEDED");
    if (amountIn > desiredAmount) {
      amountIn = desiredAmount;
    }
    uint144 averageWethValue = _oracle.computeAverageAmountOut(token, amountIn);
    amountOut = averageWethValue;
  }

/* ---  Internal Claims Functions  --- */

  /**
   * @dev Claims pool tokens owed to `account` based on their
   * proportion of the total credit.
   * Note: Must be called in a function with the `_finished` modifier.
   * Note: Must be called in a function with the `_lock_` modifier.
   */
  function _claimTokens(address account) internal {
    uint256 credit = _credits[account];
    require(credit > 0, "ERR_NULL_CREDIT");
    uint256 amountOut = (TOKENS_MINTED.mul(credit)).div(_totalCredit);
    _credits[account] = 0;
    IERC20(_poolAddress).safeTransfer(account, amountOut);
  }
}


interface PoolController {
  function finishPreparedIndexPool(
    address poolAddress,
    address[] calldata tokens,
    uint256[] calldata balances
  ) external;
}