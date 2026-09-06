// ONE-TIME extraction (not in the build): distil the heavy sandbox geojson into
// compact, committable seed inputs the corpus generator consumes —
//   scripts/seed/footprints.csv   lng,lat,levels,ward,zone  (real OSM footprints)
//   public/data/aonach_basemap.json  decimated coast + ward outlines (with zone)
// Real footprints + real ward geography → the corpus is spatially real; each ward is
// assigned a land-use ZONE from real signals (coast distance, distance-to-core, mean
// building levels), so the generator can hang zone-conditioned correlated attributes
// on top and the socioeconomic / industrial patterns are alignable with query insight.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(HERE, '..', '..', 'RosMadair-sandbox-parquet', 'example', 'aonach_mor', 'geo', 'processed');
const OSM = join(HERE, '..', '..', 'RosMadair.old', 'example', 'aonach_mor', 'osm_buildings.geojson');

const wardsG = JSON.parse(readFileSync(join(SANDBOX, 'ward_boundaries.geojson'), 'utf8'));
const wards = wardsG.features.map((f) => {
  let sx = 0, sy = 0, k = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const w = (a) => { if (typeof a[0] === 'number') { sx += a[0]; sy += a[1]; k++; x0 = Math.min(x0, a[0]); y0 = Math.min(y0, a[1]); x1 = Math.max(x1, a[0]); y1 = Math.max(y1, a[1]); } else a.forEach(w); };
  w(f.geometry.coordinates);
  return { name: f.properties.name, cx: sx / k, cy: sy / k, bbox: [x0, y0, x1, y1], levels: [], zone: null };
});
const nearest = (lng, lat) => { let b = wards[0], bd = Infinity; for (const w of wards) { const d = (w.cx - lng) ** 2 + (w.cy - lat) ** 2; if (d < bd) { bd = d; b = w; } } return b; };

// coastline points (for coast-distance) + decimated for the basemap
const decim = (coords, step) => { const w = []; let i = 0; const walk = (a) => { if (typeof a[0] === 'number') { if (i++ % step === 0) w.push([+a[0].toFixed(4), +a[1].toFixed(4)]); } else a.forEach(walk); }; walk(coords); return w; };
const coastG = JSON.parse(readFileSync(join(SANDBOX, 'coastline.geojson'), 'utf8'));
const coast = coastG.features.flatMap((f) => f.geometry.type === 'LineString' ? [decim(f.geometry.coordinates, 3)] : f.geometry.coordinates.map((l) => decim(l, 3)));
const coastPts = coast.flat();
const coastDist = (lng, lat) => { let m = Infinity; for (const [x, y] of coastPts) { const d = (x - lng) ** 2 + (y - lat) ** 2; if (d < m) m = d; } return Math.sqrt(m); };

// pass 1: footprints → nearest ward, accumulate levels
const osm = JSON.parse(readFileSync(OSM, 'utf8')).features;
const fp = [];
for (const f of osm) {
  const p = f.properties, lng = +p.centroid_lng, lat = +p.centroid_lat;
  if (!isFinite(lng) || !isFinite(lat)) continue;
  const levels = Math.max(1, parseInt(p.osm_levels, 10) || 1);
  const w = nearest(lng, lat); w.levels.push(levels);
  fp.push({ lng, lat, levels, ward: w });
}
// ward signals
const cx0 = wards.reduce((a, w) => a + w.cx, 0) / wards.length, cy0 = wards.reduce((a, w) => a + w.cy, 0) / wards.length;
for (const w of wards) {
  w.meanLevels = w.levels.length ? w.levels.reduce((a, b) => a + b, 0) / w.levels.length : 1;
  w.coast = coastDist(w.cx, w.cy);
  w.core = Math.sqrt((w.cx - cx0) ** 2 + (w.cy - cy0) ** 2);
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
const coastP = pct(wards.map((w) => w.coast), 0.18);
const coreP = pct(wards.map((w) => w.core), 0.14);
const latP = pct(wards.map((w) => w.cy), 0.2); // a southern industrial/port belt
const lvlHi = pct(wards.map((w) => w.meanLevels), 0.66), lvlLo = pct(wards.map((w) => w.meanLevels), 0.33);
const h = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (Math.imul(x, 31) + s.charCodeAt(i)) | 0; return ((x >>> 0) % 100) / 100; };
for (const w of wards) {
  const j = h(w.name); // deterministic jitter for a less rule-clean map
  if (w.cy < latP && j > 0.35) w.zone = 'industrial';
  else if (w.coast <= coastP) w.zone = w.meanLevels < 1.4 && j > 0.4 ? 'low_income_informal' : 'coastal';
  else if (w.core <= coreP) w.zone = w.meanLevels >= lvlHi ? 'commercial_core' : (j > 0.6 ? 'institutional' : 'residential_affluent');
  else if (w.meanLevels >= lvlHi) w.zone = j > 0.7 ? 'institutional' : 'residential_affluent';
  else if (w.meanLevels <= lvlLo) w.zone = j > 0.5 ? 'low_income_informal' : 'residential_mixed';
  else w.zone = j > 0.5 ? 'residential_affluent' : 'residential_mixed';
}

const rows = ['lng,lat,levels,ward,zone'];
for (const b of fp) rows.push(`${b.lng.toFixed(6)},${b.lat.toFixed(6)},${b.levels},"${b.ward.name.replace(/"/g, '')}",${b.ward.zone}`);
writeFileSync(join(HERE, 'seed', 'footprints.csv'), rows.join('\n'));
const zc = {}; for (const w of wards) zc[w.zone] = (zc[w.zone] || 0) + 1;
console.log(`footprints.csv  ${fp.length} footprints · zones by ward: ${JSON.stringify(zc)}`);

let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
for (const b of fp) { bx0 = Math.min(bx0, b.lng); by0 = Math.min(by0, b.lat); bx1 = Math.max(bx1, b.lng); by1 = Math.max(by1, b.lat); }
writeFileSync(join(HERE, 'seed', 'basemap.json'), JSON.stringify({
  bbox: [bx0, by0, bx1, by1], coast,
  wards: wards.map((w) => ({ name: w.name, bbox: w.bbox, zone: w.zone })),
}));
console.log(`aonach_basemap.json  ${coast.length} coast lines · ${wards.length} wards (zoned) · bbox [${bx0.toFixed(3)},${by0.toFixed(3)}]-[${bx1.toFixed(3)},${by1.toFixed(3)}]`);
