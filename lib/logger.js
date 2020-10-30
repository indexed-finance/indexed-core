const chalk = require('chalk');
const moment = require('moment');

const chalkFn = (color, bold = true, underline = false) => {
  let ch = chalk[color];
  if (bold) ch = ch.bold;
  if (underline) ch = ch.underline;
  return ch;
}

const log = (color, domain, message, underline = false) => {
  console.log(
    chalkFn(color, true, underline)(
      `@indexed-finance/core${domain}:${moment(new Date()).format('HH:mm:ss')}: ${message}`
    )
  );
};

const Logger = (chainID = undefined, domain = '') => {
  if (domain != '') domain = `/${domain}`;
  return {
    info: (v, u = false) => {
      if (chainID !== undefined && chainID != 1 && chainID != 4) return;
      log('cyan', domain, v, u);
      return v;
    },
    success: (v, u = false) => {
      if (chainID !== undefined && chainID != 1 && chainID != 4) return;
      log('green', domain, v, u);
      return v;
    },
    error: (v, u = false) => {
      if (chainID !== undefined && chainID != 1 && chainID != 4) return;
      log('red', domain, v, u);
      return v;
    },
  };
};

module.exports = Logger;