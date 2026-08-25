# Camera permission requests — Downtown Miami

Three operators publish cameras this project would like to display. Each needs
written permission before any public or commercial use. Local/personal use is a
separate question the terms below address unevenly — these drafts ask plainly.

Replace `[YOUR NAME]`, `[YOUR EMAIL]` and the project URL before sending.

---

## 1. Greater Miami Convention & Visitors Bureau (+ Ozolio)

**To:** the GMCVB web/marketing contact via miamiandbeaches.com, cc Ozolio support
**Subject:** Permission request — displaying two Miami webcam feeds in an open-source 3D map

Hello,

I maintain a personal, open-source 3D map of live public data (aircraft, ships,
satellites, traffic cameras). I would like to display two of the webcams
published on your Miami Webcams page:

- Bayfront Park / Downtown Miami (Ozolio OID `EMB_PIWS000003D6`)
- Biscayne Bay & PortMiami, at the DoubleTree Grand (OID `EMB_FDVN00000417`)

and two further Ozolio cameras covering the downtown skyline (`CID_KSNR000018D5`,
`CID_NZWC000018EE`).

Specifically, I would poll the still-image endpoint that your own embed uses
(`relay.ozolio.com/pub.api?cmd=poster&oid=...`) no more often than once every
30 seconds, and project the frame onto a 3D model of the city, with
"Greater Miami & Miami Beach" and the host property credited on screen and a
link back to miamiandbeaches.com.

I am asking because your site terms do not address webcam reuse and
`relay.ozolio.com/robots.txt` disallows automated access — so I would rather have
your explicit answer than assume. I am happy to accept any conditions on refresh
rate, attribution wording, caching, or scope.

May I have written permission? If Ozolio rather than GMCVB owns this decision,
I would appreciate being pointed to the right contact.

Thank you,
[YOUR NAME] — [YOUR EMAIL]

---

## 2. WeatherSTEM

**To:** media@weatherstem.com
**Subject:** Written permission request — two Miami-Dade sky camera images

Hello,

Your Media Usage Guidelines require written permission to reuse camera imagery,
so I am writing to ask for it.

I maintain a personal, open-source 3D map of live public data. I would like to
display the current snapshot from two Miami-Dade stations:

- `fswnmdcwolfson` — Miami Dade College Wolfson Campus
- `uhealth` — University of Miami Health System

I would fetch `images.weatherstem.com/skycamera/miamidade/<station>/cumulus/snapshot.jpg`
no more often than once per minute, display it live only (no recording, no
archive, no timelapse), and credit both WeatherSTEM and the host institution
on screen with a link to your station page.

I understand recording is prohibited and I do not intend to record. If this use
needs a LiveStream Token or a license, please tell me which applies.

Thank you,
[YOUR NAME] — [YOUR EMAIL]

---

## 3. FDOT District 6 (FL511 traffic cameras)

**To:** the FDOT D6 ITS / SunGuide contact (via fdotmiamidade.com)
**Subject:** Written consent request — FL511 camera snapshots in an open-source map

Hello,

The FL511 conditions at fl511.com/privacy state that content is "for individual
use only and is not available for re-sale or re-use without the express written
consent of FDOT". I would like to request that consent.

I maintain a personal, open-source 3D map that displays live public data. It
currently shows FL511 camera snapshots (`fl511.com/map/Cctv/<id>`) for Miami-Dade
and Broward, projected onto a 3D model of the road network. It is non-commercial
and the source code is public.

Concretely: snapshot images only (never the authenticated video streams), polled
no faster than once every 90 seconds, displayed live with FDOT/FL511 credited,
never recorded or archived.

Two smaller notes you may find useful, offered in good faith:

1. Roughly 169 of the ~4,870 records in the camera list carry coordinates
   identical to another camera's. For example camera 4260 ("419A-836CW140 at
   NW 7th Ave") is published with camera 4259's longitude and plots about 1.4 km
   from its true position; the FDOT DIVAS ArcGIS layer has it correctly.
2. The Brickell Bridge CCTV camera (site 5360 / image 5359) is registered and
   flagged video-enabled but its still image has been returning the "No live
   camera feed" placeholder.

May I have written consent for the use described above? I am glad to adjust
refresh rate, attribution, or scope to whatever you require.

Thank you,
[YOUR NAME] — [YOUR EMAIL]
