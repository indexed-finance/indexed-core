pragma solidity ^0.6.0;

import "../../proxies/DelegateCallProxyManager.sol";
import { SaltyLib as Salty } from "../../proxies/SaltyLib.sol";
import "./util/TestOrder.sol";
import "@nomiclabs/buidler/console.sol";


contract MockProxyLogic1 {
  uint256 internal _value = 0;

  function incrementValue() external {
    _value += 1;
  }

  function decrementValue() external {
    _value -= 1;
  }

  function getValue() external view returns (uint) {
    return _value;
  }
}


contract MockProxyLogic2 {
  uint256 internal _value = 0;

  function incrementValue() external {
    _value += 2;
  }

  function decrementValue() external {
    _value -= 2;
  }

  function getValue() external view returns (uint) {
    return _value;
  }
}


contract ApprovalTest {
  bytes32 internal constant TEST_IMPLEMENTATION_ID = keccak256("ProxyLogic.sol");
  function deploy(DelegateCallProxyManager manager, bytes32 salt) external returns (address proxyAddress) {
    return manager.deployProxyManyToOne(TEST_IMPLEMENTATION_ID, salt);
  }
}


contract ErroneousHolder1 {
  fallback() external payable {
    bytes memory errorMsg = "CUSTOM_HOLDER_REVERT_MSG";
    assembly { revert(add(errorMsg, 32), mload(errorMsg)) }
  }
}


contract ErroneousHolder2 {
  fallback() external payable {
    bytes memory retMsg = abi.encode(address(0));
    assembly { return(add(retMsg, 32), mload(retMsg)) }
  }
}


