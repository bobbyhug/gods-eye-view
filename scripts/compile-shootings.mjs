#!/usr/bin/env node
/**
 * Compile the civilian mass-shooting dataset.
 *
 *   node scripts/compile-shootings.mjs
 *
 * Writes data/shootings.json, which /api/shootings serves.
 *
 * SOURCE: Wikidata, via its public SPARQL endpoint.
 *
 * Wikidata is the only source found that clears every bar at once. A survey of
 * the alternatives (see docs/SHOOTINGS-DATA.md) found the well-known catalogues
 * are all licence-blocked for redistribution:
 *
 *   Gun Violence Archive .......... explicitly proprietary, no redistribution
 *   Mother Jones .................. no open licence
 *   The Violence Project .......... gated, redistribution forbidden
 *   Everytown ..................... reuse prohibited by terms
 *   Global Terrorism Database ..... restrictive proprietary EULA
 *   ACLED ......................... not redistributable
 *   gunviolence.eu ................ redistribution explicitly forbidden
 *
 * Wikidata's structured data is CC0 — a public-domain dedication — so it can be
 * compiled and redistributed without restriction. It is also the only source
 * that is genuinely global rather than a single country's catalogue.
 *
 * SCOPE. Four classes, all firearm-specific and civilian:
 *   Q21480300  mass shooting
 *   Q473853    school shooting
 *   Q118188839 spree shooting
 *   Q42915628  mass shooting in the United States
 *
 * Deliberately NOT included: Q3199915 "massacre" and Q750215 "mass murder".
 * Those sweep in armed-conflict killings — a first pass using them returned
 * things like a 102-death event in Sudan in 2009, which is a war massacre, not
 * a civilian mass shooting. They are a different subject with different data
 * and merging them would misrepresent both.
 *
 * The classes alone still let conflict events through, because Wikidata types
 * many of them as mass shootings TOO. The query therefore also excludes
 * anything additionally typed as a massacre, war, suicide bombing or military
 * operation, and anything that is `part of` a named armed conflict. That last
 * one does most of the work: it is what separates an insurgency attack from a
 * lone attacker in a shopping centre.
 *
 * Terrorist attacks are NOT excluded. Some of the worst civilian mass shootings
 * — Christchurch, Utoya — are classed as terrorism, and dropping them to be
 * tidy would misrepresent the subject just as badly as including a war.
 *
 * PERPETRATORS ARE NEVER QUERIED. Not fetched, not stored, not stripped later —
 * the SELECT simply does not ask for them. Wikidata holds them; this dataset
 * does not. See src/data/shootings.js for the reasoning.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../data/shootings.json');
const ENDPOINT = 'https://query.wikidata.org/sparql';
/** Wikidata asks for a descriptive agent so they can contact you about load. */
const USER_AGENT = 'GodsEyeView/1.0 (https://github.com/uhrichsam4/gods-eye-view) compile-shootings';
const SINCE_YEAR = 2001;

/**
 * Incident classes. Queried ONE AT A TIME.
 *
 * The subclass walk (`wdt:P279*`) is what picks up the long tail — Wikidata has
 * many specific subtypes of these — but all four classes in a single VALUES
 * block plus the walk reliably times the public endpoint out at 504. One class
 * per request costs four round trips and always completes.
 */
const CLASSES = [
  { qid: 'Q21480300', label: 'mass shooting' },
  { qid: 'Q473853', label: 'school shooting' },
  { qid: 'Q118188839', label: 'spree shooting' },
  { qid: 'Q42915628', label: 'mass shooting in the United States' },
];

/**
 * SPARQL for one class.
 *
 * The date is P585 (point in time) OR P580 (start time): a few incidents carry
 * only a start time, and binding P585 alone silently dropped them.
 *
 * @param {string} qid
 * @returns {string}
 */
