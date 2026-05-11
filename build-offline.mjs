/**
 * Build script: downloads all assets for fully offline Prague Guide PWA
 * Run: node build-offline.mjs
 */
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

const DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const IMG_DIR = path.join(DIR, 'images');
const TILE_DIR = path.join(DIR, 'tiles');

fs.mkdirSync(IMG_DIR, { recursive: true });
fs.mkdirSync(TILE_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function download(url, dest, retries = 3) {
  return new Promise(async (resolve) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) {
      console.log(`  SKIP (cached): ${path.basename(dest)}`);
      return resolve(true);
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      const ok = await new Promise((res) => {
        const proto = url.startsWith('https') ? https : http;
        const req = proto.get(url, {
          headers: { 'User-Agent': 'PragueGuide/1.0 (family travel; pratheek)' }
        }, response => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            download(response.headers.location, dest, 1).then(r2 => res(r2));
            return;
          }
          if (response.statusCode === 429) {
            response.resume();
            console.log(`  RATE LIMITED (attempt ${attempt}/${retries}): ${path.basename(dest)}`);
            return res(false);
          }
          if (response.statusCode !== 200) {
            response.resume();
            console.log(`  FAIL (${response.statusCode}): ${path.basename(dest)}`);
            return res(false);
          }
          const chunks = [];
          response.on('data', c => chunks.push(c));
          response.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length < 1000) {
              console.log(`  FAIL (tiny ${buf.length}b): ${path.basename(dest)}`);
              return res(false);
            }
            fs.writeFileSync(dest, buf);
            console.log(`  OK: ${path.basename(dest)} (${(buf.length / 1024).toFixed(0)}KB)`);
            res(true);
          });
        });
        req.on('error', e => { console.log(`  ERR: ${e.message}`); res(false); });
        req.setTimeout(20000, () => { req.destroy(); res(false); });
      });

      if (ok) return resolve(true);
      if (attempt < retries) {
        const wait = attempt * 3000;
        console.log(`  Waiting ${wait / 1000}s before retry...`);
        await sleep(wait);
      }
    }
    resolve(false);
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'PragueGuide/1.0 (family travel; pratheek)' }
    }, res => {
      if (res.statusCode === 429) {
        res.resume();
        return reject(new Error('RATE_LIMITED'));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Bad JSON: ' + body.substring(0, 100))); }
      });
    }).on('error', reject);
  });
}

// ========== 1. WIKIPEDIA IMAGES ==========
console.log('\n=== Downloading Wikipedia images ===');
const landmarks = [
  'Charles_Bridge', 'Prague_astronomical_clock', 'Old_Town_Square_(Prague)',
  'Jan_Hus_Memorial', 'Church_of_Our_Lady_before_Týn', 'Josefov_(Prague)',
  'Franz_Kafka', 'Prague_Castle', 'St._Vitus_Cathedral', 'Prague_Zoo',
  'Vyšehrad', 'Vyšehrad_cemetery', 'Lennon_Wall', 'Kampa_Park',
  'Petřín', 'Petřín_Lookout_Tower', 'Strahov_Monastery',
  'Wenceslas_Square', 'National_Museum_(Prague)', 'Letná_Park', 'Prague_Metronome'
];

const imageMap = {};

for (const title of landmarks) {
  const safeName = title.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() + '.jpg';
  const dest = path.join(IMG_DIR, safeName);

  // Skip if already downloaded
  if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) {
    console.log(`  SKIP (cached): ${safeName}`);
    imageMap[title] = 'images/' + safeName;
    continue;
  }

  try {
    await sleep(2000); // Be polite to Wikipedia API
    const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const data = await fetchJSON(apiUrl);

    const url = data.originalimage?.source || data.thumbnail?.source;
    if (url) {
      imageMap[title] = 'images/' + safeName;
      await download(url, dest);
    } else {
      console.log(`  NO IMAGE: ${title}`);
    }
  } catch (e) {
    if (e.message === 'RATE_LIMITED') {
      console.log(`  API rate limited on ${title}, waiting 10s...`);
      await sleep(10000);
      // Retry once
      try {
        const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
        const data = await fetchJSON(apiUrl);
        const url = data.originalimage?.source || data.thumbnail?.source;
        if (url) {
          imageMap[title] = 'images/' + safeName;
          await download(url, dest);
        }
      } catch (e2) {
        console.log(`  SKIP after retry: ${title}`);
      }
    } else {
      console.log(`  API ERR: ${title} - ${e.message}`);
    }
  }
}

fs.writeFileSync(path.join(DIR, 'image-map.json'), JSON.stringify(imageMap, null, 2));
console.log(`\nImage map saved. ${Object.keys(imageMap).length} images mapped.`);

// ========== 2. MAP TILES ==========
console.log('\n=== Downloading map tiles for Prague ===');

function lon2tile(lon, zoom) { return Math.floor((lon + 180) / 360 * Math.pow(2, zoom)); }
function lat2tile(lat, zoom) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, zoom));
}

// Prague bounds (zoo to vysehrad)
const bounds = { latMin: 50.05, latMax: 50.13, lonMin: 14.37, lonMax: 14.46 };
const zooms = [12, 13, 14];
let tileCount = 0;

for (const z of zooms) {
  const xMin = lon2tile(bounds.lonMin, z);
  const xMax = lon2tile(bounds.lonMax, z);
  const yMin = lat2tile(bounds.latMax, z);
  const yMax = lat2tile(bounds.latMin, z);
  const total = (xMax - xMin + 1) * (yMax - yMin + 1);

  console.log(`Zoom ${z}: x[${xMin}-${xMax}] y[${yMin}-${yMax}] = ${total} tiles`);

  for (let x = xMin; x <= xMax; x++) {
    const xDir = path.join(TILE_DIR, String(z), String(x));
    fs.mkdirSync(xDir, { recursive: true });
    for (let y = yMin; y <= yMax; y++) {
      const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
      const dest = path.join(xDir, `${y}.png`);
      await download(url, dest);
      tileCount++;
      await sleep(200); // Be polite to OSM
    }
  }
}
console.log(`Total tiles: ${tileCount}`);

// ========== 3. LEAFLET MARKER ICONS ==========
console.log('\n=== Downloading Leaflet icons ===');
const iconsDir = path.join(DIR, 'leaflet-images');
fs.mkdirSync(iconsDir, { recursive: true });
for (const name of ['marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']) {
  await download(`https://unpkg.com/leaflet@1.9.4/dist/images/${name}`, path.join(iconsDir, name));
}

console.log('\n=== BUILD COMPLETE ===');
console.log(`Images: ${Object.keys(imageMap).length}`);
console.log(`Tiles: ${tileCount}`);
