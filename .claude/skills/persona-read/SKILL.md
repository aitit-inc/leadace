---
name: persona-read
description: "Have AI personas of the people LeadAce is for read a page, an email or a report cold and say back what they understood, or walk through onboarding one move at a time, to find where it fails to say who it is for, what they get and what to do next. Triggers: 'ペルソナで読む', 'ペルソナで確かめる', 'LP が伝わるか', 'persona read'. Never evidence of demand or of willingness to pay."
---

# Persona read

The goal is to find where a text fails its reader on a first read: they cannot say who it is for, what they would get, or what to do next. The readers are AI personas: they agree easily, answer like the average and have no real budget. So a run gives places to look, never a measurement: never use it to say people will pay, that demand exists or what a rate will be, or as a pass mark (#1097).

## Setup

The personas are in the private repository `aitit-inc/lead-ace-eval` (`personas/`), cloned beside the main checkout. No access: say the read was not run, and stop. A persona is what a person did and paid for. One for a recipient of our emails is built only from replies our own projects received, never from a customer's tenant.

## Run

1. Write the intent first, from the current strategy (#1030) and not from the text: who it is for, what it promises, what the reader does next. Two or three sentences.

2. Capture what the reader meets, as they meet it, into a new directory outside the repository. For a page, the first screen and then the whole page, on a desktop and, for a persona who reads on a phone, on a phone (a changed landing page: serve `landing/public` and use that address):

   ```bash
   cd frontend
   shot() { # shot <url> <dir> <device> <width> <height>
     npx playwright-core screenshot --viewport-size "$4,$5" "$1" "$2/$3-first.png"
     npx playwright-core screenshot --viewport-size "$4,$5" --full-page "$1" "$2/$3-full.png"
     # A reader cannot read a tall image: cut it into pieces.
     h=$(ffprobe -v error -show_entries stream=height -of csv=p=0 "$2/$3-full.png")
     for ((y = 0, i = 1; y < h; y += 1000, i++)); do
       ffmpeg -loglevel error -i "$2/$3-full.png" -vf "crop=$4:$((h - y < 1000 ? h - y : 1000)):0:$y" "$2/$3-$i.png"
     done
   }
   shot <url> <dir> desktop 1440 900
   shot <url> <dir> phone 390 844
   ```

   For an email, the sender, subject and opening line as an inbox lists them, then the body.

3. Write two prompt files per persona, the outsider included, for one device: `<name>.1.txt` with the first screen, `<name>.2.txt` with the pieces in order.

   ```
   You are the person described below. Answer as them, in the first person, from
   what they have done and paid for. You are not reviewing the writing: give no
   advice on how to improve it. Open only the files named here.

   <the persona>

   Open <first screen>, as if you had just followed a link, and write:
   - What is this, in your own words?
   - Who is it for? Is that you?
   - What would you get from it?
   - What do you do next: leave, scroll or click? Why?
   - Any word or claim you did not understand or did not believe.
   ```

   ```
   Now read the rest: <the pieces>. Write:
   - What changed from your first answer.
   - The sentence closest to a problem you have, and the one furthest from you.
   - What you looked for and did not find.
   - What you would need to know before going further.
   ```

4. Run them all at once from that directory. A reader started inside the repository has read CLAUDE.md and knows what LeadAce is; this one knows only its prompt and can open only files under that directory. The second file goes to the same reader as a second turn, so the first answer is written before it can see the rest:

   ```bash
   cd <dir>
   reader() { claude -p --model sonnet --tools Read --strict-mcp-config --disable-slash-commands --setting-sources project --output-format json "$@"; }
   for p in prompts/*.1.txt; do
     n=$(basename "$p" .1.txt)
     (id=$(reader < "$p" | tee "answers/$n.1.json" | jq -r .session_id)
      reader --resume "$id" < "prompts/$n.2.txt" > "answers/$n.2.json") &
   done
   wait
   jq -r .result answers/*.json
   ```

## A conversation

Onboarding cannot be captured ahead: what Ace says depends on what the person answers. So the persona makes each move, against Ace on the local stack (`make dev`). [walk.mjs](walk.mjs) is a steps file for `npm run ui -- record` (e2e/README.md → Recording a flow). Wherever Ace waits on the person, and every ten minutes while it works, a clean reader is shown the screen and says what Ace is asking of them, what they expect next and what they did not understand, then names one move: send, type, click, wait or close the tab.

```bash
cp .claude/skills/persona-read/walk.mjs <dir>/<name>.mjs   # the recording takes the file's name
cd frontend
RUN_DIR=<dir> PERSONA=<name> SITE=<their website> LEGAL_NAME=<…> ADDRESS=<…> COUNTRY=<US|CA|JP> \
  npm run ui -- record first-chat <dir>/<name>.mjs
```

`<dir>`, outside the repository, holds `<name>.persona.txt`, `lp.png` (the landing page's first screen) and `answers/`. A run takes 30 to 60 minutes and about $2 of model and search calls; three, each started on its own, can run side by side.

- The persona needs a concrete offer and a website. An invented one has no site, and a made-up address takes only the path where Ace cannot read it. A real site is ours, or one its owner agreed to.
- The run stands in for sign-in (the account is Sam Rivera on the unlimited plan, and the reader is told so) and for the sender identity form (the three variables), for Google's consent when the reader connects Gmail (the mailbox is written as connected), and stops where the reader sends.
- A reader who closes the tab for want of a fact a real person has found nothing: give it the fact and run again.
- What a reader expects next ("an email will tell me") is a claim: check it in the code.
- Drafts name real companies. Keep the captures and the recording internal, and name no company on the issue.

## Read the answers

- The outsider first, their reasons against the words in the capture. If they take the text as theirs, either it is that broad or the readers agree with whatever they are shown: settle which before reading the rest. An outsider who turns it down shows only that a reader can.
- A finding is a gap between the intent and what a reader said back, quoted, with its cause in the capture. One reader is enough. A gap that several readers show, or that returns in a second run, is firmer; only persona 0 comes from a real person. Praise, and "I would sign up", are not findings.
- A reader sees only what the capture shows. Before calling "did not find" a finding, check that the answer is not behind a click (a closed FAQ).
- Report the intent, the findings with their quotes, and what you would change, on the issue the read was for. Say which personas were invented.
- To check a rewrite, run both versions at once with fresh readers, and compare what they say back.