function queryForClass(qid) {
  return `
SELECT ?item ?itemLabel ?date ?coord ?locCoord ?admCoord ?countryLabel ?locLabel ?killed ?injured WHERE {
  ?item wdt:P31/wdt:P279* wd:${qid} .
  { ?item wdt:P585 ?date . } UNION { ?item wdt:P580 ?date . }
  FILTER(YEAR(?date) >= ${SINCE_YEAR})

  # ── Civilian scope ────────────────────────────────────────────────────────
  # The shooting classes alone are not enough. Wikidata also types plenty of
  # armed-conflict killings as "mass shooting", and a first pass returned the
  # 2015 Zaria massacre (Nigerian Army, ~1,000 dead), the Zaki Biam army
  # reprisal, and the 2021 Kabul airport bombing. Those are war and state
  # violence, not a mall or a school.
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q3199915 . }    # also a "massacre" — group-on-group
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q198 . }        # also a "war"
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q18493502 . }   # a suicide bombing, not a shooting
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q645883 . }     # a military operation
  # ...and the strongest signal of all: being part of a named armed conflict,
  # which is what separates an insurgency attack from a lone civilian attack.
  # Direct types only, no wdt:P279* walk — with the subclass walk on BOTH this
  # filter and the class match above, the largest class blew the endpoint's
  # 60-second budget and returned 504 every time.
  FILTER NOT EXISTS {
    ?item wdt:P361 ?conflict .
    ?conflict wdt:P31 ?conflictType .
    VALUES ?conflictType { wd:Q350604 wd:Q198 wd:Q645883 wd:Q1006311 wd:Q180684 }
  }

  OPTIONAL { ?item wdt:P625 ?coord . }
  OPTIONAL { ?item wdt:P276 ?loc . OPTIONAL { ?loc wdt:P625 ?locCoord . } }
  OPTIONAL { ?item wdt:P131 ?adm . OPTIONAL { ?adm wdt:P625 ?admCoord . } }
  OPTIONAL { ?item wdt:P17 ?country . }
  OPTIONAL { ?item wdt:P1120 ?killed . }
  OPTIONAL { ?item wdt:P1339 ?injured . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;
}

/** Stanford Mass Shootings in America — CC BY 4.0, US only, 1966-2016. */
const MSA_CSV_URL = 'https://raw.githubusercontent.com/StanfordGeospatialCenter/MSA/master/Data/Stanford_MSA_Database.csv';

/**
 * Parse a WKT point as Wikidata returns it: `Point(lon lat)` — longitude FIRST,
 * which is the opposite order to how coordinates are usually spoken.
 *
 * @param {string} wkt
 * @returns {{lat: number, lon: number}|null}
 */
function parsePoint(wkt) {
  const match = /^Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(String(wkt || '').trim());
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * Best available coordinate for an incident, and how precise it is.
 *
 * The precision is recorded rather than discarded because a point placed at the
 * centroid of a city is a much weaker claim than one placed at the building,
 * and the map should be able to say which it is showing.
 *
 * @param {Array<object>} rows - All SPARQL rows for one incident.
 * @returns {{lat: number, lon: number, precision: string}|null}
 */
function resolveCoordinate(rows) {
  for (const [field, precision] of [
    ['coord', 'exact'],
    ['locCoord', 'venue'],
    ['admCoord', 'area'],
  ]) {
    for (const row of rows) {
      if (!row[field]?.value) continue;
      const point = parsePoint(row[field].value);
      if (point) return { ...point, precision };
    }
  }
  return null;
}

/**
 * First non-empty value of a field across an incident's rows.
 *
 * @param {Array<object>} rows
 * @param {string} field
 * @returns {string}
 */
function firstValue(rows, field) {
  for (const row of rows) {
    const value = row[field]?.value;
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return '';
}

/**
 * Largest reported count for a field.
 *
 * Wikidata often carries several values for a death toll — an initial press
 * figure and a later confirmed one. Taking the maximum matches how these are
 * finally reported, and avoids a record that says 3 when the article says 17.
 *
 * @param {Array<object>} rows
 * @param {string} field
 * @returns {number}
 */
function maxNumber(rows, field) {
  let best = 0;
  for (const row of rows) {
    const value = Number(row[field]?.value);
    if (Number.isFinite(value) && value > best) best = value;
  }
  return best;
}

/**
 * @param {string} sparql
 * @returns {Promise<Array<object>>}
 */
async function runQuery(sparql, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${ENDPOINT}?query=${encodeURIComponent(sparql)}`, {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT },
      });
      if (response.ok) {
        const payload = await response.json();
        return payload?.results?.bindings || [];
      }
      lastError = new Error(`Wikidata HTTP ${response.status}`);
      // 429 and 5xx are load, not a bad query — worth waiting out. A 400 is a
      // broken query and will fail identically however long we wait.
      if (response.status < 429) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      const waitMs = 5000 * attempt;
      process.stdout.write(` [retry ${attempt}/${attempts - 1} in ${waitMs / 1000}s]`);
      await new Promise((resolve) => { setTimeout(resolve, waitMs); });
    }
  }
  throw lastError || new Error('Wikidata query failed');
}

