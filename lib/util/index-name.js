function indexNameAndSymbol(categoryMetadata, indexSize) {
  const { name, symbol } = categoryMetadata;
  return {
    name: `${name} ${indexSize}`,
    symbol: `${symbol}${indexSize}`
  };
}

module.exports = indexNameAndSymbol;