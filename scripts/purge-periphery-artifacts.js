const fs = require('fs');
const path = require('path');

const contractsRoot = path.join(__dirname, '..', 'contracts');
const interfaces = path.join(contractsRoot, 'interfaces');

const getSolFiles = (dir) => fs.readdirSync(dir).filter(f => f.includes('.sol'));

const keepFiles = [
  ...getSolFiles(contractsRoot),
  ...getSolFiles(interfaces),
  'MCapSqrtLibrary.sol',
  'IndexPool.sol'
].map(f => f.replace('.sol', '.json'));

const artifactsPath = path.join(__dirname, '..', 'artifacts');

const allArtifacts = fs.readdirSync(artifactsPath);

for (let artifact of allArtifacts) {
  if (!keepFiles.includes(artifact)) {
    const artifactPath = path.join(artifactsPath, artifact);
    fs.unlinkSync(artifactPath);
  }
}