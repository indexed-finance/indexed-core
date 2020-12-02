const fs = require('fs');
const path = require('path');
const argsPath = path.join(__dirname, '..', 'arguments.js')

const Deployer = async (bre, logger) => {
  const { ethers } = bre;
  const [ signer ] = await ethers.getSigners();
  const deploy = async (name, contractName, opts, returnContract = false) => {
    try {
      const deployment = await bre.deployments.deploy(name, {
        ...opts,
        contractName
      });
      if (deployment.newlyDeployed) {
        logger.success(`Deployed ${contractName} [${name}] to ${deployment.address}`);
        await bre.deployments.save(contractName, deployment);
        if (bre.network.name == 'mainnet' || bre.network.name == 'rinkeby') {
          fs.writeFileSync(argsPath, `module.exports = ${JSON.stringify(opts.args || [])}`);
        }
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