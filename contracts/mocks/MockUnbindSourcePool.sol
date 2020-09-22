pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;
import "../interfaces/IERC20.sol";


/**
 * @dev Mock contract for testing the unbound token sale functionality.
 */
contract MockUnbindSourcePool {

  event NewTokensToSell(
    address indexed token,
    uint256 amountReceived
  );

  struct Record {
    bool bound;
    bool ready;
    uint40 lastDenormUpdate;
    uint96 denorm;
    uint96 desiredDenorm;
    uint8 index;
    uint256 balance;
  }

  TokenUnbindHandler internal _unbindHandler;
  mapping(address => Record) internal _records;

  constructor(address unbindHandler) public {
    _unbindHandler = TokenUnbindHandler(unbindHandler);
  }

  function getTokenRecord(address token)
    external
    view
    returns (Record memory record)
  {
    record = _records[token];
    require(record.bound, "ERR_NOT_BOUND");
  }

  function addToken(
    address token,
    uint96 desiredDenorm,
    uint256 balance
  ) external {
    _records[token] = Record(
      true,
      true,
      0,
      desiredDenorm,
      desiredDenorm,
      0,
      balance
    );
    IERC20(token).transferFrom(msg.sender, address(this), balance);
  }

  function gulp(address token) external {
    uint256 bal = IERC20(token).balanceOf(address(this));
    _records[token].balance = bal;
  }

  function unbind(address token) external {
    uint256 balance = _records[token].balance;
    _records[token] = Record(false, false, 0, 0, 0, 0, 0);
    IERC20(token).transfer(address(_unbindHandler), balance);
    _unbindHandler.handleUnbindToken(token, balance);
  }
}


interface TokenUnbindHandler {
  event NewTokensToSell(
    address indexed token,
    uint256 amountReceived
  );
  /**
   * @dev Receive `amount` of `token` from the pool.
   */
  function handleUnbindToken(address token, uint256 amount) external;
}