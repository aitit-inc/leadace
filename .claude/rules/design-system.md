---
paths:
  - "frontend/**"
  - "landing/**"
---

# Design System: "Loop" (web app + LP)

One visual language for `frontend/` and `landing/`. Tokens and primitives live
in `frontend/src/app.css`; the LP is static, so `landing/public/index.html`
repeats the same values as CSS custom properties. Change a value in both places.

## Idea

LeadAce's promise is a loop: you send, the market answers, the next round gets
better. The UI encodes it with two colors:

- **Coral (`accent`) = what you send, and the one action to take next.** Drafts,
  sends, the primary button, work in progress. Same hue as the app icon.
- **Teal (`inbound`) = what comes back.** Replies, rejection reasons,
  learnings, positive outcomes.

Everything else is neutral. The icon (coral curves ending in nodes) is fixed;
its curve-and-node shape is the only decorative motif.

The audience is founders of 1–10 person B2B companies, not engineers: plain
words, readable sizes, outcomes said as a sentence before the numbers.

## Rules

- Tokens only. No raw hex and no Tailwind palette colors (`gray-*`, `white`,
  `black`) in components. Exceptions: third-party brand marks (the Google G),
  colors a sender sets for their `/q` page, and `bg-black/40` scrims behind
  dialogs and drawers (`::backdrop` doesn't reliably inherit tokens).
- One primary (coral) button per view region; other actions are
  `btn-secondary` or `btn-ghost`.
- Coral never decorates. Coral text or icons on a page ground use
  `accent-strong` (contrast); coral fills use `accent` with `on-accent` text.
- Teal marks inbound things only — never links, "info" or decoration.
- `danger` and `warning` are states, not accents; pair them with a word or icon.
- Separate by surface tone (`page` → `surface` → `surface-2`). Borders are for
  inputs, tables and dividers; shadows only for floating layers (menus,
  dialogs).
- Type: `font-sans` (Figtree) for UI and body. `font-display` (Bricolage
  Grotesque) only for page titles, headline sentences and big numbers.
  `font-mono` only for literal machine values (IDs, code, header values) — not
  for numbers, emails or labels.
- Size floor: body copy `text-sm` (14px); `text-xs` (13px) for meta only
  (timestamps, captions, badges). No arbitrary pixel sizes.
- Numbers that line up in columns or count get `tabular-nums`.
- Summaries lead with a sentence ("This week Ace contacted 14 companies.
  3 replied.") and then the figures.
- Radius: buttons, chips and pills `rounded-full`; inputs `rounded-lg`; cards
  `rounded-2xl`; dialogs `rounded-3xl`.
- Motion: state changes 150–250ms with `ease-spring`; `animate-rise` only
  where content arrives (chat messages, first run, LP hero). Nothing loops
  except progress indicators and the LP loop motif. `prefers-reduced-motion`
  turns motion off everywhere, LP included.
- Every color token has a light and a dark value; check both themes before
  shipping. The app switches on `.dark` (see frontend-architecture); the LP
  follows `prefers-color-scheme`.

## Tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `page` | `#EDF3F1` | `#0B1614` | App and LP ground |
| `surface` | `#FBFDFC` | `#12211E` | Cards, inputs, menus |
| `surface-2` | `#E0E9E6` | `#1A2D2A` | Hover, chips, sunken areas |
| `border` | `#D2DDD9` | `#253B37` | Inputs, tables, dividers |
| `text` | `#0F2826` | `#E4EFEC` | Primary text |
| `text-secondary` | `#3F5A57` | `#A7BCB7` | Body and supporting text |
| `text-muted` | `#5B716D` | `#7D938E` | Meta, placeholders |
| `accent` | `#E87462` | `#E87462` | Coral fills (primary button, progress) |
| `accent-strong` | `#B0452F` | `#F4A08D` | Coral text and icons |
| `on-accent` | `#1F0E0A` | `#1F0E0A` | Text on coral fills |
| `inbound` | `#1E6E68` | `#6CC2B7` | Replies, reasons, learnings, positive state |
| `warning` | `#8A5A00` | `#E5B35A` | Needs a decision soon |
| `danger` | `#B4233C` | `#F27E93` | Failed, blocked, destructive |

## Primitives

Defined with `@utility` in `app.css`: `btn` with `btn-primary`,
`btn-secondary`, `btn-ghost`, `btn-danger` (a final destructive confirm) or
`btn-danger-ghost` (a destructive action sitting among other row actions); add
`btn-sm` for dense rows. `card`; `field` for inputs, selects and textareas
(`aria-invalid="true"` draws the error border); `chip` for badges. Layout
and spacing come from utilities; to restyle a primitive, change it in
`app.css`, not inline.

## LP

The hero says who it is for, and a "Built for / Not for" strip follows it, so a
visitor knows at a glance whether it fits them. Headlines don't call the
product an "AI SDR" or "AI sales rep".
