// Steps file for `npm run ui -- record first-chat`: a persona reader makes each
// move (SKILL.md → A conversation).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = process.env.RUN_DIR;
const NAME = process.env.PERSONA;
const SITE = process.env.SITE;
const MAX = Number(process.env.MAX_TURNS ?? 14);
// A person looks at the screen again long before a job ends.
const WAIT_MS = Number(process.env.WAIT_MINUTES ?? 10) * 60_000;

export async function start() {
  return `/chat?site=${encodeURIComponent(SITE)}`;
}

function reader(prompt, session) {
  const args = ['-p', '--model', 'sonnet', '--tools', 'Read', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project', '--output-format', 'json'];
  if (session) args.push('--resume', session);
  return JSON.parse(execFileSync('claude', args, { cwd: DIR, input: prompt, encoding: 'utf8', maxBuffer: 1e8 }));
}

const FIRST = `You are the person described below. Act as them, in the first person, from what they have done and paid for. You are not reviewing the product: give no advice on how to improve it. Open only the files named here.

${readFileSync(`${DIR}/${NAME}.persona.txt`, 'utf8').trim()}

Your company's website is ${SITE}.

Two things on the screens come from the test setup and not from you: the account name Sam Rivera stands for your own name, and the plan label Unlimited stands for the free plan. And you know the facts about yourself that are not written above (your company's legal name and address): where a form asks for them, clicking its button fills them in for you.

You read the landing page of a product called LeadAce (lp.png), typed your website there and signed in with Google. The screen you are on now is ${NAME}-1.png; its text is in ${NAME}-1.txt.

Each time I show you the screen, write:
- What is it telling you or asking of you, in your own words?
- What do you expect to happen after your move?
- Anything you did not understand, or would not know how to answer.
Then end with one line, the one thing you do:
DO send (send what is already typed in the box)
DO type: <the words you type into the chat and send>
DO click: <the label of the button you click>
DO close: <why you close the tab, and what you expect to happen later>
DO wait (keep the tab open and look again later)`;

const next = (turn, note) =>
  `${note} The screen now: ${NAME}-${turn}.png. Its text, from the first line that changed since your move: ${NAME}-${turn}.txt. Same three answers, then your one DO line.`;

const usable = async (target) => (await target.isVisible().catch(() => false)) && (await target.isEnabled().catch(() => false));

export default async function (r) {
  let session;
  let prev = [];
  let note = '';
  let movedAt = Date.now();
  for (let turn = 1; turn <= MAX; turn++) {
    const state = turn === 1 ? 'start' : await r.settle(WAIT_MS);
    const minutes = Math.round((Date.now() - movedAt) / 60000);
    await r.page.screenshot({ path: `${DIR}/${NAME}-${turn}.png` });
    // The chat page's first section is the conversation; elsewhere the page is the text.
    const lines = (await r.page.evaluate(() => document.querySelector(location.pathname === '/chat' ? 'main section' : 'main').innerText)).split('\n');
    let same = 0;
    while (same < prev.length && same < lines.length && prev[same] === lines[same]) same++;
    writeFileSync(`${DIR}/${NAME}-${turn}.txt`, lines.slice(same).join('\n'));
    prev = lines;

    await r.setFast(true);
    const out = reader(turn === 1 ? FIRST : next(turn, `${note}${minutes >= 2 ? `${minutes} minutes have passed since your move${state === 'timeout' ? ', and Ace is still working' : ''}. ` : ''}`.trim()), session);
    await r.setFast(false);
    session = out.session_id;
    writeFileSync(`${DIR}/answers/${NAME}-${turn}.md`, `<!-- state: ${state}, waited: ${minutes} min -->\n${out.result}\n`);
    // The last DO line, without the markdown around it; a typed message may run on below it.
    const answer = out.result.split('\n').map((l) => l.replace(/^[\s*`>-]+|[\s*`]+$/g, ''));
    const at = answer.findLastIndex((l) => /^DO (send|type|click|close|wait)\b/.test(l));
    const [, verb, arg = ''] = (answer[at] ?? '').match(/^DO (send|type|click|close|wait)\b:?\s*(.*)$/) ?? [];
    r.log(`turn ${turn} (${state}): ${answer[at] ?? 'no DO line'}`);
    note = '';
    movedAt = Date.now();
    if (!verb) {
      note = 'Your answer had no DO line. ';
    } else if (verb === 'close') {
      return;
    } else if (verb === 'wait') {
      // Nothing is running, so settle would come straight back.
      if (state !== 'timeout') {
        await r.setFast(true);
        await new Promise((done) => setTimeout(done, WAIT_MS));
      }
    } else if (verb === 'send') {
      const button = r.page.locator('button[aria-label="Start"], button[aria-label="Send"]').first();
      if (await usable(button)) await r.click(button);
      else note = 'There is nothing in the box to send. ';
    } else if (verb === 'type') {
      const box = r.page.getByLabel('Message Ace');
      if (await usable(box)) {
        // The first screen has the website typed in already.
        await box.fill('');
        await r.type([arg, ...answer.slice(at + 1)].join(' ').trim().replace(/^["“]|["”]$/g, ''));
      } else note = 'There is no chat box to type into on this screen. ';
    } else {
      const label = arg.replace(/[*`]/g, '').replace(/\s*\(.*\)$/, '').replace(/^["“]|["”.]+$/g, '').trim();
      if (/^send \d+ emails?$/i.test(label)) {
        writeFileSync(`${DIR}/answers/${NAME}-end.md`, `Stopped at "${label}": the local stack sends no email.\n`);
        return;
      }
      if (/gmail|google/i.test(label)) {
        // Google's consent screen cannot be walked on the local stack: the mailbox is written as connected.
        r.psql(
          `INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, scope, secret, sign_in_account, granted_at, updated_at)
           VALUES (${r.q(r.persona.tenantId)}, 'walk', ${r.q(r.persona.userId)}, 'gmail_oauth', 'walk@example.com',
                   'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
                   decode('00', 'hex'), true, NOW(), NOW()) ON CONFLICT DO NOTHING;`,
        );
        await r.page.reload();
        note = '(Google asked you to let LeadAce send email as you and read your mail. You allowed it, and came back to this page. Your Gmail address shows as walk@example.com.) ';
        continue;
      }
      const target = r.page.getByRole('button', { name: label, exact: true }).or(r.page.getByRole('link', { name: label, exact: true })).last();
      if (!(await target.isVisible().catch(() => false))) {
        note = `There is nothing to click labelled "${label}". `;
      } else if (state === 'form' && (await target.evaluate((el) => Boolean(el.closest('form')?.querySelector('h3'))))) {
        // The sender identity form's own button: it stays disabled until the form is filled.
        await r.fillIdentity({ legalName: process.env.LEGAL_NAME, physicalAddress: process.env.ADDRESS, defaultSenderCountry: process.env.COUNTRY });
        note = "(The form was filled with your company's legal name and address, and saved.) ";
      } else if (await target.isEnabled()) {
        await r.press(target);
      } else note = `"${label}" cannot be clicked now. `;
    }
  }
}
