module.exports = {
  mocha: {
    enableTimeouts: false,
    timeout: 250000
  },
  skipFiles: [
    'mocks/',
    'interfaces/',
    'balancer/Btoken.sol',
    'balancer/BNum.sol',
    'lib/Babylonian.sol',
    'lib/UniswapV2Library.sol'
  ]
}