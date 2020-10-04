pragma solidity ^0.6.0;

import "../../proxies/DelegateCallProxyManager.sol";
import { SaltyLib as Salty } from "../../proxies/SaltyLib.sol";
import "./util/TestOrder.sol";


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


contract ProxyTest is TestOrder {
  bytes32 internal constant TEST_IMPLEMENTATION_ID = keccak256("ProxyLogic.sol");
  DelegateCallProxyManager public manager;
  ApprovalTest internal _approvalTest;
  MockProxyLogic1 implementation1;
  MockProxyLogic2 implementation2;
  address proxyAddressMT1;
  address proxyAddress1T1;

  constructor() public {
    manager = new DelegateCallProxyManager();
    _approvalTest = new ApprovalTest();
    implementation1 = new MockProxyLogic1();
    implementation2 = new MockProxyLogic2();
  }

  function test_deployInvalidImplementation() external testIndex(0) {
    try manager.deployProxyManyToOne(TEST_IMPLEMENTATION_ID, keccak256("Salt1")) {
      revert("Expected error.");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_IMPLEMENTATION_ID"),
        "Error: Expected ERR_IMPLEMENTATION_ID error message."
      );
    }
  }

  function test_createManyToOneProxyRelationship() external testIndex(1) {
    manager.createManyToOneProxyRelationship(TEST_IMPLEMENTATION_ID, address(implementation1));
    address implHolder = manager.getImplementationHolder(TEST_IMPLEMENTATION_ID);
    require(
      implHolder == manager.computeHolderAddressManyToOne(TEST_IMPLEMENTATION_ID),
      "Error: Unexpected implementation holder address"
    );
    (bool success, bytes memory data) = implHolder.call("");
    require(success, "Error: Failed to query implementation address.");
    require(
      abi.decode((data), (address)) == address(implementation1),
      "Error: Implementation holder returned unexpected implementation address."
    );
  }

  function test_unapprovedDeployer() external testIndex(2) {
    try _approvalTest.deploy(manager, keccak256("Salt1")) {
      revert("Expected error");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_APPROVED"),
        "Error: Expected ERR_NOT_APPROVED error message."
      );
    }
  }

  function test_approveDeployer() external testIndex(3) {
    manager.approveDeployer(address(_approvalTest));
    require(
      manager.isApprovedDeployer(address(_approvalTest)),
      "Error: Deployer not approved."
    );
  }

  function test_deployProxyManyToOne() external testIndex(4) {
    address expectedAddress = Salty.computeProxyAddressManyToOne(
      address(manager),
      address(_approvalTest),
      TEST_IMPLEMENTATION_ID,
      keccak256("Salt1")
    );
    proxyAddressMT1 = _approvalTest.deploy(manager, keccak256("Salt1"));
    require(
      proxyAddressMT1 == expectedAddress,
      "Error: unexpected proxy address."
    );
    MockProxyLogic1 proxy = MockProxyLogic1(proxyAddressMT1);
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    proxy.incrementValue();
    require(proxy.getValue() == 1, "Error: Expected proxy to return 1 for stored value.");
    proxy.decrementValue();
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
  }

  function test_revokeDeployerApproval() external testIndex(5) {
    manager.revokeDeployerApproval(address(_approvalTest));
    try _approvalTest.deploy(manager, keccak256("Salt2")) {
      revert("Expected error");
    } catch Error(string memory errorMsg) {
      require(
        keccak256(abi.encodePacked(errorMsg)) == keccak256("ERR_NOT_APPROVED"),
        "Error: Expected ERR_NOT_APPROVED error message."
      );
    }
  }

  function test_setImplementationAddressManyToOne() external testIndex(6) {
    manager.setImplementationAddressManyToOne(TEST_IMPLEMENTATION_ID, address(implementation2));
    MockProxyLogic2 proxy = MockProxyLogic2(proxyAddressMT1);
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    proxy.incrementValue();
    require(proxy.getValue() == 2, "Error: Expected proxy to return 2 for stored value.");
    proxy.decrementValue();
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
  }

  function test_deployProxyOneToOne() external testIndex(7) {
    proxyAddress1T1 = manager.deployProxyOneToOne(
      keccak256("Salty"), address(implementation1)
    );
    require(
      proxyAddress1T1 == Salty.computeProxyAddressOneToOne(
        address(manager),
        address(this),
        keccak256("Salty")
      ),
      "Error: Unexpected proxy address."
    );
    MockProxyLogic1 proxy = MockProxyLogic1(proxyAddress1T1);
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    proxy.incrementValue();
    require(proxy.getValue() == 1, "Error: Expected proxy to return 1 for stored value.");
    proxy.decrementValue();
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
  }

  function test_setImplementationAddressOneToOne() external testIndex(8) {
    manager.setImplementationAddressOneToOne(
      proxyAddress1T1, address(implementation2)
    );
    MockProxyLogic2 proxy = MockProxyLogic2(proxyAddress1T1);
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
    proxy.incrementValue();
    require(proxy.getValue() == 2, "Error: Expected proxy to return 2 for stored value.");
    proxy.decrementValue();
    require(proxy.getValue() == 0, "Error: Expected proxy to return 0 for stored value.");
  }
}