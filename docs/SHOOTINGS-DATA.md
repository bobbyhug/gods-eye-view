# Mass shootings layer — data sources

The `shootings` layer plots civilian mass shootings, 2001–present. This
documents where the data comes from, what was rejected and why, and what the
layer cannot tell you.

## What is in scope

Civilian mass shootings: school, university, workplace, place of worship,
retail, nightclub and public-space attacks.

**Not in scope, and actively filtered out:** armed conflict, insurgency,
military operations and state violence. These are a different subject with
different data, and merging them would misrepresent both.

That filtering is not automatic. Wikidata types plenty of conflict killings as
"mass shooting", and a first pass returned the 2015 Zaria massacre (Nigerian
Army, ~1,000 dead), the Zaki Biam army reprisal, and the 2021 Kabul airport
bombing. The compiler excludes anything additionally typed as a massacre, war,
suicide bombing or military operation, and anything that is `part of` a named
armed conflict — that last check does most of the work.

Terrorist attacks are **not** excluded. Some of the worst civilian mass
shootings — Christchurch, Utøya — are classed as terrorism, and dropping them
to keep the category tidy would misrepresent the subject as badly as including
a war.

## Perpetrators are never recorded

Not fetched, not stored, not served. The SPARQL `SELECT` does not ask for them,
and `/api/shootings` strips the field names anyway as a second line of defence.

This follows the "No Notoriety" / "Don't Name Them" guidance that criminology
researchers and most newsrooms now work to, on evidence that naming attackers
contributes to contagion. It is also the only honest scope for a map: the
subject is *where* this happened and *how many people it took*.

## The source: Wikidata

**Licence: CC0 1.0** — a public-domain dedication. No restriction on
redistribution.

Compiled by `scripts/compile-shootings.mjs`, which queries the public SPARQL
endpoint and writes `data/shootings.json`. Re-run it to refresh:

```bash
node scripts/compile-shootings.mjs
```

Four incident classes, all firearm-specific:

| QID | Class |
| --- | --- |
| Q21480300 | mass shooting |
| Q473853 | school shooting |
| Q118188839 | spree shooting |
| Q42915628 | mass shooting in the United States |

Coordinates resolve through a fallback chain, and the precision is recorded per
incident rather than discarded — a point at a city centroid is a much weaker
claim than one at the building:

1. `P625` on the incident itself → `exact`
2. `P625` on its venue (`P276`) → `venue`
3. `P625` on its administrative area (`P131`) → `area`

Incidents with no location at any precision are **dropped, not guessed**. A
marker is a claim about where someone died.

## What was rejected, and why

Every well-known catalogue is licence-blocked for redistribution. This is the
single biggest constraint on the layer, and it is worth being explicit about:

| Source | Verdict |
| --- | --- |
| Gun Violence Archive | Explicitly proprietary, no redistribution |
| Mother Jones | No open licence |
| The Violence Project | Gated; redistribution forbidden |
| Everytown | Reuse prohibited by terms |
| K-12 School Shooting Database | No licence granted |
| Global Terrorism Database (START/UMD) | Restrictive proprietary EULA |
| ACLED | Not redistributable |
| gunviolence.eu (Project INSIGHT) | Redistribution explicitly forbidden |
| Mass Shooting Tracker | Informal permission, not a licence |
| AOAV Global Mass Shooting Database | No licence stated |
| Rockefeller GMSDB | No licence stated |

Usable but not yet integrated:

| Source | Licence | Note |
| --- | --- | --- |
| Stanford MSA | CC BY 4.0 | 335 US incidents with coordinates. Ends 2016. |
| Washington Post School Shootings | CC BY-NC-SA 4.0 | 428 incidents. **Non-commercial** clause. |
| Wikipedia list articles | CC BY-SA 4.0 | Hundreds of incidents, but no coordinates — each needs geocoding, and the ShareAlike term is viral. |

## Coverage is uneven, and the layer says so

The United States accounts for roughly half of all plotted incidents. That is
**not** because half of the world's mass shootings happen there — it is because
the US has many organisations cataloguing these events and most countries have
none.

Large parts of Africa, Asia and Latin America are sparse or empty here.
Individual incidents in those regions are well documented in news reporting;
what does not exist is anyone maintaining a machine-readable catalogue of them.

Every regional researcher reached the same conclusion independently: there is no
purpose-built, openly-licensed, machine-readable dataset of civilian mass
shootings for Africa, the Middle East, Latin America, Asia, or even Europe as a
whole. Wikidata is the only thing that works globally, and its coverage follows
the attention of Wikipedia's editors.

The layer's `coverageNote` states this, so the map does not quietly imply that
empty regions are safe ones.
