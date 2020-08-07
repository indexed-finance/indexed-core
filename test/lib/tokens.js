const BN = require('bn.js');

const oneToken = new BN('de0b6b3a7640000', 'hex'); // 10 ** decimals
const nTokens = (amount) => oneToken.muln(amount);
const toHex = (bn) => '0x' + bn.toString('hex');
const nTokensHex = (amount) => toHex(nTokens(amount));

module.exports = {
  oneToken,
  nTokens,
  toHex,
  nTokensHex
};