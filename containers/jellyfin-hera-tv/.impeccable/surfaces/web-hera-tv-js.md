---
version: 1
slug: "web-hera-tv-js"
primary_target: "web/hera-tv.js"
related_targets: ["web/hera-seerr.js"]
---

Scope: collection (box set) detail pages in the Jellyfin web client, desktop and TV layout. Mode: Experience.
Audience and job: the household picks a franchise and watches it in order. What they need to know: which film is next, what each film is, and what the library is missing.
Constraints: Jellyfin's own detail page stays in place (banner, buttons, details, TMDB links); the plugin adds the shelf and steers Play. Missing films come from Seerr, matched by TMDB collection.

## Direction contract

seed: seed:0724650a91bd215a (second deal; the user picked the dealt "shelf" structure on the recommendation that it is the closest to the Apple TV app)
THESIS: A collection is read in order, like a season. Its films sit on the same wide-still shelf as a show's episodes, numbered in release order. This replaces Jellyfin's grid of posters under a generic "Films" heading.
OWN-WORLD: Hera as it is: the banner from film and show pages, the Episodes shelf grammar (16:9 stills, 2px edge on the next film, a light frost and a glass disc on hover), white type in three strengths, and the film's own logo over its key art.
STORY: Visitors see the collection's art and "Play <next film>". Below it are the films in order, with the next one marked. A missing film sits in its place, dimmed with a Request disc, and opens the title sheet. Linked users also get "Request N Missing Films".
FIRST VIEWPORT: The banner: collection logo, "N films · first–last year · total runtime · certificate", synopsis, "Play <next film>" and the round buttons. The Films title peeks over the banner's foot, as Episodes does.
FORM: The tvOS Apple TV app's season shelf, applied to a bundle.
SIGNATURE: Play names the film it starts and starts the next unwatched film (or resumes one in progress). Numbering is a CSS counter, so missing films slot in and the numbers stay right.
