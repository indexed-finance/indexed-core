// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.0;
import "./ManyToOneImplementationHolder.sol";
import {
  DelegateCallProxyManyToOne
} from "./DelegateCallProxyManyToOne.sol";
import {
  DelegateCallProxyOneToOne
} from "./DelegateCallProxyOneToOne.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";


library SaltyLib {
/* ---  Constants  --- */
  bytes32 internal constant ONE_TO_ONE_CODEHASH = keccak256(
    type(DelegateCallProxyOneToOne).creationCode
  );

  bytes32 internal constant MANY_TO_ONE_CODEHASH = keccak256(
    type(DelegateCallProxyManyToOne).creationCode
  );

  bytes32 internal constant IMPLEMENTATION_HOLDER_CODEHASH = keccak256(
    type(ManyToOneImplementationHolder).creationCode
  );

/* ---  Salt Derivation  --- */

  /**
   * @dev Derives the create2 salt for a many-to-one proxy.
   *
   * Many different contracts in the Indexed framework may use the
   * same implementation contract, and they all use the same init
   * code, so we derive the actual create2 salt from a combination
   * of the implementation ID, the address of the account requesting
   * deployment and the user-supplied salt.
   *
   * @param originator Address of the account requesting deployment.
   * @param implementationID The identifier for the contract implementation.
   * @param suppliedSalt Salt provided by the account requesting deployment.
   */
  function deriveManyToOneSalt(
    address originator,
    bytes32 implementationID,
    bytes32 suppliedSalt
  )
    internal
    pure
    returns (bytes32)
  {
    return keccak256(
      abi.encodePacked(
        originator,
        implementationID,
        suppliedSalt
      )
    );
  }

  /**
   * @dev Derives the create2 salt for a one-to-one proxy.
   *
   * @param originator Address of the account requesting deployment.
   * @param suppliedSalt Salt provided by the account requesting deployment.
   */
  function deriveOneToOneSalt(
    address originator,
    bytes32 suppliedSalt
  )
    internal
    pure
    returns (bytes32)
  {
    return keccak256(abi.encodePacked(originator, suppliedSalt));
  }

/* ---  Address Derivation  --- */

  /**
   * @dev Computes the create2 address for a one-to-one proxy deployed
   * by `deployer` (the factory) when requested by `originator` using
   * `suppliedSalt`.
   *
   * @param deployer Address of the proxy factory.
   * @param originator Address of the account requesting deployment.
   * @param suppliedSalt Salt provided by the account requesting deployment.
   */
  function computeProxyAddressOneToOne(
    address deployer,
    address originator,
    bytes32 suppliedSalt
  )
    internal
    pure
    returns (address)
  {
    bytes32 salt = deriveOneToOneSalt(originator, suppliedSalt);
    return Create2.computeAddress(salt, ONE_TO_ONE_CODEHASH, deployer);
  }

  /**
   * @dev Computes the create2 address for a many-to-one proxy for the
   * implementation `implementationID` deployed by `deployer` (the factory)
   * when requested by `originator` using `suppliedSalt`.
   *
   * @param deployer Address of the proxy factory.
   * @param originator Address of the account requesting deployment.
   * @param implementationID The identifier for the contract implementation.
   * @param suppliedSalt Salt provided by the account requesting deployment.
  */
  function computeProxyAddressManyToOne(
    address deployer,
    address originator,
    bytes32 implementationID,
    bytes32 suppliedSalt
  )
    internal
    pure
    returns (address)
  {
    bytes32 salt = deriveManyToOneSalt(
      originator,
      implementationID,
      suppliedSalt
    );
    return Create2.computeAddress(salt, MANY_TO_ONE_CODEHASH, deployer);
  }

  /**
   * @dev Computes the create2 address of the implementation holder
   * for `implementationID`.
   *
   * @param deployer Address of the proxy factory.
   * @param implementationID The identifier for the contract implementation.
  */
  function computeHolderAddressManyToOne(
    address deployer,
    bytes32 implementationID
  )
    internal
    pure
    returns (address)
  {
    return Create2.computeAddress(
      implementationID,
      IMPLEMENTATION_HOLDER_CODEHASH,
      deployer
    );
  }
}