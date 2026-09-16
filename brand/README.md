# Brand assets

Canonical source files for the LeadAce logo and derived assets.

| File | Purpose |
|---|---|
| `logo-source.png` | Original generated art (Gemini, 512×512, terracotta on transparent) |
| `logo.svg` | Traced vector, `fill="currentColor"` — use in app code (inherits CSS color) |
| `logo-color.svg` | Same path, fill baked to `#E87462` — use for favicons, emails, OG, anywhere CSS `color` cannot apply |
| `og.svg` / `og.png` | 1200×630 social share image (logo + wordmark + tagline) |
| `apple-touch-icon.svg` / `apple-touch-icon.png` | 180×180 app icon — coral filled square with a light glyph (designed for messenger preview legibility, inverted from the brand's coral-on-light) |

## Regenerating favicons

Favicons are generated from `logo-color.svg`. To regenerate:

```bash
# From brand/
magick -background none -size 512x512 logo-color.svg favicon-512.png
magick favicon-512.png -resize 192x192 favicon-192.png
magick -background none -size 256x256 logo-color.svg -morphology Dilate Octagon:3 -resize 32x32 favicon-32.png
magick -background none -size 128x128 logo-color.svg -morphology Dilate Octagon:2 -resize 16x16 favicon-16.png
magick favicon-32.png favicon-16.png favicon.ico
# Then copy to frontend/static/ and landing/public/
```

Small sizes use `-morphology Dilate` before downsampling because the stroke density is too fine to render cleanly at 16–32px otherwise.

## Regenerating apple-touch-icon

`apple-touch-icon.png` is generated from its own source `apple-touch-icon.svg` (coral `#E87462` filled square + `#EDF3F1` glyph), not `logo-color.svg`. The inverted color scheme is deliberate: messenger link previews (iMessage / Slack / Notes) shrink the icon to ~24–32px, where light-on-coral has visual mass that coral-on-light loses. That is also why the glyph takes `page` rather than `on-accent`, which the design system would otherwise call for on a coral fill.

```bash
# From brand/
magick -background none -size 720x720 apple-touch-icon.svg \
  -morphology Dilate Octagon:8 \
  -resize 180x180 -alpha remove -alpha off apple-touch-icon.png
# Then copy to frontend/static/ and landing/public/
```

If the master path in `logo-color.svg` is updated, port the new path data into `apple-touch-icon.svg` (keep the `<rect>` background and the `#EDF3F1` `fill` on the `<g>`) and re-run the magick command above.

## Regenerating the OG image

`og.png` is rasterized from `og.svg`. Update the SVG (wordmark, tagline, colors), then:

```bash
# From repo root
rsvg-convert -w 1200 -h 630 brand/og.svg -o brand/og.png
cp brand/og.png frontend/static/og.png
cp brand/og.png landing/public/og.png
```

Use `rsvg-convert`, not ImageMagick: the wordmark is Bricolage Grotesque and the tagline is Figtree, and only librsvg resolves them through fontconfig — `magick` looks fonts up in its own type list and fails with `unable to read font`. Install both first:

```bash
brew install --cask font-bricolage-grotesque font-figtree
```

The three copies are served as `og:image` from `brand/` (canonical), `app.leadace.ai/og.png`, and `leadace.ai/og.png`.

`landing/public/index.html` and `frontend/src/app.html` both point at `og.png?v=N` — bump `N` in both whenever the image changes, or the social-card caches keep serving the old one.

## Regenerating the trace from the source PNG

If the source art is updated:

```bash
magick logo-source.png -alpha extract -negate -resize 1024x1024 -threshold 50% logo-mask.pbm
potrace -s --flat -t 5 -a 1.334 -O 0.4 -o logo-raw.svg logo-mask.pbm
# Hand-clean logo-raw.svg → logo.svg (use fill="currentColor")
# Duplicate with sed → logo-color.svg (bake #E87462)
```

Requires `potrace` (`brew install potrace`) and ImageMagick.

## Brand colors

The palette is the "Loop" design system's; its full token table lives in
[.claude/rules/design-system.md](../.claude/rules/design-system.md). These files
bake values in because CSS `color` cannot reach them:

| File | Value |
|---|---|
| `logo-color.svg`, favicons | `#E87462` — `accent` |
| `apple-touch-icon.svg` | `#E87462` square, `#EDF3F1` glyph — `accent` and `page`, light-on-coral for small sizes |
| `og.svg` ground | `#EDF3F1` — `page`, light |
| `og.svg` wordmark / tagline | `#0F2826` / `#3F5A57` — `text` / `text-secondary` |
