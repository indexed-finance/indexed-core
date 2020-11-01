function sortObjectKeys(obj){
  if(obj == null || obj == undefined) return obj;
  if(typeof obj != 'object') return obj;
  return Object.keys(obj).sort().reduce((acc, key)=>{
    if (Array.isArray(obj[key])) acc[key] = obj[key].map(sortObjectKeys);
    else if (typeof obj[key] === 'object') acc[key] = sortObjectKeys(obj[key]);
    else if (obj[key] == true) acc[key] = 'true';
    else if (obj[key] == false) acc[key] = 'false';
    else if (typeof obj[key] == 'number') acc[key] = obj[key].toString();
    else acc[key] = obj[key];
    return acc;
  },{});
}

const stringify = (obj) => {
  let sortedObject = sortObjectKeys(obj);
  let jsonstring = JSON.stringify(sortedObject, function(k, v) { return v === undefined ? "undef" : v; });
  // Remove all whitespace
  // let jsonstringNoWhitespace = jsonstring.replace(/\s+/g, '');
  return jsonstring;
}

module.exports = stringify;