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

module.exports = {
  deploy,
  toContract
};