contract ProxyTest is TestOrder {
  bytes32 internal constant TEST_IMPLEMENTATION_ID = keccak256("ProxyLogic.sol");
  DelegateCallProxyManager public manager;
  ApprovalTest internal _approvalTest;
  MockProxyLogic1 implementation1;
  MockProxyLogic2 implementation2;
  address proxyAddressMT1;
  address proxyAddress1T1;
  ErroneousHolder1 errorHolder1;
  ErroneousHolder2 errorHolder2;

  constructor() public {
    manager = new DelegateCallProxyManager();
    _approvalTest = new ApprovalTest();
    implementation1 = new MockProxyLogic1();
    implementation2 = new MockProxyLogic2();
  }

  function test_deployInvalidImplementation() external testIndex(0) {
    console.log("� Unrecognized implementation deployment");
    try manager.deployProxyManyToOne(TEST_IMPLEMENTATION_ID, keccak256("Salt1")) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_IMPLEMENTATION_ID"),
        "Error: Expected ERR_IMPLEMENTATION_ID error message."
      );
    }
    console.log("     ✓ Fails to deploy proxy for unrecognized implementation.");
  }

  function test_createManyToOneProxyRelationship() external testIndex(1) {
    console.log("🔗 Many-to-one relationship creation");
    manager.createManyToOneProxyRelationship(TEST_IMPLEMENTATION_ID, address(implementation1));
    console.log("     ✓ Creates a many-to-one relationship.");
    address implHolder = manager.getImplementationHolder(TEST_IMPLEMENTATION_ID);
    console.log("     ✓ Queries the implementation holder address.");
    require(
      implHolder == manager.computeHolderAddressManyToOne(TEST_IMPLEMENTATION_ID),
      "Error: Unexpected implementation holder address returned by proxy manager."
    );
    console.log("     ✓ Manager computes the correct holder address.");
    require(
      implHolder == Salty.computeHolderAddressManyToOne(address(manager), TEST_IMPLEMENTATION_ID),
      "Error: Unexpected implementation holder address returned by Salty."
    );
    console.log("     ✓ Salty computes the correct holder address.");
    (bool success, bytes memory data) = implHolder.call("");
    require(success, "Error: Failed to query implementation address.");
    require(
      abi.decode((data), (address)) == address(implementation1),
      "Error: Implementation holder returned unexpected implementation address."
    );
    console.log("     ✓ Implementation holder returns the correct implementation.");
  }

  function test_unapprovedDeployer() external testIndex(2) {
    console.log("🚫 Unapproved deployment");
    try _approvalTest.deploy(manager, keccak256("Salt1")) {
      revert("Expected error");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_APPROVED"),
        "Error: Expected ERR_NOT_APPROVED error message."
      );
    }
    console.log("     ✓ Unapproved deployment fails.");
  }

  function test_approveDeployer() external testIndex(3) {
    console.log("🔓 Deployer approval");
    manager.approveDeployer(address(_approvalTest));
    console.log("     ✓ Approves deployer.");
    require(
      manager.isApprovedDeployer(address(_approvalTest)),
      "Error: Deployer not approved."
    );
    console.log("     ✓ Manager shows deployer as approved.");
  }

  function test_deployProxyManyToOne() external testIndex(4) {
    console.log("🆕 Many-to-one proxy deployment");
    proxyAddressMT1 = _approvalTest.deploy(manager, keccak256("Salt1"));
    console.log("     ✓ Deploys a many-to-one proxy with the approved contract.");
    require(
      proxyAddressMT1 == Salty.computeProxyAddressManyToOne(
        address(manager),
        address(_approvalTest),
        TEST_IMPLEMENTATION_ID,
        keccak256("Salt1")
      ),
      "Error: Unexpected proxy address returned by Salty."
    );
    console.log("     ✓ Salty computes the correct address.");
    require(
      proxyAddressMT1 == manager.computeProxyAddressManyToOne(
        address(_approvalTest),
        TEST_IMPLEMENTATION_ID,
        keccak256("Salt1")
      ),
      "Error: Unexpected proxy address returned by manager."
    );
    console.log("     ✓ Manager computes the correct address.");
    MockProxyLogic1 proxy = MockProxyLogic1(proxyAddressMT1);
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    proxy.incrementValue();
    require(proxy.getValue() == 1, "Error: Expected proxy to return 1 for stored value.");
    proxy.decrementValue();
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    console.log("     ✓ Proxy forwards calls to upgraded implementation.");
  }

  function test_revokeDeployerApproval() external testIndex(5) {
    console.log("🔐 Approval revocation");
    manager.revokeDeployerApproval(address(_approvalTest));
    console.log("     ✓ Revokes deployer approval.");
    try _approvalTest.deploy(manager, keccak256("Salt2")) {
      revert("Expected error");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_APPROVED"),
        "Error: Expected ERR_NOT_APPROVED error message."
      );
    }
    console.log("     ✓ Unapproved deployer fails to deploy proxy.");
  }

  function test_setImplementationAddressManyToOne() external testIndex(6) {
    console.log("⏫ Many-to-one proxy implementation upgrade");
    try manager.setImplementationAddressManyToOne(bytes32(0), address(0)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_IMPLEMENTATION_ID"),
        "Error: Expected ERR_IMPLEMENTATION_ID error message."
      );
    }
    console.log("     ✓ Fails to set implementation for unrecognized ID.");
    try manager.setImplementationAddressManyToOne(TEST_IMPLEMENTATION_ID, address(0)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_CONTRACT"),
        "Error: Expected ERR_NOT_CONTRACT error message."
      );
    }
    console.log("     ✓ Fails to set non-contract implementation.");
    manager.setImplementationAddressManyToOne(TEST_IMPLEMENTATION_ID, address(implementation2));
    console.log("     ✓ Updates proxy implementation.");
    MockProxyLogic2 proxy = MockProxyLogic2(proxyAddressMT1);
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    proxy.incrementValue();
    require(proxy.getValue() == 2, "Error: Expected proxy to return 2 for stored value.");
    proxy.decrementValue();
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    console.log("     ✓ Proxy forwards calls to upgraded implementation.");
  }

  function test_deployProxyOneToOne() external testIndex(7) {
    console.log("🆕 One-to-one proxy deployment");
    proxyAddress1T1 = manager.deployProxyOneToOne(
      keccak256("Salty"), address(implementation1)
    );
    console.log("     ✓ Deploys a one-to-one proxy.");
    require(
      proxyAddress1T1 == Salty.computeProxyAddressOneToOne(
        address(manager),
        address(this),
        keccak256("Salty")
      ),
      "Error: Unexpected proxy address."
    );
    console.log("     ✓ Salty computes correct address.");
    require(
      proxyAddress1T1 == manager.computeProxyAddressOneToOne(
        address(this),
        keccak256("Salty")
      ),
      "Error: Unexpected proxy address."
    );
    console.log("     ✓ Manager computes correct address.");
    MockProxyLogic1 proxy = MockProxyLogic1(proxyAddress1T1);
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    proxy.incrementValue();
    require(proxy.getValue() == 1, "Error: Expected proxy to return 1 for stored value.");
    proxy.decrementValue();
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    console.log("     ✓ Proxy forwards calls to implementation.");
  }

  function test_setImplementationAddressOneToOne() external testIndex(8) {
    console.log("🔼 One-to-one proxy implementation upgrade");
    try manager.setImplementationAddressOneToOne(proxyAddress1T1, address(0)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_CONTRACT"),
        "Error: Expected ERR_NOT_CONTRACT error message."
      );
    }
    console.log("    ✓ Fails to set non-contract implementation.");
    try manager.setImplementationAddressOneToOne(address(this), address(this)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_SET_ADDRESS_REVERT"),
        "Error: Expected ERR_SET_ADDRESS_REVERT error message."
      );
    }
    console.log("    ✓ Reverts on call to non-proxy.");
    manager.setImplementationAddressOneToOne(proxyAddress1T1, address(implementation2));
    console.log("    ✓ Updates proxy implementation.");
    MockProxyLogic2 proxy = MockProxyLogic2(proxyAddress1T1);
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    proxy.incrementValue();
    require(proxy.getValue() == 2, "Error: Expected proxy to return 2 for stored value.");
    proxy.decrementValue();
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    console.log("    ✓ Proxy forwards calls to upgraded implementation.");
  }

  function test_setOwner() external testIndex(9) {
    console.log("👑 Ownership transferral");
    try manager.setOwner(address(0)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NULL_ADDRESS"),
        "Error: Expected ERR_NULL_ADDRESS error message."
      );
    }
    console.log("     ✓ Fails to transfer ownership to null address.");
    manager.setOwner(address(32));
    console.log("     ✓ Transfers ownership to non-null address.");
    require(address(32) == manager.getOwner(), "Error: Manager returned unexpected owner address.");
    console.log("     ✓ Returns updated owner address.");
  }

  function test_badImplementationHolder() external testIndex(10) {
    console.log("🔥 Proxy failure conditions");
    errorHolder1 = new ErroneousHolder1();
    address proxy = address(new DelegateCallProxyManyToOne());
    // "Error: Bad implementation holder."
    try MockProxyLogic2(proxy).getValue() {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("CUSTOM_HOLDER_REVERT_MSG"),
        "Error: Expected CUSTOM_HOLDER_REVERT_MSG error message."
      );
    }
    console.log("     ✓ Returns the revert message if the call to the holder fails.");
    errorHolder2 = new ErroneousHolder2();
    proxy = address(new DelegateCallProxyManyToOne());
    try MockProxyLogic2(proxy).getValue() {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NULL_IMPLEMENTATION"),
        "Error: Expected ERR_NULL_IMPLEMENTATION error message."
      );
    }
    console.log("     ✓ Reverts if the holder returns a null address.");
  }

  function test_onlyOwner() external testIndex(11) {
    console.log("🔒 Owner restrictions");
    try manager.approveDeployer(address(this)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_OWNER"),
        "Error: Expected ERR_NOT_OWNER error message."
      );
    }
    console.log("     ✓ approveDeployer(): Reverts when called by non-owner.");

    try manager.revokeDeployerApproval(address(0)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_OWNER"),
        "Error: Expected ERR_NOT_OWNER error message."
      );
    }
    console.log("     ✓ revokeDeployerApproval(): Reverts when called by non-owner.");

    try manager.deployProxyOneToOne(keccak256("Salty"), address(implementation1)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_OWNER"),
        "Error: Expected ERR_NOT_OWNER error message."
      );
    }
    console.log("     ✓ deployProxyOneToOne(): Reverts when called by non-owner.");

    try manager.createManyToOneProxyRelationship(keccak256("Salty"), address(implementation1)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_OWNER"),
        "Error: Expected ERR_NOT_OWNER error message."
      );
    }
    console.log("     ✓ createManyToOneProxyRelationship(): Reverts when called by non-owner.");

    try manager.setImplementationAddressOneToOne(proxyAddress1T1, address(implementation2)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_OWNER"),
        "Error: Expected ERR_NOT_OWNER error message."
      );
    }
    console.log("     ✓ setImplementationAddressOneToOne(): Reverts when called by non-owner.");

    try manager.setImplementationAddressManyToOne(bytes32(0), address(implementation2)) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_OWNER"),
        "Error: Expected ERR_NOT_OWNER error message."
      );
    }
    console.log("     ✓ setImplementationAddressManyToOne(): Reverts when called by non-owner.");
  }

  function getImplementationHolder() external view returns(address) {
    if (address(errorHolder2) != address(0)) return address(errorHolder2);
    return address(errorHolder1);
  }
}