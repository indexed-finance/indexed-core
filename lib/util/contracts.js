function deploy(web3, from, abi, bytecode, args = []) {
  return new web3.eth.Contract(abi).deploy({
    data: bytecode,
    arguments: args,
  })
  .send({ from, gas: 6e6 });
}

const toContract = (web3, abi, address) => {
  if (typeof address == 'string') {
    return new web3.eth.Contract(abi, address);
  }
  return address;
}

const contractExists = async (web3, address) => {
  if (!address) return false;
  const exists = await web3.eth.getCode(address);
  return exists && exists != '0x';
}

module.exports = {
  deploy,
  toContract,
  contractExists
};