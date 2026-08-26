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
bombing. The compiler excludes anything typed as a war, war crime, suicide bombing or
military operation, anything that is `part of` a named armed conflict, and
anything whose **perpetrator is an organisation rather than an individual**.

That last check is the one that actually separates the two subjects: a civilian
mass shooting is committed by a person, whereas an armed group or a state army
doing the same thing is a conflict event however it is filed. It removes the
Zaki Biam massacre (Nigerian Army), the Garissa University attack (Al-Shabaab)
and the Barsalogho massacre, while leaving Christchurch, Las Vegas and Buffalo —
all lone individuals — untouched. It reads the perpetrator's *type*, never their
identity, and nothing from that query is stored or served.

"Massacre" is deliberately **not** an exclusion. It reads as a war word but is
applied just as often to civilian mass shootings; excluding it deleted the 2017
Las Vegas shooting (60 dead) and the Buffalo Tops attack along with the conflict
events.

**Known residue.** A few conflict-zone events still get through — the 2017 Sinai
mosque attack, the In Aménas siege, the 2022 Plateau State massacres. They carry
firearms, no organisation is recorded against them, and nothing marks them as
conflict. Removing them would mean hand-blacklisting titles, which does not
generalise. They are a real limitation rather than an oversight.

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
