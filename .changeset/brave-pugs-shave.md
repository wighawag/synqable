---
'synqable': patch
---

Add brand assets: a theme-agnostic vector mark, a simplified icon for small sizes, and a 1280x640 social card carrying the wordmark and tagline. The README now leads with the card, and `media/build.sh` regenerates every derived asset deterministically with a drift check across the three copies of the mark geometry.
