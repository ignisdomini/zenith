// Проверка упаковщика KMZ: node tools/test-kmz.js <out.kmz>
const fs = require('fs');
const { makeZip } = require('../src/main/zip');
const kml = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Тест ЗЕНИТ</name>' +
  '<Placemark><name>Луна × Регул</name><Point><coordinates>118.866,11.837,0</coordinates></Point></Placemark>'.repeat(200) + '</Document></kml>';
fs.writeFileSync(process.argv[2], makeZip([['doc.kml', Buffer.from(kml, 'utf8')]]));
console.log(`kml ${Buffer.byteLength(kml)} Б → kmz ${fs.statSync(process.argv[2]).size} Б`);