/**
 * Of a set of incident QIDs, which are armed-conflict events.
 *
 * Run as a SEPARATE query, deliberately. The thorough version of this check
 * needs a `wdt:P279*` walk over conflict types, and doing that inside the main
 * query — which already walks P279* for the incident class — put the largest
 * class over the endpoint's 60-second budget and returned 504 every time.
 * Asking it of a KNOWN, bounded set of items instead is cheap, and lets the
 * filter be as thorough as it should be.
 *
 * Without this, conflict events survive: the compile that skipped it returned
 * "mass killings near GHF aid sites in Gaza" (766 dead) at the top of the list.
 *
 * @param {Array<string>} qids
 * @returns {Promise<Set<string>>} QIDs to exclude.
 */
async function findConflictEvents(qids) {
  const exclude = new Set();
  const BATCH = 220;
  for (let start = 0; start < qids.length; start += BATCH) {
    const batch = qids.slice(start, start + BATCH);
    const values = batch.map((qid) => `wd:${qid}`).join(' ');
    const sparql = `
SELECT DISTINCT ?item WHERE {
  VALUES ?item { ${values} }
  {
    # Part of a named armed conflict, war, insurgency or military operation.
    ?item wdt:P361 ?conflict .
    ?conflict wdt:P31/wdt:P279* ?type .
    VALUES ?type { wd:Q350604 wd:Q198 wd:Q645883 }
  } UNION {
    # Or typed as one itself, via any subclass.
    ?item wdt:P31/wdt:P279* ?selfType .
    # Q135010 "war crime" is a definitive conflict marker: the term only has
    # meaning inside an armed conflict. It is what finally caught the Gaza aid
    # site killings (766 dead), which carried no P361 at all and so survived
    # every other check.
    VALUES ?selfType { wd:Q350604 wd:Q198 wd:Q645883 wd:Q3199915 wd:Q135010 }
  }
}
`;
    const rows = await runQuery(sparql);
    for (const row of rows) {
      const qid = String(row.item?.value || '').split('/').pop();
      if (qid) exclude.add(qid);
    }
    process.stdout.write('.');
  }
  return exclude;
}

/**
 * Stanford MSA rows, 2001 onward, as normalised incidents.
 *
 * CC BY 4.0. The citation Stanford asks for is carried on every record via
 * sourceName, and repeated in the dataset's `sources` block.
 *
 * NINE perpetrator columns in this CSV are deliberately never read: Shooter
 * Name, Number of shooters, Shooter Age(s), Average Shooter Age, Shooter Sex,
 * Shooter Race, Fate of Shooter at the scene, Fate of Shooter, and Shooter's
 * Cause of Death.
 *
 * @returns {Promise<Array<object>>}
 */
