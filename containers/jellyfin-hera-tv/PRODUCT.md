# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A four-person household watching its own media library. They browse on desktop browsers and on a TV in the Jellyfin web client's TV layout. The job is to find something worth watching and press Play.

## Product Purpose

Hera TV is a Jellyfin 12.4 server plugin that restyles the web client to look like the Apple TV app (tvOS 26). It adds Plex-style extras, and brings Seerr, Sonarr, Radarr and SABnzbd into the library, so requesting, downloading and watching happen in one place.

## Positioning

It's the household's own library presented as an Apple TV app, with the household's request and download tools built into the same pages, instead of in separate admin apps.

## Operating Context

- The plugin injects CSS and one script into Jellyfin's web client.
- Jellyfin's own page markup and React app stay in place: the plugin restyles them and adds plugin-rendered sections (home hero, the Episodes shelf, Seerr sections, search).
- The native Jellyfin apps aren't affected.
- Seerr requests are made as the signed-in user's linked Seerr account.

## Capabilities and Constraints

- Inputs are mouse, keyboard and a TV remote (in the TV layout).
- Light and dark schemes.
- Seerr, Sonarr, Radarr and SABnzbd are reached through the plugin's own server endpoints.
- Collections (box sets) come from Jellyfin's TMDb box-set scan. Seerr provides the full TMDB collection, including films that aren't in the library.

## Brand Commitments

- Visual fidelity to the Apple TV app.
- British English: "TV Shows", "Films", "Favourites", "Series N".
- Material Icons, no emoji, no eyebrow labels.

## Evidence on Hand

The library itself: real artwork, logos, overviews and ratings from TMDB, TVDB and Fanart. Demo collections: "The Dark Knight Collection" (3 films) and "Nanny McPhee Collection" (2 films).

## Product Principles

- The library is the interface: artwork leads, chrome recedes.
- Every page answers "what do I press to watch?" first.
- Things the library is missing appear where you'd expect them, ready to request, never in a separate place.
- Consistency across views beats one-off cleverness.

## Accessibility & Inclusion

- Text and controls meet a contrast of at least 4.5:1.
- Focus is always visible.
- Reduced motion is respected.
- Everything works with a remote and a keyboard.
