const TMath = artifacts.require('TMath');
const BToken = artifacts.require('BToken');
const BFactory = artifacts.require('BFactory');

module.exports = async function (deployer) {
  const tmath = await TMath.new();
  TMath.setAsDeployed(tmath);
  const bfactory = await BFactory.new();
  BFactory.setAsDeployed(bfactory);
};
