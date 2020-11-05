const path = require('path');
const fs = require('fs');

const contracts = {};
const deploymentsDir = path.join(__dirname, '..', 'deployments');
const networks = ['rinkeby'];
const exportPath = path.join(__dirname, '..', 'deployments.json');

function doExport() {
  for (let network of networks) {
    const networkExports = {};
    const networkPath = path.join(deploymentsDir, network);
    const files = fs.readdirSync(networkPath).filter(f => f.includes('.json'));
    for (let fileName of files) {
      const filePath = path.join(networkPath, fileName);
      const contractName = fileName.replace('.json', '');
      const { address } = require(filePath);
      networkExports[contractName] = address;
    }
    contracts[network] = networkExports;
  }

  fs.writeFileSync(exportPath, JSON.stringify(contracts, null, 2));
}

doExport();