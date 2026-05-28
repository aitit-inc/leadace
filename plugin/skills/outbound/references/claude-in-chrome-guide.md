# claude-in-chrome MCP Browser Automation Guide

Used for browser operations such as form submission and SNS DMs. All executed via the `mcp__claude-in-chrome__*` MCP tools.

## Quick start

```
1. mcp__claude-in-chrome__tabs_context_mcp { createIfEmpty: true }
   -> returns tabId of an empty tab in the MCP tab group

2. mcp__claude-in-chrome__navigate { tabId, url: "https://example.com" }

3. mcp__claude-in-chrome__read_page { tabId }
   -> accessibility tree with refs (ref_1, ref_2, ...)

4. mcp__claude-in-chrome__form_input { tabId, ref: "ref_5", value: "input text" }

5. mcp__claude-in-chrome__computer { tabId, action: "left_click", ref: "ref_13" }
```

There is no explicit `close`. The MCP tab group is per-conversation; tabs persist until the user closes them.

## Core tools

### Navigation & inspection

| Tool | Purpose |
|---|---|
| `tabs_context_mcp { createIfEmpty: true }` | Get current MCP tab group + tabIds. Always call once at the start of a conversation. The `createIfEmpty: true` flag creates a new window+tab if no group exists |
| `tabs_create_mcp {}` | Create a new empty tab in the existing MCP tab group |
| `navigate { tabId, url }` | Navigate the tab. Also accepts `"forward"` / `"back"` for history. Defaults to `https://` if no protocol |
| `read_page { tabId, filter?, ref_id?, depth?, max_chars? }` | Accessibility tree of the page with element refs. **Default (no filter) keeps labels and headings — use this for forms.** `filter: "interactive"` strips labels (only inputs/buttons). `ref_id` focuses on a sub-tree. Default `max_chars: 50000` |
| `find { tabId, query }` | Natural-language element search (e.g., `"contact form"`, `"SEND button"`). Returns up to 20 matches with refs. Often faster than `read_page` for known elements |
| `get_page_text { tabId }` | Extract article-like body text. Falls back to error on script-heavy pages — `read_page` is more reliable |

### Interaction

| Tool | Purpose |
|---|---|
| `form_input { tabId, ref, value }` | Set value in form element. `value: "string"` for text/select, `value: true/false` for checkbox/radio |
| `computer { tabId, action: "left_click", ref }` | Click an element by ref. Also supports coordinates (`coordinate: [x, y]`) |
| `computer { tabId, action: "key", text: "Enter" }` | Press a key. Multiple keys: `"Backspace Backspace Delete"`. Modifiers: `"cmd+a"` |
| `computer { tabId, action: "scroll_to", ref }` | Scroll an element into view |
| `computer { tabId, action: "screenshot" }` | Take a screenshot |

### Inspection helpers

| Tool | Purpose |
|---|---|
| `javascript_tool { tabId, action: "javascript_exec", text }` | Execute JS in the page. **Do not use `return`** — the last expression is auto-returned. Useful for: reading DOM state, extracting `window.FB_PUBLIC_LOAD_DATA_`, getting `document.documentElement.outerHTML`, verifying form state after `form_input` |
| `read_network_requests { tabId, urlPattern?, limit?, clear? }` | List HTTP requests this tab made. **Tracking starts the first time this tool is called for the tab.** Always call once **before** the action you want to track. Returns method, URL, statusCode |

## Critical operating rules

These come from real-world experience. Failing to follow them causes flaky form-submission detection.

1. **Start network tracking BEFORE the click that triggers the request**: `read_network_requests` only records from its first call onward. Call it once with `clear: true` *before* `computer(left_click, ...)`, then call it again afterwards to read the result.
2. **Sequence `read_network_requests(clear:true)` → click → read** — do not parallelize them.
3. **Capture form values before submitting**: some forms (e.g. about.surpassone.com) clear all fields the moment SEND is clicked, regardless of success. Snapshot the body text from your `form_input` calls, not from a post-submit `read_page`.
4. **5xx is ambiguous**: HTTP 5xx usually means failure, but some backends queue messages async and still deliver. Treat 5xx as `failed` to keep the rule simple, and document the edge in the outreach record.
5. **Cross-domain navigation clears network history**: if the form posts to a third-party endpoint and the tab navigates to a thank-you page on a *different* domain, history before the navigation is gone. Read network *first*, then verify page state.
6. **Radio inputs return empty success messages**: `form_input(ref, true)` on a radio sometimes echoes no diff message. Verify with `javascript_tool` if certainty matters.

## Targeting elements

Three ways to get a `ref`:

```
A) read_page → scan tree for the element you want, copy its ref_N
B) find { query: "<natural language>" } → faster for known UI ("CONTACT button", "email input")
C) read_page { ref_id: "ref_77" } → focus on a parent (e.g. the form) to get a smaller, cleaner sub-tree
```

For very large pages, prefer (B) or (C) over a full `read_page` — `max_chars: 50000` truncates and you lose context.

## Reading raw HTML or JS state

```
javascript_tool { tabId, action: "javascript_exec",
                  text: "document.documentElement.outerHTML" }
```

Returns the full HTML as a string. Use this when you need attributes the accessibility tree drops (data-*, hidden inputs, JS globals).

For Google Forms entry IDs, see the dedicated section in `form-filling.md`.

## SNS DMs

Login session is required. claude-in-chrome runs inside the user's regular Chrome profile, so they are already signed into X / LinkedIn.

```
1. tabs_create_mcp {}
2. navigate { url: "https://x.com/<handle>" }
3. find { query: "Message button" } → ref of the DM icon
4. computer { action: "left_click", ref }
5. find { query: "DM compose textarea" } or read_page → ref
6. form_input { ref, value: "<message body>" } or computer { action: "type", text: ... }
7. find { query: "Send button" } → ref
8. computer { action: "left_click", ref }
```

X may auto-collapse the message panel after send — use `read_page` or `screenshot` to confirm. LinkedIn requires existing connection (no InMail).

## Connection failures

If `tabs_context_mcp` returns `Browser extension is not connected`:
- The user has not installed / signed-in to the Claude in Chrome extension, or has restarted Chrome and the connection dropped.
- Surface the message: "Claude in Chrome is not connected. Open https://claude.ai/chrome and sign in with the same Anthropic account, then retry."
- Do not retry in a tight loop — wait for user confirmation.
