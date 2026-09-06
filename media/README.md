# synqable brand assets

## What the mark means

A single rounded field split by an interlocking stepped seam: two device states converging into one shape, where **the step size is the merge granularity**. That is synqable's actual differentiator, and the reason the mark is not a refresh loop or a cloud: every sync library merges, but this one lets you declare the unit at which a conflict resolves, field by field.

## Files

| File | Status | Produced by |
| --- | --- | --- |
| `logo.svg` | **authored** | the full mark; ink is `currentColor`, no background |
| `icon.svg` | **authored** | the *simplified* mark on an opaque plate |
| `preview.src.svg` | **authored** | the 1280x640 card, with live text |
| `fonts/Manrope-Variable.ttf` | vendored | Google Fonts, OFL (`fonts/OFL.txt`) |
| `preview.svg` | generated | `./build.sh` (text converted to outlines) |
| `preview.png` | generated | `./build.sh` (2560px, downsampled to 1280x640) |
| `icon.png` | generated | `./build.sh` (1024px, downsampled to 512x512) |

The exploration (contact sheets, rejected variants) was scratch and is not tracked; `media/concepts/` is gitignored so a future round does not get committed either. What it concluded is written down below instead, which is the part worth keeping.

Regenerate everything with `./build.sh`. It is deterministic: run it twice and the hashes match.

## Easy to fix by mistake

Each of these looks like an improvement and is not.

- **The accent is `#e5399f` (magenta), not amber, and not a bright colour.** The mark inverts with the theme and sits on a *white* npm page as well as a dark GitHub one, so the accent must be **mid-luminance** to survive both. Amber `#f59e0b` measures 2.05:1 against white and visually dissolves there; lime is 1.89:1; emerald and teal are ~2.4:1. Magenta measures 3.88:1 against white and 4.75:1 against `#12141a`. If you want a different accent, **measure it against both backgrounds first** rather than picking by eye on a dark screen.
- **`icon.svg` is deliberately NOT `logo.svg` on a plate.** The logo's seam has four steps; the icon's has one. The four-step seam turns to mush below 32px, which is exactly the size a favicon or repo avatar is seen at. Scaling the logo down instead of using the simplified icon is the mistake this file exists to prevent. Both geometries are pinned separately in `build.sh`.
- **The icon's plate is opaque on purpose.** A transparent icon with dark ink disappears on a dark browser tab.
- **Ink is `currentColor` in `logo.svg`.** One file serves light and dark; only the accent is a fixed hex. Do not hard-code the ink.
- **The type sizes are solved, not chosen.** `145.8372px` and `25.968px` are not nice numbers because they are answers, not decisions (see below). Rounding them to 146 and 26 silently changes the composition's measured widths.
- **Do not hand-edit `preview.svg`.** It is generated from `preview.src.svg`, and `build.sh` overwrites it. Edit the `.src.svg`, which is the readable, live-text version; the generated one is unreadable outlines.

## Solved type values

Typeface is **Manrope** (OFL, vendored so the build never depends on installed fonts). Weight resolution was verified by measuring rendered ink, not by trusting the family name: at 96px, `font-weight:800` produces 0.1338 mean alpha against `font-weight:400`'s 0.0811, so the heavy cut genuinely loaded.

| String | Spec | Solved size | Target ink box |
| --- | --- | --- | --- |
| `synqable` | Manrope 800 | `145.8372px` | 640px wide |
| tagline | Manrope 500 | `25.968px` | 560px wide |

Both are positioned by their **measured ink box**, not by their nominal `x`: the `x` attributes (`464.1665`, `467.9226`) are back-calculated from each string's left side bearing so the ink starts at exactly the same x. Change the copy and those numbers are wrong. Re-derive with:

```sh
export FONTCONFIG_FILE=/tmp/synqable-fc/fonts.conf   # created by build.sh
inkscape preview.src.svg --query-id=wordmark --query-x   # must equal 507
inkscape preview.src.svg --query-id=wordmark --query-width
```

To re-solve a size from scratch, set the string at a trial size, query the width, and scale by `target / measured` (text width is linear in size, so it converges in one step).

## Directions tried and dropped

So nobody re-proposes them cold.

- **Granularity ruler** (stacked bars subdivided 1 / 3 / 7): says the differentiator most literally and is the only one that reads as a *spreadsheet* at 32px. Halving the element count did not save it; stripes have no silhouette.
- **Tiebreaker** (two offset tiles, the later one accented): clean, but it is the standard copy/duplicate-file icon, and it says "last write wins", which competitors also say.
- **`q` lettermark**: by far the most legible at 16px, and it asserts nothing about the product. Kept only as a fallback.
- **Seam variants**: two-step (ink half reads as a bitten "C"), circular field (becomes a pie chart with a bite), and a 32-unit gutter (halves drift apart and stop reading as converged).
- **Accents rejected on measurement**: amber, lime, emerald, teal (all vanish on white). Rejected on meaning: crimson, rose, vermilion (red reads *error*, and this library's claim is that it converges without failing). Rejected as generic: violet and indigo, which score best of all but are the default dev-tool purple.

## Known gaps, accepted

- **At 16px the icon reads as a two-tone rounded square with a notch.** Distinctive enough to be ours, not distinctive enough to be recognised without the wordmark. The four-step logo seam is fully illegible at that size, which is why the simplified icon exists at all.
- **The outer silhouette is a rounded square**, so the mark's meaning lives in interior detail. That detail is the first thing to go when the mark is small.
- **The card is dark only.** `preview-light.png` was not built; add one and switch with `<picture>` if the README ever needs it.
- **No web-app icon set** (`favicon.ico`, maskable, apple-touch). synqable is a library, not an app, so only `icon.svg` / `icon.png` are shipped. If a docs site appears, generate the set from `icon.svg` with a tool rather than by hand, and feed the maskable generator a transparent-background variant so it does not end up as a box inside a box.
