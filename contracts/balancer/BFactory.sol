// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.0;

// Builds new BPools, logging their addresses and providing `isBPool(address) -> (bool)`

import "./BPool.sol";
import "../lib/ProxyLib.sol";


contract BFactory is BBronze {
  event LOG_NEW_POOL(address indexed caller, address indexed pool);

  event LOG_BLABS(address indexed caller, address indexed blabs);

  mapping(address => bool) private _isBPool;

  function isBPool(address b) external view returns (bool) {
    return _isBPool[b];
  }

  function newBPool(
    uint256 categoryID,
    uint256 indexSize,
    string calldata name,
    string calldata symbol
  ) external returns (BPool) {
    bytes32 salt = keccak256(abi.encodePacked(categoryID, indexSize));
    address bpoolAddress = ProxyLib.deployProxy(_poolContract, salt);
    BPool bpool = BPool(bpoolAddress);
    bpool.initialize(
      msg.sender,
      name,
      symbol
    );
    _isBPool[bpoolAddress] = true;
    emit LOG_NEW_POOL(msg.sender, bpoolAddress);
    return bpool;
  }

  address private _blabs;
  address private _poolContract;

  constructor() public {
    _blabs = msg.sender;
    _poolContract = address(new BPool());
  }

  function getBLabs() external view returns (address) {
    return _blabs;
  }

  function setBLabs(address b) external {
    require(msg.sender == _blabs, "ERR_NOT_BLABS");
    emit LOG_BLABS(msg.sender, b);
    _blabs = b;
  }

  function collect(BPool pool) external {
    require(msg.sender == _blabs, "ERR_NOT_BLABS");
    uint256 collected = IERC20(pool).balanceOf(address(this));
    bool xfer = pool.transfer(_blabs, collected);
    require(xfer, "ERR_ERC20_FAILED");
  }
}
