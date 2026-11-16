---
version: 1
slug: "web-hera-tv-css"
primary_target: "web/hera-tv.css"
related_targets: []
---

Scope: Jellyfin 12.4 web client (desktop + TV layout), delivered by the Hera TV plugin. Mode: Experience (browsing and watching a household's library).
Audience: a four-person household on desktop browsers and an LG/TV-browser; the job is to find something and press Play.
Constraints: Jellyfin's own DOM and React app stay intact; theme via CSS, behaviour via one script; native apps untouched; no accent colour, no violet; mouse behaviour like tv.apple.com.

## Direction contract

seed: none (pinned)
THESIS: The library is the interface. Artwork fills the screen; chrome is a floating glass capsule and white type. Refuses Jellyfin's default of a solid header bar, a poster beside a ribbon, and coloured accents.
OWN-WORLD: Pure black ground; white in three strengths; glass (30px blur, 1px top highlight) only on the tab capsule, secondary buttons, menus and player; 12–14px artwork radii; white capsule for the primary action; SF on Apple devices, Inter elsewhere.
STORY: Visitors see a featured title at full bleed, press Play or move to the shelves, and open a show to its episodes in one step.
FIRST VIEWPORT: Home: hero key art edge to edge; logo artwork, meta line, three-line synopsis and Play/info/+ at lower left; pager and pause at lower right; the first shelf's title peeks over the hero foot. Tabs centred at the top in a glass capsule, the server name at left.
FORM: tvOS 26 Apple TV app, tv.apple.com interaction for pointer; hero carousel and season shelf rendered by the plugin.
SIGNATURE: The hero's pager capsule fills with the slide's progress, the crossfade waits for a decoded backdrop, and hover, focus, a hidden tab or the pause button holds it.
