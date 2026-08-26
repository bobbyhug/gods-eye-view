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

const QUERY = `
SELECT ?item ?itemLabel ?date ?coord ?locCoord ?admCoord ?countryLabel ?locLabel ?killed ?injured WHERE {
  VALUES ?cls { wd:Q21480300 wd:Q473853 wd:Q118188839 wd:Q42915628 }
  ?item wdt:P31 ?cls ;
        wdt:P585 ?date .
  FILTER(YEAR(?date) >= ${SINCE_YEAR})

  # ── Civilian scope ────────────────────────────────────────────────────────
  # The shooting classes alone are not enough. Wikidata also types plenty of
  # armed-conflict killings as "mass shooting", and a first pass returned the
  # 2015 Zaria massacre (Nigerian Army, ~1,000 dead), the Zaki Biam army
  # reprisal, and the 2021 Kabul airport bombing. Those are war and state
  # violence, not a mall or a school.
  #
  # Each exclusion targets one way a conflict event reaches this query:
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q3199915 . }    # also a "massacre" — group-on-group
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q198 . }        # also a "war"
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q18493502 . }   # a suicide bombing, not a shooting
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q645883 . }     # a military operation
  # ...and the strongest signal of all: being part of a named armed conflict,
  # which is what separates an insurgency attack from a lone civilian attack.
  FILTER NOT EXISTS {
    ?item wdt:P361 ?conflict .
    ?conflict wdt:P31/wdt:P279* ?conflictType .
    VALUES ?conflictType { wd:Q350604 wd:Q198 wd:Q645883 }
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

/** @returns {Promise<Array<object>>} */
async function runQuery() {
  const url = `${ENDPOINT}?query=${encodeURIComponent(QUERY)}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Wikidata HTTP ${response.status} — ${(await response.text()).slice(0, 200)}`);
  }
  const payload = await response.json();
  return payload?.results?.bindings || [];
}

async function main() {
  process.stdout.write('Querying Wikidata…\n');
  const bindings = await runQuery();
  process.stdout.write(`  ${bindings.length} rows\n`);

  // One incident spans several rows when a field has multiple values.
  const byItem = new Map();
  for (const row of bindings) {
    const uri = row.item?.value;
    if (!uri) continue;
    if (!byItem.has(uri)) byItem.set(uri, []);
    byItem.get(uri).push(row);
  }
  process.stdout.write(`  ${byItem.size} distinct incidents\n`);

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
    sources: [{
      name: 'Wikidata',
      url: 'https://query.wikidata.org/',
      licence: 'CC0 1.0 Universal (public domain dedication)',
      redistributable: true,
      retrieved: new Date().toISOString().slice(0, 10),
    }],
    stats: {
      distinctIncidents: byItem.size,
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
    + `  plotted            ${incidents.length}\n`
    + `  dropped (no location) ${dropped}\n`
    + `  countries          ${countries.size}\n`
    + `  precision          exact ${precisionCounts.exact}, venue ${precisionCounts.venue}, area ${precisionCounts.area}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`compile-shootings failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
