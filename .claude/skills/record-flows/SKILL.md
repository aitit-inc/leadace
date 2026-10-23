---
name: record-flows
description: "Screen-record a flow in the LeadAce web app on the local stack as a captioned mp4: a throwaway signed-in account, the real UI, model and jobs, job waits fast-forwarded. What to record comes from the person each time. Triggers: '画面収録', 'デモ動画', 'record the flow', 'screen recording'."
---

# Record a flow

The person says what to show. Pick the `npm run ui` scenario closest to where
the flow starts (`cd frontend && npm run ui -- list`), write a steps file for
this one recording in the scratchpad, and run
`npm run ui -- record <scenario> <absolute path of the steps file>`. The steps
contract: [e2e/README.md → Recording a flow](../../../e2e/README.md). Needs the
local stack (`make dev`).

## Rules

- Captions say what the person does, never what Ace will answer: the model can
  take another route. A wrong caption means recording again. Write them in the
  language the person asked in.
- Where a local run cannot do something, stand in for it (below) and say so in
  a caption.
- Before handing a video over, pull a few frames
  (`ffmpeg -ss <t> -i <mp4> -frames:v 1 x.png`) and look at them. Then send it
  with SendUserFile.
- A video that shows a real company (discovery registers real ones, with
  their published addresses) stays internal.

## Stand-ins

- **Google sign-in**: every scenario starts signed in. `first-chat` also has
  the website typed on the landing page.
- **Sending**: no local mailbox, so an approved send fails with "Gmail not
  connected". To show what follows a send, `start` marks the drafts `sent`,
  inserts a succeeded `send` job on the thread and its unread `job` message
  (`appendJobNotice` in `backend/src/services/chat/threads.ts`), then wakes the
  runner with `POST /api/chat/threads/<id>/confirm` `{ callId: 'none',
  approve: false }`, before the page opens.
- **The next morning**: set the account's schedules to this UTC hour with
  `last_run_key = NULL`, then `GET <apiUrl>/__scheduled?cron=0+*+*+*+*`. That
  runs the whole hourly cron, so every local account's due schedules and inbox
  work run too.

## Gotchas

- Onboarding asks once for more material before it proposes.
- Seeded drafts must fit their prospect and the business, or Ace holds them
  back instead of raising the send card.
- An onboarding run through discovery takes about 20 minutes before speed-up
  and pays for model and search calls.
- Two recordings at once can hit a Miniflare `SQLITE_BUSY` page while the
  frontend starts: record that one again alone.
