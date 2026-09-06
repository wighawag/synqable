#!/usr/bin/env bash
# Regenerates every derived asset in media/ from the authored sources.
# Authored:  logo.svg  icon.svg  preview.src.svg
# Generated: preview.svg  preview.png  icon.png
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo "error: $*" >&2; exit 1; }

# --- tooling -----------------------------------------------------------------
# Probe explicitly: ImageMagick will happily rasterise an SVG through its own
# weak internal delegate, which produces soft, mis-scaled output. We want Inkscape.
command -v inkscape >/dev/null || fail "inkscape is required (rasteriser + text-to-path)"
command -v magick   >/dev/null || fail "imagemagick 'magick' is required"
echo "rasteriser: $(command -v inkscape)"

# --- fonts -------------------------------------------------------------------
# Point fontconfig at the vendored Manrope for the length of the build, so the
# output never depends on what happens to be installed on this machine.
FC="${TMPDIR:-/tmp}/synqable-fc"
mkdir -p "$FC"
cat > "$FC/fonts.conf" <<EOF
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><dir>$(pwd)/fonts</dir><dir>/usr/share/fonts</dir><cachedir>$FC/cache</cachedir></fontconfig>
EOF
export FONTCONFIG_FILE="$FC/fonts.conf"
# NB: no pipe into `grep -q` here - it exits early, fc-list takes SIGPIPE, and
# `set -o pipefail` would fail the build even though the font resolved fine.
fc-list > "$FC/fonts.list" 2>/dev/null || true
grep -qi manrope "$FC/fonts.list" || fail "vendored Manrope not visible to fontconfig"

# --- drift check -------------------------------------------------------------
# The same mark geometry is authored in three files because each needs different
# ink and framing. That rots silently, so compare the load-bearing path data and
# fail BEFORE rendering rather than shipping three marks that no longer match.
SEAM='M128 8 V68 H88 V128 H168 V188 H128 V248'
INK='M128 0 V68 H88 V128 H168 V188 H128 V256 H0 V0 Z'
ACCENT='#e5399f'

# Presence is NOT enough: preview.src.svg carries the seam twice (mask + texture
# motif), so a "does it appear" test passes while one copy has silently drifted.
# Assert the exact NUMBER of copies that still match the canonical string, so a
# drifted copy shows up as a dropped count.
count() { local n; n=$({ grep -oF "$1" "$2" || true; } | wc -l); echo "${n// /}"; }
check_geom() { # file expected-seam-copies expected-ink-copies seam ink
	local f=$1 es=$2 ei=$3 seam=$4 ink=$5 gs gi
	gs=$(count "d=\"$seam\"" "$f"); gi=$(count "d=\"$ink\"" "$f")
	[ "$gs" = "$es" ] || fail "$f: expected $es copy/copies of the seam geometry, found $gs - the mark has drifted"
	[ "$gi" = "$ei" ] || fail "$f: expected $ei copy/copies of the ink geometry, found $gi - the mark has drifted"
}

check_geom logo.svg        1 1 "$SEAM" "$INK"
check_geom preview.src.svg 2 1 "$SEAM" "$INK"   # mask + texture motif share the seam

# Colour discipline: exactly one accent, everything else from the neutral ramp.
# Catches a half-recoloured file, which a presence check would wave through.
for f in logo.svg icon.svg preview.src.svg; do
	grep -qiF "$ACCENT" "$f" || fail "accent $ACCENT missing from $f"
	strays=$({ grep -oiE '#[0-9a-f]{3,6}' "$f" || true; } | tr 'A-F' 'a-f' | sort -u \
		| grep -vE '^#(0f172a|12141a|eef1f6|8e97a8|fff|000|e5399f)$' || true)
	[ -z "$strays" ] || fail "$f carries unexpected colour(s): $(echo $strays)"
done

# icon.svg is DELIBERATELY a different, simplified seam (one tooth, not four):
# the four-step seam mushes below 32px. It is pinned to its own expected value so
# an edit to it is still caught, rather than left unchecked.
ICON_SEAM='M116 12 V96 H174 V160 H116 V244'
ICON_INK='M116 0 V96 H174 V160 H116 V256 H0 V0 Z'
check_geom icon.svg 1 1 "$ICON_SEAM" "$ICON_INK"

# --- outline the type --------------------------------------------------------
# preview.svg is preview.src.svg with the two strings converted to paths, so the
# committed card renders identically on a machine with no fonts installed.
inkscape preview.src.svg --export-text-to-path --export-plain-svg -o preview.svg >/dev/null 2>&1

# --- render ------------------------------------------------------------------
# Always rasterise at 2x and downsample: hard-edged geometry stairsteps when
# rendered straight to size, and the downsample dithers away gradient banding.
inkscape preview.svg -o "$FC/preview@2x.png" -w 2560 >/dev/null 2>&1
magick "$FC/preview@2x.png" -resize 1280x640 -strip preview.png

inkscape icon.svg -o "$FC/icon@2x.png" -w 1024 >/dev/null 2>&1
magick "$FC/icon@2x.png" -resize 512x512 -strip icon.png

# --- prove the outlines still match the live text ----------------------------
inkscape preview.src.svg -o "$FC/live@2x.png" -w 2560 >/dev/null 2>&1
magick "$FC/live@2x.png" -resize 1280x640 -strip "$FC/live.png"
# Tolerance is exactly one 8-bit step, and nothing more. Text-to-path conversion
# leaves a handful of pixels rounded differently by 1/255 (currently one, at
# 1055,409) which is invisible and unfixable. A real regression - a glyph that
# shifted, a size that changed - moves many pixels by a large amount, so we gate
# on BOTH the magnitude and the count of pixels exceeding that one step.
maxdelta=$(magick preview.png "$FC/live.png" -compose difference -composite -format '%[fx:round(maxima*255)]' info:)
[ "$maxdelta" -le 1 ] || fail "outlined preview.svg differs from live text by $maxdelta/255 - the type moved"
overpx=$(magick compare -metric AE -fuzz 1% preview.png "$FC/live.png" null: 2>&1 || true)
[ "$overpx" = "0" ] || fail "$overpx px differ by more than one 8-bit step - the type moved"

echo "ok: preview.png icon.png preview.svg (outlines match live text exactly)"
