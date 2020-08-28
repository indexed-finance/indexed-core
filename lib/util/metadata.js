// const multihashes = require('multihashes');
// const CID = require('cids');
// const rp = require('request-promise');
// const { sha3, jsonSha3 } = require('./ipfs');
// const detJson = require('./deterministicJSON');

// const gatewayUrl = 'https://gateway.temporal.cloud/ipfs/';

// function toCid(hash) {
//   const buf = Buffer.from(hash.slice(2), 'hex');
//   const mh = multihashes.encode(buf, 'sha3-256');
//   const cid = new CID(1, 'raw', mh, 'base32');
//   return cid.toBaseEncodedString();
// }

// function hashMetadata(metadata) {
//   const json = detJson(metadata);
//   const metadataHash = jsonSha3(metadata);
//   const ipfsHash = toCid(metadataHash);
//   return { json, metadataHash, ipfsHash };
// }

// function getMetadata(metadataHash) {
//   const hash = toCid(metadataHash);
//   const url = `${gatewayUrl}${hash}`;
//   return rp.get(url)
//     .then((file) => JSON.parse(file));
// }

// module.exports = {
//   hashMetadata,
//   getMetadata,
// }