const fs = require('fs');
const path = require('path');
const { hashJSON } = require('../../lib/util/ipfs');

const tmp_path = path.join(__dirname, 'tmp.json');

function clearTmpFile() {
  if (fs.existsSync(tmp_path)) fs.unlinkSync(tmp_path);
}

async function uploadFile(temporal, jsonObj) {
  const { json, sha3Hash, ipfsHash } = hashJSON(jsonObj)
  if (json.length > 4096) throw new Error('File exceeds 4kb');
  clearTmpFile();
  fs.writeFileSync(tmp_path, json);
  const rs = fs.createReadStream(tmp_path);
  await temporal.uploadPublicFile(rs, 24);
  clearTmpFile();
  return { json, sha3Hash, ipfsHash };
}

module.exports = uploadFile;