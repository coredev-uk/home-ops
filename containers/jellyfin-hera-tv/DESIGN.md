# Hera TV design

Hera TV is a Jellyfin web-client theme and script modelled on Apple's TV app: tvOS 26 for the look, tv.apple.com for how a mouse uses it. It covers the desktop and TV layouts. Phones keep Jellyfin's own layout, which the colours and type still restyle.

## What the Apple TV app does, and what Hera TV takes from it

| Surface        | Apple TV app                                                                                                                                                                              | Hera TV                                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ground         | Pure black; artwork carries the colour                                                                                                                                                    | `#000`; no accent colour anywhere                                                                                                                                                                                           |
| Text           | White in three strengths: label, secondary (~60%), tertiary (~30%)                                                                                                                        | `--hera-label`, `--hera-label-2` (64%), `--hera-label-3` (52%: the lowest that holds 4.5:1 on black)                                                                                                                        |
| Selection      | White: the focused tab, the primary button and the focus ring are white with black text                                                                                                   | Same; a favourite's heart sits on a white disc; on a TV only the focused control in a row stays white                                                                                                                       |
| Navigation     | A floating glass capsule of tabs, centred at the top; no bar behind it until content scrolls under                                                                                        | The MUI app bar restyled into that capsule; the first link becomes Home; the server name is drawn at the left; the bar frosts once scrolled                                                                                 |
| Material       | Glass only on chrome: the tab bar, secondary buttons, menus, player controls                                                                                                              | `--hera-glass` with a 30px blur, plus a 1px top highlight                                                                                                                                                                   |
| Home           | A full-bleed hero (key art, logo artwork, a meta line, a three-line synopsis, a white Play capsule, a round + button) that crossfades between titles; the first shelf peeks over its foot | Plugin-rendered hero of unwatched titles with key art, 8 s per title, previous/next either side of a pager whose active capsule fills with progress, and a pause                                                            |
| Shelves        | Rounded artwork, 12–16px radius, title below and left-aligned, no chrome                                                                                                                  | Cards restyled; the first artwork aligns with the section title; paddles appear on hover                                                                                                                                    |
| Show page      | Key art fills the top with the logo, meta, synopsis and buttons at its lower left; then a season picker over a horizontal shelf of episode stills                                         | The same order: banner, logo, meta, synopsis, buttons, then plugin-rendered season tabs over an episode shelf, then credits                                                                                                 |
| Cast           | Round portraits, centred names                                                                                                                                                            | `personCard` made circular                                                                                                                                                                                                  |
| Player         | A thin white scrubber that thickens on hover, monochrome controls, a dark scrim                                                                                                           | Scrubber, buttons and scrim restyled                                                                                                                                                                                        |
| Control Center | A glass panel of round-icon tiles that turn white when on, the signed-in profile at the top                                                                                               | The profile button opens it: subtitles, autoplay and Recently Added tiles saved to the user's settings, Quick Connect, what is playing elsewhere, an admin library scan, and links; "All options" opens Jellyfin's own menu |
| Type           | SF Pro Display for headings, SF Pro Text for body; tight tracking on large sizes                                                                                                          | System SF on Apple devices; self-hosted Inter (OFL) elsewhere                                                                                                                                                               |
| Motion         | Spring-like ease-out; artwork lifts on focus                                                                                                                                              | `cubic-bezier(.22,1,.36,1)`; cards lift 2px and their artwork zooms 3% inside the frame; buttons press to 95%; no tilt                                                                                                      |

## Departures

Each departure follows one of the rules this theme is built under.

- **No parallax tilt.** The tvOS focus engine tilts artwork under the thumb. With a mouse that reads as a gimmick, so cards lift and zoom inside the frame instead.
- **No eyebrow labels.** tvOS sets "EPISODE 3" in small caps above an episode's title. Here the number leads the title on the same line, set in tertiary grey.
- **The violet Jellyfin mark is gone.** The server's name stands in white at the left.

## Tokens

The tokens are custom properties on `:root` in `web/hera-tv.css`. The theme also sets Jellyfin 12's own `--jf-palette-*` and `--mui-palette-*` variables, so stock components it doesn't style directly still pick up the palette.

## Where it applies

| Client                                                   | Hera TV                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Desktop browsers, Jellyfin Desktop                       | Yes                                                                       |
| LG webOS and other clients that load the server's web UI | Yes                                                                       |
| TV layout                                                | Larger type, white-ring focus, remote navigation into and out of the hero |
| Android TV, Swiftfin, Infuse                             | No: these use their own native interfaces                                 |
