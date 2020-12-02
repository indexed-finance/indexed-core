
const bre = require("@nomiclabs/buidler");
const { BigNumber } = require("ethers");
const { formatEther, parseEther, keccak256 } = require("ethers/lib/utils");
const { expect } = require('chai').use(require('chai-as-promised'));

async function mineBlock(timestamp) {
  return bre.ethers.provider.send('evm_mine', timestamp ? [timestamp] : [])
}

async function fastForward(seconds) {
  await bre.ethers.provider.send('evm_increaseTime', [seconds]);
  await mineBlock();
}

async function fastForwardToHourStart() {
  const { timestamp } = await bre.ethers.provider.getBlock('latest');
  const seconds = 3600 - ((+timestamp) % 3600);
  await fastForward(seconds);
}

const toBN = (bn) => BigNumber.from(bn);
const oneE18 = toBN(10).pow(18); // 10 ** decimals
const expandTo18Decimals = (amount) => oneE18.mul(amount);
const toHex = (bn) => bn.toHexString();

const fromWei = (bn) => formatEther(bn);
const toWei = (dec) => {
  if (BigNumber.isBigNumber(dec)) {
    return dec.mul(oneE18);
  }
  let str = String(dec);
  if (str.includes('.')) {
    const comps = str.split('.');
    if (comps[1].length > 18) {
      str = `${comps[0]}.${comps[1].slice(0, 18)}`;
    }
  }
  return parseEther(str);
}

const zero = BigNumber.from(0);
const zeroAddress = `0x${'00'.repeat(20)}`;
const maxUint256 = `0x${'ff'.repeat(32)}`;

const verifyRejection = (contract, fnName, errRegex, ...args) => expect(
  contract[fnName](...args)
).to.be.rejectedWith(errRegex);

async function getTransactionTimestamp(_tx) {
  const tx = await Promise.resolve(_tx)
  const receipt = await tx.wait();
  const { timestamp } = await ethers.provider.getBlock(receipt.blockNumber);
  return timestamp;
}

const toFakerInput = (param) => {
  const isArray = param.arrayLength !== null;
  const arrLen = !isArray ? undefined : param.arrayLength == -1 ? 2 : param.arrayLength;
  let baseValue;
  if (param.type.indexOf('address') >= 0) {
    baseValue = zeroAddress;
  } else if (param.type.indexOf('uint') >= 0) {
    baseValue = zero;
  } else if (param.type.indexOf('bool') >= 0) {
    baseValue = false;
  } else if (param.type.indexOf('bytes') >= 0) {
    baseValue = '0x';
  } else if (param.type.indexOf('string') >= 0) {
    baseValue = '';
  }
  if (isArray) {
    return new Array(arrLen).fill(baseValue);
  }
  return baseValue;
}

const getFakerContract = (_contract, alternateSigner) => {
  const contract = alternateSigner ? _contract.connect(alternateSigner) : _contract;
  const { interface } = contract;
  const fnsigs = Object.keys(interface.functions);
  const out = {};
  for (let fnsig of fnsigs) {
    const { inputs, name } = interface.functions[fnsig];
    let key = name;
    if (out[name]) key = fnsig;
    const fakerParams = [];
    for (let input of inputs) {
      fakerParams.push(toFakerInput(input));
    }
    out[key] = () => contract[fnsig](...fakerParams);
  }
  return out;
}

function sqrt(y) {
  let z = BigNumber.from(0);
  if (y.gt(3)) {
    z = BigNumber.from(y);
    let x = y.add(1).div(2);
    while (x.lt(z)) {
      z = BigNumber.from(x);
      x = y.div(x).add(x).div(2);
    }
  } else if (!y.eq(0)) {
    z = BigNumber.from(1);
  }
  return z;
}

const sha3 = (value) => keccak256(Buffer.from(value));

const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;


const MAX_UINT112 = BigNumber.from(2).pow(112);
const toFP = (num) => num.mul(MAX_UINT112);
const fromFP = (num) => num.div(MAX_UINT112);

async function expectEvent(receipt, eventName) {
  const { events } = await receipt.wait();
  expect(events.find(e => e.event == eventName)).to.not.be.null;
}

module.exports = {
  toBN,
  oneE18,
  expandTo18Decimals,
  toHex,
  fromWei,
  toWei,
  mineBlock,
  fastForward,
  zero,
  zeroAddress,
  expect,
  verifyRejection,
  maxUint256,
  getTransactionTimestamp,
  getFakerContract,
  fastForwardToHourStart,
  sqrt,
  sha3,
  HOUR,
  DAY,
  WEEK,
  toFP,
  fromFP,
  expectEvent
}