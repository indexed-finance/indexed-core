pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./MarketOracle.sol";
import "./lib/Babylonian.sol";
import "./lib/FixedPoint.sol";
import "./interfaces/IERC20.sol";
import "./openzeppelin/BaseERC20.sol";
import "./lib/IndexLibrary.sol";

contract IndexFund is BaseERC20 {
  using Babylonian for uint256;
  using FixedPoint for FixedPoint.uq112x112;
  using FixedPoint for FixedPoint.uq144x112;

  // Maximum value of a 112 bit uint.
  uint256 constant MAX_UINT112 = 2**112 - 1;

  uint256 public immutable indexSize;
  address[] public indexedTokens;
  MarketOracle public oracle;

  /**
   * @dev Initialize the index fund and the ERC20 details.
   * Assigns the initial set of indexed tokens and calculates their weights.
   * This will also determine the initial ratio between underlying tokens and
   * indexed tokens.
   * The `firstTokenAmount` will be used to calculate the initial total value
   * by multiplying the price of the first token by `firstTokenAmount`, then
   * multiplying by the inverse of the first token weight. The balance for
   * the other tokens will then be calculated using the total value.
   * @param name ERC20 name, should indicate the index size and type,
   * e.g. StableCoin5 for the top 5 stable coins.
   * @param symbol ERC20 symbol, e.g. SC5 for StableCoin5
   * @param initialTokens Initial array of indexed tokens
   * @param firstTokenAmount Amount of first token to transfer
   * @param initialSupply Amount of index tokens to mint
   */
  constructor(
    string memory name,
    string memory symbol,
    address[] memory initialTokens,
    uint256 firstTokenAmount,
    uint256 initialSupply
  ) public BaseERC20(name, symbol) {
    // Verify the index size is usable
    uint256 _indexSize = initialTokens.length;
    indexSize = _indexSize;
    require(
      _indexSize > 0 && _indexSize <= 20,
      "Index size must be 0-20"
    );
    // Assign the market oracle address
    oracle = MarketOracle(msg.sender);
    _init(_indexSize, initialTokens, firstTokenAmount, initialSupply);
  }

  /**
   * @dev Mints new index tokens by transferring `amount/totalSupply` of the current balance
   * of each indexed token from the caller to the index fund.
   * Note: Throws if the new `totalSupply` exceeds 2**112 - 1
   * TODO: Figure out how this should work if the total supply is 0 (all tokens burned),
   * currently the burn function just does not allow all tokens to be burned.
   */
  function mint(uint112 amount) public {
    FixedPoint.uq112x112 memory fraction = FixedPoint.fraction(
      amount, uint112(_totalSupply)
    );
    uint256 len = indexSize;
    for (uint256 i = 0; i < len; i++) {
      address token = indexedTokens[i];
      uint144 proportionalBalance = _proportionalBalanceOf(token, fraction);
      _safeTransferFrom(token, msg.sender, proportionalBalance);
    }
    // TODO examine reentrancy potential
    _mint(msg.sender, amount);
  }

  /**
   * @dev Burns index tokens owned by the caller and transfers `amount/totalSupply` of
   * the current balance of each indexed token to the caller.
   * Note: Throws if `amount` is equal to `totalSupply`
   */
  function burn(uint112 amount) public {
    FixedPoint.uq112x112 memory fraction = FixedPoint.fraction(
      amount, uint112(_totalSupply)
    );
    uint256 len = indexSize;
    for (uint256 i = 0; i < len; i++) {
      address token = indexedTokens[i];
      uint144 proportionalBalance = _proportionalBalanceOf(token, fraction);
      _safeTransfer(token, msg.sender, proportionalBalance);
    }
    // TODO examine reentrancy potential
    _burn(msg.sender, amount);
  }

  function _proportionalBalanceOf(address token, FixedPoint.uq112x112 memory fraction)
  internal view returns (uint144 proportionalBalance) {
    proportionalBalance = fraction.mul(
      IERC20(token).balanceOf(address(this))
    ).decode144();
  }

  function _init(
    uint256 _indexSize,
    address[] memory initialTokens,
    uint256 firstTokenAmount,
    uint256 initialSupply
  ) internal {
    // Push the initial tokens & size the array
    for (uint256 i = 0; i < _indexSize; i++) indexedTokens.push(initialTokens[i]);
    // Query the average prices
    FixedPoint.uq112x112[] memory averagePrices = oracle.computeAveragePrices(initialTokens);
    // Get the token weights
    FixedPoint.uq112x112[] memory weights = IndexLibrary.computeTokenWeights(initialTokens, averagePrices);
    // Transfer the first token
    _safeTransferFrom(initialTokens[0], msg.sender, firstTokenAmount);
    // First token value = amount * price
    uint144 firstTokenValue = averagePrices[0].mul(firstTokenAmount).decode144();
    // Weight of first token is fraction of total value. Multiply the reciprocal of the
    // weight by the value of the first token to get the total value expected.
    FixedPoint.uq112x112 memory reciprocalFirstWeight = weights[0].reciprocal();
    uint144 totalValue = reciprocalFirstWeight.mul(firstTokenValue).decode144();
    for (uint256 i = 1; i < _indexSize; i++) {
      uint144 desiredBalance = IndexLibrary.computeWeightedBalance(
        totalValue,
        weights[i],
        averagePrices[i]
      );
      _safeTransferFrom(initialTokens[i], msg.sender, desiredBalance);
    }
    _mint(msg.sender, initialSupply);
    
  }

  /**
   * @dev Creates `amount` tokens and assigns them to `account`, increasing
   * the total supply.
   * Emits a {Transfer} event with `from` set to the zero address.
   *
   * Requirements:
   * - `to` cannot be the zero address.
   * - `totalSupply` can not exceed 2**112 - 1.
   */
  function _mint(address account, uint256 amount) internal virtual {
    require(account != address(0), "ERC20: mint to the zero address");
    uint256 newSupply = _totalSupply.add(amount);
    require(newSupply <= MAX_UINT112, "Supply can not exceed 2**112 - 1");
    _totalSupply = newSupply;
    _balances[account] = _balances[account].add(amount);
    emit Transfer(address(0), account, amount);
  }

  /**
   * @dev Destroys `amount` tokens from `account`, reducing the
   * total supply.
   * Emits a {Transfer} event with `to` set to the zero address.
   *
   * Requirements
   * - `amount` can not be the entire token suppply.
   * - `account` cannot be the zero address.
   * - `account` must have at least `amount` tokens.
   */
  function _burn(address account, uint256 amount) internal virtual {
    require(account != address(0), "ERC20: burn from the zero address");

    _balances[account] = _balances[account].sub(amount, "ERC20: burn amount exceeds balance");
    uint256 newSupply = _totalSupply.sub(amount);
    require(newSupply > 0, "Can not burn all index tokens.");
    _totalSupply = newSupply;
    emit Transfer(account, address(0), amount);
  }

  /**
   * @dev Transfers `amount` of `token` from `from` to index fund.
   * Throws if the transfer fails.
   */
  function _safeTransferFrom(address token, address from, uint256 amount) internal {
    require(
      IERC20(token).transferFrom(
        from, address(this), amount
      ),
      "Transfer failed."
    );
  }

  /**
   * @dev Transfers `amount` of `token` to `to`.
   * Throws if the transfer fails.
   */
  function _safeTransfer(address token, address to, uint256 amount) internal {
    require(
      IERC20(token).transfer(to, amount),
      "Transfer failed."
    );
  }

  function _getAveragePrices() internal view returns (FixedPoint.uq112x112[] memory) {
    return oracle.computeAveragePrices(indexedTokens);
  }
}