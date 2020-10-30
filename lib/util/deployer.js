const Deployer = async (bre, logger) => {
  const { ethers } = bre;
  const [ signer ] = await ethers.getSigners();
  const deploy = async (name, contractName, opts, returnContract = false) => {
    try {
      // if (await deployments.getOrNull(contractName)) {
      //   logger.info(`Found ${contractName} [${name}]`);
      //   return await ethers.getContract(contractName, signer);
      // }
      const deployment = await bre.deployments.deploy(name, {
        ...opts,
        contractName
      });
      if (deployment.newlyDeployed) {
        logger.success(`Deployed ${contractName} [${name}]`);
        await bre.deployments.save(contractName, deployment);
      } else {
        logger.info(`Found ${contractName} [${name}]`);
      }
      if (returnContract) {
        const contract = await ethers.getContractAt(deployment.abi, deployment.address, signer);
        contract.newlyDeployed = deployment.newlyDeployed;
        return contract;
      }
      return deployment;
    } catch (err) {
      logger.error(`Error deploying ${contractName} [${name}]`);
      throw err;
    }
  };
  return deploy;
}

module.exports = Deployer;