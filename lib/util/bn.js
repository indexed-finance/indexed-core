const BN = require('bn.js');

const toBN = (bn) => {
  if (BN.isBN(bn)) return bn;
  if (bn._hex) return new BN(bn._hex.slice(2), 'hex');
  if (typeof bn == 'string' && bn.slice(0, 2) == '0x') {
    return new BN(bn.slice(2), 'hex');
  }
  return new BN(bn);
};

const oneToken = new BN('de0b6b3a7640000', 'hex'); // 10 ** decimals
const nTokens = (amount) => oneToken.muln(amount);
const toHex = (bn) => '0x' + bn.toString('hex');
const nTokensHex = (amount) => toHex(nTokens(amount));

module.exports = {
  BN,
  toBN,
  oneToken,
  nTokens,
  toHex,
  nTokensHex
};