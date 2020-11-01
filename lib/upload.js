require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');
const logger = Logger(undefined, 'IPFS');

const Temporal = require('./temporal');
const { hashJSON } = require('./ipfs');

const tmp_path = path.join(__dirname, 'tmp.json');

const { temporal_username, temporal_password } = process.env;

function clearTmpFile() {
  if (fs.existsSync(tmp_path)) fs.unlinkSync(tmp_path);
}

let temporal;

async function uploadFile(jsonObj) {
  if (!temporal) {
    logger.info('Logging into Temporal...');
    temporal = new Temporal();
    await temporal.login(temporal_username, temporal_password);
  }
  const { json, sha3Hash, ipfsHash } = hashJSON(jsonObj)
  logger.info('Uploading file...');
  logger.info(`CID: ${ipfsHash}`);
  logger.info(`SHA3: ${sha3Hash}`);

  if (json.length > 4096) throw new Error('File exceeds 4kb');
  clearTmpFile();
  fs.writeFileSync(tmp_path, json);
  const rs = fs.createReadStream(tmp_path);
  const result = await temporal.uploadPublicFile(rs, 24);
  logger.success(`Server Returned: ${result}`);
  clearTmpFile();
  return { json, sha3Hash, ipfsHash };
}

module.exports = uploadFile;