async function fetchStanfordMsa() {
  const response = await fetch(MSA_CSV_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Stanford MSA HTTP ${response.status}`);
  const rows = parseCsv(await response.text());

  const out = [];
  for (const row of rows) {
    const year = Number((/(\d{4})/.exec(row.Date || '') || [])[1]);
    if (!Number.isFinite(year) || year < SINCE_YEAR) continue;
    const lat = Number(row.Latitude);
    const lon = Number(row.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    out.push({
      // NOT CaseID alone: the Stanford CSV reuses it. Case 156 is two entirely
      // separate incidents — Desoto/Dallas in August 2013 and the Centennial
      // Hill Bar & Grill in December 2013 — and a shared id made the second one
      // throw on insert, which aborted rendering partway through the map.
      // Date plus coordinates is unique per incident by construction.
      id: `msa-${isoDate(row.Date)}-${Number(lat).toFixed(3)}-${Number(lon).toFixed(3)}`,
      date: isoDate(row.Date),
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      placeName: row.Title || row.Location || '',
      country: 'United States',
      killed: Math.max(0, Number(row['Total Number of Fatalities']) || 0),
      injured: Math.max(0, Number(row['Number of Civilian Injured']) || 0),
      venueType: (row['School Related'] || '').toLowerCase() === 'yes' ? 'school' : '',
      precision: 'exact',
      sourceName: 'Stanford MSA',
      sourceUrl: 'https://github.com/StanfordGeospatialCenter/MSA',
    });
  }
  return out;
}

/**
 * Minimal RFC4180 CSV parser — quoted fields, embedded commas and newlines,
 * and doubled quotes. The MSA file has all three.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let quoted = false;
  const body = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n') { record.push(field); rows.push(record); record = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || record.length) { record.push(field); rows.push(record); }

  const header = rows.shift() || [];
  return rows
    .filter((cells) => cells.length > 1)
    .map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
}

/**
 * Normalise a date to ISO. MSA writes M/D/YYYY.
 *
 * @param {string} raw
 * @returns {string}
 */
function isoDate(raw) {
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw || '').trim());
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw || '').trim());
  return iso ? iso[1] : '';
}

/**
 * Whether two incidents are the same event seen through two catalogues.
 *
 * Same day and within ~30 km. Date alone is too loose — several unrelated
 * shootings can share a date — and coordinates alone too strict, because the
 * two sources geocode to different points in the same town.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function isSameIncident(a, b) {
  if (!a.date || !b.date || a.date !== b.date) return false;
  const dLat = (a.lat - b.lat) * 111;
  const dLon = (a.lon - b.lon) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon) < 30;
}

async function main() {
  // One incident spans several rows when a field has multiple values, and the
  // same incident can appear under more than one class — both collapse here.
  const byItem = new Map();
  for (const cls of CLASSES) {
    process.stdout.write(`Querying Wikidata: ${cls.label}…`);
    const bindings = await runQuery(queryForClass(cls.qid));
    let fresh = 0;
    for (const row of bindings) {
      const uri = row.item?.value;
      if (!uri) continue;
      if (!byItem.has(uri)) { byItem.set(uri, []); fresh += 1; }
      byItem.get(uri).push(row);
    }
    process.stdout.write(` ${bindings.length} rows, ${fresh} new incidents\n`);
  }
  process.stdout.write(`  ${byItem.size} distinct Wikidata incidents\n`);

  process.stdout.write('Screening out armed-conflict events');
  const allQids = [...byItem.keys()].map((uri) => uri.split('/').pop());
  const conflictQids = await findConflictEvents(allQids);
  for (const uri of [...byItem.keys()]) {
    if (conflictQids.has(uri.split('/').pop())) byItem.delete(uri);
  }
  process.stdout.write(` removed ${conflictQids.size}, ${byItem.size} remain\n`);

  const incidents = [];
  let dropped = 0;
  const precisionCounts = { exact: 0, venue: 0, area: 0 };

  for (const [uri, rows] of byItem) {
    const point = resolveCoordinate(rows);
    if (!point) {
      // No location at any precision. Dropped rather than placed at a country
      // centroid: a marker is a claim about where someone died.
      dropped += 1;
      continue;
    }
    precisionCounts[point.precision] += 1;

    const qid = uri.split('/').pop();
    const label = firstValue(rows, 'itemLabel');
    const date = firstValue(rows, 'date').slice(0, 10);

    incidents.push({
      id: qid,
      date,
      lat: Number(point.lat.toFixed(5)),
      lon: Number(point.lon.toFixed(5)),
      // A bare QID means Wikidata has no English label — better to show the
      // place than a meaningless identifier.
      placeName: /^Q\d+$/.test(label) ? firstValue(rows, 'locLabel') : label,
      country: firstValue(rows, 'countryLabel'),
      killed: maxNumber(rows, 'killed'),
      injured: maxNumber(rows, 'injured'),
      venueType: '',
      precision: point.precision,
      sourceName: 'Wikidata',
      sourceUrl: `https://www.wikidata.org/wiki/${qid}`,
    });
  }

  // ── Stanford MSA ──────────────────────────────────────────────────────────
  process.stdout.write('Fetching Stanford MSA…');
  let msaAdded = 0;
  let msaDuplicates = 0;
  try {
    const msa = await fetchStanfordMsa();
    process.stdout.write(` ${msa.length} US incidents ${SINCE_YEAR}+\n`);
    // Index by date so the duplicate check is not O(n^2) across the whole set.
    const byDate = new Map();
    for (const incident of incidents) {
      if (!byDate.has(incident.date)) byDate.set(incident.date, []);
      byDate.get(incident.date).push(incident);
    }
    for (const candidate of msa) {
      const sameDay = byDate.get(candidate.date) || [];
      if (sameDay.some((existing) => isSameIncident(existing, candidate))) {
        msaDuplicates += 1;
        continue;
      }
      incidents.push(candidate);
      sameDay.push(candidate);
      byDate.set(candidate.date, sameDay);
      msaAdded += 1;
    }
  } catch (error) {
    // A dead upstream must not destroy an otherwise good Wikidata compile.
    process.stdout.write(` FAILED (${error?.message || error}) — continuing without it\n`);
  }

  incidents.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const countries = new Set(incidents.map((i) => i.country).filter(Boolean));
  const payload = {
    _comment: 'Compiled by scripts/compile-shootings.mjs. Perpetrator names are never queried, stored or served.',
    generated: new Date().toISOString().slice(0, 10),
    coverageNote:
      `${incidents.length} incidents across ${countries.size} countries, ${SINCE_YEAR}-present, from Wikidata (CC0). `
      + 'Coverage is uneven: it reflects where incidents are catalogued, not where they occur. '
      + 'The best-known national databases (Gun Violence Archive, Mother Jones, The Violence Project, '
      + 'Everytown, GTD, ACLED) all forbid redistribution, so none of them are included.',
    sources: [
      {
        name: 'Wikidata',
        url: 'https://query.wikidata.org/',
        licence: 'CC0 1.0 Universal (public domain dedication)',
        redistributable: true,
        retrieved: new Date().toISOString().slice(0, 10),
      },
      {
        name: 'Stanford MSA',
        url: 'https://github.com/StanfordGeospatialCenter/MSA',
        licence: 'CC BY 4.0',
        attribution: 'Stanford Mass Shootings in America, courtesy of the Stanford Geospatial Center and Stanford Libraries',
        redistributable: true,
        retrieved: new Date().toISOString().slice(0, 10),
      },
    ],
    stats: {
      wikidataIncidents: byItem.size,
      stanfordAdded: msaAdded,
      stanfordDuplicates: msaDuplicates,
      plotted: incidents.length,
      droppedNoLocation: dropped,
      countries: countries.size,
      precision: precisionCounts,
    },
    incidents,
  };

  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
  process.stdout.write(
    `\nWrote ${OUT_PATH}\n`
    + `  plotted               ${incidents.length}\n`
    + `  from Wikidata         ${incidents.length - msaAdded}\n`
    + `  from Stanford MSA     ${msaAdded} (${msaDuplicates} were already present)\n`
    + `  dropped (no location) ${dropped}\n`
    + `  countries             ${countries.size}\n`
    + `  precision             exact ${precisionCounts.exact}, venue ${precisionCounts.venue}, area ${precisionCounts.area}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`compile-shootings failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
