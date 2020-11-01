const multihashes = require('multihashes');
const CID = require('cids');
const { digest } = require('multihashing')
const { soliditySha3 } = require('web3-utils');
const rp = require('request-promise');

const detJSON = require('./deterministicJSON');

const gatewayUrl = 'https://gateway.temporal.cloud/ipfs/';

function sha3(value) {
  return soliditySha3(value);
}
  
function sha3Bytes(value) {
  return soliditySha3({ t: 'bytes', v: value });
}

// function jsonSha3(obj) {
//   const json = detJSON(obj);
//   const buf = Buffer.from(json)
//   return '0x' + digest(buf, 'sha3-256').toString('hex')
// }

function toMh(shaHash) {
  const buf = Buffer.from(shaHash, 'hex');
  return multihashes.encode(buf, 'sha3-256');
}

function toCid(mh) {
  const cid = new CID(1, 'raw', Buffer.from(mh, 'hex'), 'base32');
  return cid.toBaseEncodedString();
}

function shaToCid(hash) {
  return toCid(Buffer.from(toMh(hash.slice(2))).toString('hex'))
}

function hash(encodedCall) {
  const eth = sha3(encodedCall);
  const ipfs = shaToCid(eth);
  return {eth, ipfs};
}

function hashJSON(obj) {
  const json = detJSON(obj);
  const buf = Buffer.from(json);
  const sha3Hash = '0x' + digest(buf, 'sha3-256').toString('hex');
  const ipfsHash = shaToCid(sha3Hash);
  return { json, sha3Hash, ipfsHash };
}

function getIPFSFile(sha3Hash) {
  const ipfsHash = shaToCid(sha3Hash);
  const url = `${gatewayUrl}${ipfsHash}`;
  return rp.get(url)
    .then((file) => JSON.parse(file));
}

module.exports = {
  getIPFSFile,
  sha3,
  sha3Bytes,
  hashJSON,
  toMh,
  toCid,
  shaToCid,
  hash,
}