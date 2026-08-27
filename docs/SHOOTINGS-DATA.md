# Mass Killings layer — data sources

The `shootings` layer (shown as **Mass Killings**) plots recorded mass-casualty
killings, 2001–present. This documents where the data comes from, what was
rejected and why, and what the layer cannot tell you.

**3,326 incidents across 131 countries** — 2,390 civilian, 936 military.

## Two categories, and a switch

Incidents are **classified, not filtered out**. The row carries three chips:

| Chip | Shows |
| --- | --- |
| `CIVILIAN` | Attacks by individuals — the original subject of this layer |
| `MILITARY` | Armed conflict, insurgency, state violence, attacks by armed groups |
| `BOTH` | Everything |

This replaced an earlier design that simply deleted conflict events. Deciding
for the reader which killings count was the wrong call; showing both and
labelling them honestly is better. Military markers take a cool hue so the two
stay distinguishable when BOTH is selected.

### How an incident is classified

`military` if **any** of these hold, otherwise `civilian`:

1. It is `part of` a named armed conflict, war or military operation.
2. Its **perpetrator is an organisation** rather than an individual. This is the
   discriminator that actually separates the two subjects — a civilian mass
   killing is committed by a person, whereas an armed group or a state army
   doing the same thing is a conflict event however it is filed. It correctly
   catches the Zaki Biam massacre (Nigerian Army) and Garissa (Al-Shabaab) while
   leaving Christchurch, Las Vegas and Buffalo untouched.
3. It is typed as war, military operation, war crime, genocide or airstrike.
4. **It killed 300 or more people.** Crude, and deliberately so. The structural
   checks leak: the Tamil massacre (40,000), the Masalit genocide (10,800) and
   the Camp Speicher executions (1,570) carry no organisation, no part-of link
   and no conflict type, so every principled signal missed them. The deadliest
   civilian mass killings on record are far below this line — Utøya 77, Bataclan
   90, Las Vegas 60 — so nothing an individual does reaches it.

Check 2 reads the perpetrator's *type*, never their identity, and nothing from
that query is stored or served.

**Known residue.** Classification is imperfect in the CIVILIAN direction: the
2017 Sinai mosque attack, the In Aménas siege and the 2022 Plateau State
massacres sit there despite being conflict-zone events. They name no
organisation, fall under the 300 threshold, and nothing marks them as conflict.
Removing them would mean hand-blacklisting titles, which does not generalise.

Terrorist attacks are **not** automatically military. Some of the worst civilian
mass killings — Christchurch, Utøya — are classed as terrorism, and filing them
under armed conflict would misrepresent them.

## Photographs are of the PLACE

104+ incidents carry a photograph of where it happened — the school, the mall,
the island. Sourced from the **venue's** image (`P276` → `P18`).

The incident's own `P18` is **never** used: on Wikidata it is frequently a
photograph of the perpetrator. Settlements and administrative areas are also
excluded as photo venues, because their image is a city skyline, and a generic
Copenhagen view beside an incident implies a precision the record does not have.
That filter is what takes it from 299 loose matches to photographs actually of
the place.

## Recorded motive

Roughly 82 incidents carry a short motive — "antisemitism", "homophobia",
"opposition to immigration" — from `P828`, the level newsrooms and criminologists
publish at.

Deliberately **not** a narrative: no manifesto text, no quotations, no
perpetrator writing. A category describing why a class of attack happens is a
different object from an attacker's own words.

`P14359` "motive" is the semantically correct property and was tried first, but
it has essentially no usage on these items and returned zero. `P828` is a mixed
bag — alongside real motives it returns "blunt trauma" and "surface-to-air
missile", which are how someone died rather than why — so weapon, injury and
disease values are filtered out at compile time and a short mechanism denylist
catches the rest client-side.

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

Incidents are matched in two tiers.

**Tier 1** — already unambiguously a shooting, matched with the subclass walk:

| QID | Class |
| --- | --- |
| Q21480300 | mass shooting |
| Q473853 | school shooting |
| Q118188839 | spree shooting |
| Q42915628 | mass shooting in the United States |

**Tier 2** — broader crime classes, but only when a **firearm** is recorded as
the weapon (`P520` walking `P279*` to Q12796):

| QID | Class |
| --- | --- |
| Q750215 | mass murder |
| Q2223653 | terrorist attack |
| Q3199915 | massacre |

Tier 2 exists because tier 1 alone misses some of the most significant
incidents of the period. Wikidata does not type the **Christchurch mosque
shootings** (51 dead) as a mass shooting at all — it is "terrorist attack" plus
"mass murder". The **Buffalo Tops supermarket attack** is typed "massacre".
Neither appeared until this tier was added.

The firearm requirement is what keeps it honest. `P520` alone counts bombs,
vehicles and aircraft as "armament", which pulled in the September 11 attacks,
the Madrid train bombings, the Sri Lanka bombings and the Nice truck attack —
436 items. Requiring the weapon to be a firearm cuts that to 139 and keeps the
incidents the tier was added for.

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

**Stanford MSA is integrated** as a second source: CC BY 4.0, 254 US incidents
from 2001 onward, all with real coordinates. Cite as *"Stanford Mass Shootings
in America, courtesy of the Stanford Geospatial Center and Stanford Libraries"*.
Its CSV reuses `CaseID` — case 156 is two entirely different incidents — so ids
are composed from date and coordinates instead.

Usable but not yet integrated:

| Source | Licence | Note |
| --- | --- | --- |
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
