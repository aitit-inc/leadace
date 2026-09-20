#!/usr/bin/env node
// Put the local stack into the state a screen needs, then open that screen —
// signed in as a throwaway persona — in a browser or as light/dark screenshots.
// See e2e/README.md → UI scenarios.
//
//   npm run ui -- list
//   npm run ui -- open approval
//   npm run ui -- shot                 # every scenario, light + dark
//   npm run ui -- shot plans-credits --theme dark --keep
//
// Exit status: 0 all good, 1 setup/stack failure, 2 a page did not render the
// state it was seeded with.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerClient } from '@supabase/ssr';
import { chromium } from 'playwright-core';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function dotenv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    // `PORT=5273   # comment` is valid in dev.ports.env; a bare `#` inside a
    // value (secrets) is not a comment, so only a spaced one is stripped.
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const devVars = dotenv(join(REPO_ROOT, 'backend', '.dev.vars'));
const frontendEnv = dotenv(join(REPO_ROOT, 'frontend', '.env'));
const ports = dotenv(join(REPO_ROOT, 'dev.ports.env'));

const SUPABASE_URL = devVars.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = devVars.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = frontendEnv.PUBLIC_SUPABASE_ANON_KEY || '';
// The cookie name is derived from this URL by supabase-js, so the browser and
// the planted session must agree on the spelling (localhost ≠ 127.0.0.1).
const PUBLIC_SUPABASE_URL = frontendEnv.PUBLIC_SUPABASE_URL || 'http://localhost:54321';

// The same names work as exported shell vars, but dev.sh sources the file last,
// so the file wins there and has to win here too.
const port = (name, fallback) => ports[name] || process.env[name] || fallback;
const APP_URL = `http://localhost:${port('LEADACE_FRONTEND_PORT', 5273)}`;
const API_URL = `http://localhost:${port('LEADACE_API_PORT', 8787)}`;
// Billing UI only exists in the cloud edition, which needs both a worker and a
// frontend booted with the flag — a second pair beside the everyday stack.
const CLOUD_API_URL = 'http://localhost:8789';
const CLOUD_APP_URL = 'http://localhost:5274';
const SHOT_DIR = join(REPO_ROOT, 'e2e', 'output', 'ui');

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomId(length) {
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
}

const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

// -q drops the command tag psql prints after a write ("INSERT 0 1"), which
// otherwise trails the value a RETURNING clause hands back.
function psql(sql) {
  return execFileSync(
    'psql',
    ['-h', '127.0.0.1', '-p', '54322', '-U', 'postgres', '-d', 'postgres', '-qtAc', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' }, encoding: 'utf8' },
  ).trim();
}

async function supabaseAdmin(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ─── persona ────────────────────────────────────────────────────────────────

const SENDER = { name: 'Sam Rivera', company: 'Northwind Labs' };

// Every live persona, so an interrupt can still take its account with it.
const livePersonas = new Set();
let keepPersonas = false;

// Sign-in is Google-only and email logins are disabled, so a password grant is
// out. An admin-minted magic link verifies into a real session over the same
// GoTrue code path a person's sign-in takes.
async function createPersona(label) {
  const email = `ui-${label}-${Date.now()}@e2e.local`;
  const user = await supabaseAdmin('POST', '/auth/v1/admin/users', {
    email,
    email_confirm: true,
    user_metadata: { full_name: SENDER.name, name: SENDER.name },
  });
  // Registered before the steps that can still fail: from here on the account
  // exists, so teardown has to know about it.
  const persona = { email, userId: user.id };
  livePersonas.add(persona);

  persona.tenantId = psql(`SELECT tenant_id FROM tenant_members WHERE user_id = ${q(user.id)} LIMIT 1;`);
  if (!persona.tenantId) throw new Error(`no tenant was provisioned for ${email}`);

  const link = await supabaseAdmin('POST', '/auth/v1/admin/generate_link', { type: 'magiclink', email });
  const hashedToken = link.hashed_token ?? link.properties?.hashed_token;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const session = await res.json();
  if (!res.ok || !session.access_token) throw new Error(`could not mint a session: ${JSON.stringify(session)}`);
  persona.session = session;
  return persona;
}

// Deleting the user takes its tenant with it in the same transaction
// (drizzle/0098), so this cannot half-succeed.
async function destroyPersona(persona) {
  await supabaseAdmin('DELETE', `/auth/v1/admin/users/${persona.userId}`);
  livePersonas.delete(persona);
}

async function destroyLivePersonas() {
  for (const persona of [...livePersonas]) {
    await destroyPersona(persona).catch((e) =>
      console.error(`  could not delete ${persona.email}: ${e.message} — remove it by hand`),
    );
  }
}

// Let @supabase/ssr write the session into a jar so the cookie name, chunking
// and encoding come from the same code the app reads them with.
async function sessionCookies(session) {
  const jar = new Map();
  const client = createServerClient(PUBLIC_SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return [...jar].map(([name, value]) => ({
    name,
    value,
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  }));
}

// ─── seeding helpers ────────────────────────────────────────────────────────

function apiFor(ctx) {
  return async (method, path, body) => {
    const res = await fetch(`${ctx.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.persona.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

const COMPLIANCE = {
  legalName: 'Northwind Labs, Inc.',
  physicalAddress: '2100 Harbor Way, Suite 300, Portland, OR 97209',
  defaultSenderCountry: 'US',
};

const PROSPECT_SEEDS = [
  { name: 'Dana Brooks', org: 'Harbor Dental Group', domain: 'harbor-dental' },
  { name: 'Miles Okafor', org: 'Cedar Ridge Physio', domain: 'cedar-ridge-physio' },
  { name: 'Priya Raman', org: 'Lantern Bookkeeping', domain: 'lantern-bookkeeping' },
  { name: 'Tom Alvarez', org: 'Sunfield Roofing', domain: 'sunfield-roofing' },
  { name: 'Ines Duarte', org: 'Blue Kettle Coffee', domain: 'blue-kettle' },
  { name: 'Ray Whitfield', org: 'Anchor Legal Partners', domain: 'anchor-legal' },
  { name: 'Nour Haddad', org: 'Pine & Post Interiors', domain: 'pine-and-post' },
  { name: 'Ellis Nakamura', org: 'Granite Fitness Studio', domain: 'granite-fitness' },
];

function prospectPayload(seed, tag) {
  const domain = `${seed.domain}-${tag}.example`;
  return {
    organizationDomain: domain,
    organizationName: seed.org,
    organizationWebsiteUrl: `https://${domain}`,
    country: 'US',
    countrySource: 'manual',
    name: seed.name,
    overview: `${seed.org} — owner-run, 5-20 staff, books work through their own site.`,
    websiteUrl: `https://${domain}/about`,
    email: `${seed.name.split(' ')[0].toLowerCase()}@${domain}`,
    matchReason: 'Runs its own bookings and answers enquiries by email.',
  };
}

// The inquiry path runs a pre-send content check that rejects anything reading
// like an unfilled placeholder, so these carry real wording rather than a
// tacked-on nonce. Varying them per prospect is for the screenshots' sake.
const OPENERS = [
  (s) => `I saw ${s.org} takes new enquiries straight from the website.`,
  (s) => `Your booking page at ${s.org} does a lot of work before anyone picks up the phone.`,
  (s) => `${s.org} answers enquiries the same day, which is rarer than it sounds.`,
  (s) => `A friend pointed me at ${s.org} after I asked who handles their own enquiries well.`,
  (s) => `I was reading how ${s.org} handles a first enquiry end to end.`,
  (s) => `${s.org} seems to run its own front desk rather than farm it out.`,
  (s) => `The enquiry form on the ${s.org} site is doing the job of a receptionist.`,
  (s) => `I spent a while on the ${s.org} site looking at how a first enquiry lands.`,
];
const CLOSERS = [
  'We wrote up what cuts the back-and-forth before a first call. Want it?',
  'Happy to send the two-page version of what we changed. Say the word.',
  'I can send the checklist we use for that if it is useful.',
  'There is a short write-up on it — worth me sending over?',
  'I can forward the note we sent the last practice that asked.',
  'Want the summary? It is a five-minute read.',
  'Glad to pass along what worked for a similar team.',
  'If it helps, I can send the before-and-after we measured.',
];

function outreachBody(seed, index) {
  const i = index % OPENERS.length;
  return `Hi ${seed.name.split(' ')[0]},

${OPENERS[i](seed)}

${CLOSERS[i]}

${SENDER.name}
${SENDER.company}`;
}

async function seedProject(ctx, { name, settings }) {
  const api = apiFor(ctx);
  await api('PUT', '/api/tenant-settings', COMPLIANCE);
  const project = await api('POST', '/api/projects', { name });
  await api('PUT', `/api/projects/${project.id}/documents/business`, { content: `# ${SENDER.company}\n\nScheduling software for small clinics.` });
  await api('PUT', `/api/projects/${project.id}/settings`, {
    senderDisplayName: SENDER.name,
    senderCompanyName: SENDER.company,
    senderJobTitle: 'Founder',
    ...settings,
  });
  return project.id;
}

async function seedProspects(ctx, projectId, count) {
  const api = apiFor(ctx);
  const seeds = PROSPECT_SEEDS.slice(0, count);
  await api('POST', '/api/prospects/batch', {
    projectId,
    prospects: seeds.map((s) => prospectPayload(s, ctx.tag)),
  });
  const listed = await api('GET', `/api/projects/${projectId}/prospects?limit=200`);
  return seeds.map((seed) => {
    const domain = `${seed.domain}-${ctx.tag}.example`;
    const row = listed.prospects.find((p) => p.email?.endsWith(`@${domain}`));
    if (!row) throw new Error(`seeded prospect ${seed.name} did not come back from the API`);
    return { ...seed, prospectId: row.prospectId, email: row.email };
  });
}

async function recordSent(ctx, projectId, prospects) {
  const api = apiFor(ctx);
  for (const [index, p] of prospects.entries()) {
    await api('POST', '/api/outreach', {
      projectId,
      prospectId: p.prospectId,
      channel: 'email',
      subject: `A quicker first reply for ${p.org}`,
      body: outreachBody(p, index),
      status: 'sent',
    });
  }
}

function seedThread(ctx, { projectId, title, userText, modelText, toolName, args, summary }) {
  const threadId = randomId(21);
  const callId = `call_${randomId(10)}`;
  psql(
    `INSERT INTO chat_threads (id, tenant_id, project_id, title, created_at, updated_at)
     VALUES (${q(threadId)}, ${q(ctx.persona.tenantId)}, ${q(projectId)}, ${q(title)}, NOW(), NOW());`,
  );
  const insertMessage = (content) =>
    psql(
      `INSERT INTO chat_messages (tenant_id, thread_id, role, content, read_after)
       VALUES (${q(ctx.persona.tenantId)}, ${q(threadId)}, ${q(content.role)}, ${q(JSON.stringify(content))}::jsonb, 0)
       RETURNING id;`,
    );
  insertMessage({ role: 'user', parts: [{ text: userText }] });
  const messageId = Number(
    insertMessage({
      role: 'model',
      parts: [{ text: modelText }, { functionCall: { id: callId, name: toolName, args } }],
    }),
  );
  const pendingCall = { messageId, callId, name: toolName, args, summary, otherResponses: [], remaining: [] };
  psql(
    `UPDATE chat_threads SET pending_call = ${q(JSON.stringify(pendingCall))}::jsonb WHERE id = ${q(threadId)};`,
  );
  return threadId;
}

// A dashboard with a month of history behind it. The figures are the real ones
// from one of our own projects; the institutions are invented. Everything here
// is written straight to the tables the dashboard reads, because reaching this
// state through the API would mean a month of cycles.
//
// What the numbers have to satisfy (backend/src/services/dashboard.ts):
//  - KPIs count DISTINCT prospects over a rolling 30 days, and the delta
//    compares against the 30 days before that, so both windows carry sends.
//  - The trend buckets by UTC calendar day from midnight of today-29; anchoring
//    each day at UTC noon keeps every send inside that window and the KPI one.
//    Only the eight named sends are placed against the wall clock, because the
//    feed prints them as "27m ago" — so the chart looks the same at any hour.
//  - Variant stats only count sends older than rewardWindowDays (14) and call an
//    arm mature at minSamplePerArm (30).
//  - hot_leads uses a fixed 7-day window, whatever period the page is showing.
const DASH_PROOF = 'rst_20260715_b';
const DASH_SINGLE = 'rst_20260715_d';
const DASH_SUBJECT = 'Three minutes a day: AI practice that makes you clearer';
// Days 0..27 of the 30-day window; the last two days are the named sends below.
const DASH_BY_DAY = [8, 9, 9, 8, 0, 0, 0, 7, 8, 7, 6, 8, 9, 14, 3, 0, 0, 0, 5, 7, 7, 0, 0, 0, 9, 6, 0, 0];
const DASH_PREV_TOTAL = 133;
const DASH_NAMED = [
  { name: "Westbrook Girls' High School", domain: 'westbrook-girls.example', minsAgo: 27 },
  { name: 'Rivermead County Board of Education', domain: 'rivermead-boe.example', minsAgo: 29 },
  { name: 'Springfield Online Academy', domain: 'springfield-online.example', minsAgo: 30 },
  { name: 'Medway Medical Prep', domain: 'medway-medical.example', minsAgo: 31 },
  { name: 'Aimes Medical Entrance Academy', domain: 'aimes-entrance.example', minsAgo: 32 },
  { name: 'Summit Medical Prep', domain: 'summit-medical.example', minsAgo: 1440 },
  { name: 'Northgate University', domain: 'northgate-university.example', minsAgo: 1442 },
  { name: "Fairhaven Women's University", domain: 'fairhaven-womens.example', minsAgo: 1444 },
];
const DASH_LEARNINGS = [
  `[body] [D-0] Proof-led (${DASH_PROOF}) is driving reply rate and meetings by a wide margin — evidence: metric=variantResponseRate ${DASH_PROOF} 8.8% n=114 vs the other 3 angles 3.1-3.3% n=30-32 (meanReward 0.118 vs 0-0.067)`,
  `[targeting] [D-1] Prospects carrying a why-now signal at send time reply about 4x more often — evidence: metric=freshSignalResponseRate withSignal 13.1% n=61 / withoutSignal 3.3% n=211`,
  `[targeting] [D-2] Higher-education institutions with a standalone career-support department are the best meeting-generating segment — evidence: metric=discoveryStrategyResponseRate school-directory-nationwide 10.5% n=76 / 8 meeting enquiries`,
  `[channel] [D-3] No human reply has ever come through a contact form (all of them auto-replies); only email has produced meetings — evidence: metric=channelResponseRate email 6.2% n=241 / form 0.0% n=31`,
  `[body] [D-4] Only copy that quotes the recipient's own course or programme name draws a positive reply — evidence: metric=respondedMessages all 6 positive replies carried a proper-noun hook, n=198 sends`,
  `[body] [D-5] A low-cost CTA that spells out an exit ("wrong person", "another time") is producing meeting enquiries — evidence: metric=sentimentBreakdown meeting_request=6 / positive reply=8, n=179 emails`,
  `[timing] [D-12] Tuesday and Wednesday morning sends draw the most replies — evidence: metric=dayOfWeekResponseRate Tue 8.1% / Wed 7.6% / Fri 2.2%, n=241`,
  `[discovery] [D-14] Nationwide school directories yield more reachable addresses than association member lists — evidence: metric=contactYield directory 62% n=180 / association 28% n=94`,
  `[channel] [D-17] Follow-ups on the same thread outperform a fresh thread — evidence: metric=threadedResponseRate threaded 7.4% n=136 / fresh 2.1% n=95`,
  `[targeting] [D-19] Institutions above 200 staff answer far less often — evidence: metric=employeeBandResponseRate 11-50 9.2% n=120 / 201+ 1.9% n=53`,
];

function seedDashboardFixture(ctx, projectId) {
  const tenant = ctx.persona.tenantId;
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  const today = new Date(now);
  const trendFloor = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 29 * DAY;

  const sends = [];
  for (let day = 0; day < 30; day++) {
    for (let i = 0; i < DASH_BY_DAY[day]; i++) {
      sends.push({ window: 'cur', day, sentAt: trendFloor + day * DAY + 12 * 60 * MIN + i * 7 * MIN });
    }
  }
  for (let i = 0; i < DASH_PREV_TOTAL; i++) {
    const day = 30 + (i % 30);
    sends.push({ window: 'prev', day, sentAt: now - day * DAY - 5 * 60 * MIN - i * 3 * MIN });
  }

  // The named eight are the newest rows in Recent activity and the only sends
  // measured from the wall clock, since the feed prints them as "27m ago" and
  // "1d ago". Subtracting a whole day always lands on the previous UTC day; the
  // minutes-ago five are clamped so a run just after midnight cannot push them
  // into yesterday's trend bucket.
  const startOfTodayUtc = trendFloor + 29 * DAY;
  DASH_NAMED.forEach((n) => {
    const sameDay = n.minsAgo < DAY / MIN;
    const at = now - n.minsAgo * MIN;
    sends.push({
      window: 'cur',
      day: sameDay ? 29 : 28,
      isNamed: true,
      named: n,
      sentAt: sameDay ? Math.max(startOfTodayUtc + MIN, at) : at,
    });
  });
  sends.forEach((s, i) => {
    if (!s.named) s.named = { name: `Prospect ${i + 1}`, domain: `org-${i + 1}.example` };
  });

  const curMature = sends
    .filter((s) => s.window === 'cur' && s.day <= 15)
    .sort((a, b) => a.sentAt - b.sentAt);
  const prevSends = sends.filter((s) => s.window === 'prev');
  prevSends.forEach((s) => (s.variant = DASH_PROOF));
  curMature.slice(0, 19).forEach((s) => (s.variant = DASH_PROOF));
  curMature.slice(19, 53).forEach((s) => (s.variant = DASH_SINGLE));

  const responses = [];
  const add = (send, type, sentiment, receivedAt, content, feedback = null) =>
    responses.push({ send, type, sentiment, receivedAt, content, feedback });
  const prevSorted = [...prevSends].sort((a, b) => a.sentAt - b.sentAt);
  add(prevSorted[0], 'meeting_request', 'positive', prevSorted[0].sentAt + 2 * DAY, 'Happy to find a time next week.');
  add(prevSorted[1], 'meeting_request', 'positive', prevSorted[1].sentAt + 2 * DAY, 'Could we set up a short call?');
  for (let i = 0; i < 4; i++) {
    add(prevSorted[2 + i], 'reply', 'neutral', prevSorted[2 + i].sentAt + 2 * DAY, 'Thanks for reaching out.');
  }
  add(prevSorted[10], 'bounce', 'neutral', prevSorted[10].sentAt + 60 * MIN, 'Address not found.');
  for (let i = 0; i < 6; i++) {
    add(curMature[i], 'reply', 'neutral', curMature[i].sentAt + 2 * DAY, 'Thanks — sending this to our team.');
  }
  add(curMature[19], 'reply', 'neutral', curMature[19].sentAt + 2 * DAY, 'Interesting, tell me more.');
  // Slots run oldest-first and take one response each: the KPIs count distinct
  // prospects, and a reply has to land after its own send.
  const slots = sends
    .filter((s) => s.window === 'cur' && s.day > 15 && !s.isNamed)
    .sort((a, b) => a.sentAt - b.sentAt);
  const unsubscribe = { primary_reason: 'unsubscribe_request', free_text: '', preferred_recontact_window: 'never' };
  // Every reply is dated from its own send, so none can predate it and the
  // hot-leads window lands the same way at any hour: slots 19 and 28 are days 24
  // and 25, which put two meeting requests inside the fixed seven days, and slot
  // 0 is day 18, which keeps the third one outside.
  add(slots[0], 'meeting_request', 'positive', slots[0].sentAt + DAY, 'We would like a walkthrough.');
  add(slots[19], 'meeting_request', 'positive', slots[19].sentAt + DAY, 'Can you do Thursday afternoon?');
  add(slots[28], 'meeting_request', 'positive', slots[28].sentAt + DAY, 'Please send over a calendar link.');
  add(slots[5], 'rejection', 'negative', slots[5].sentAt + DAY, 'Please remove me from this list.', unsubscribe);
  add(slots[6], 'rejection', 'negative', slots[6].sentAt + DAY, 'Unsubscribe.', unsubscribe);
  add(slots[7], 'reply', 'neutral', slots[7].sentAt + DAY, 'Noted, thank you.');
  add(slots[1], 'bounce', 'neutral', slots[1].sentAt + 60 * MIN, 'Mailbox unavailable.');
  add(slots[2], 'bounce', 'neutral', slots[2].sentAt + 60 * MIN, 'Mailbox unavailable.');
  add(slots[3], 'bounce', 'neutral', slots[3].sentAt + 60 * MIN, 'Mailbox unavailable.');

  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  const body = 'Hi there,\n\nA short note about speaking practice.\n\nSam Rivera\nNorthwind Labs';

  for (const part of chunk(sends, 60)) {
    psql(
      `INSERT INTO organizations (tenant_id, domain, name, website_url, country, country_source, employee_band) VALUES ` +
        part
          .map((s) => `(${q(tenant)}, ${q(s.named.domain)}, ${q(s.named.name)}, ${q(`https://${s.named.domain}`)}, 'US', 'manual', '11-50')`)
          .join(',') +
        ` ON CONFLICT DO NOTHING;`,
    );
  }
  for (const part of chunk(sends, 60)) {
    psql(
      `INSERT INTO prospects (tenant_id, name, organization_id, overview, website_url, email, country, country_source, origin) ` +
        `SELECT ${q(tenant)}, v.name, o.id, v.name || ' — career services contact.', 'https://' || v.domain, 'contact@' || v.domain, 'US', 'manual', 'found' ` +
        `FROM (VALUES ` +
        part.map((s) => `(${q(s.named.name)}, ${q(s.named.domain)})`).join(',') +
        `) AS v(name, domain) JOIN organizations o ON o.domain = v.domain AND o.tenant_id = ${q(tenant)};`,
    );
  }
  psql(
    `INSERT INTO project_prospects (tenant_id, project_id, prospect_id, match_reason, status)
     SELECT ${q(tenant)}, ${q(projectId)}, p.id, 'Runs its own career-support desk.', 'contacted'
     FROM prospects p WHERE p.tenant_id = ${q(tenant)};`,
  );
  for (const part of chunk(sends, 40)) {
    psql(
      `INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, subject, body, status, sent_at, variant_id) ` +
        `SELECT ${q(tenant)}, ${q(projectId)}, p.id, 'email', v.subject, v.body, 'sent', v.sent_at::timestamptz, v.variant ` +
        `FROM (VALUES ` +
        part
          .map(
            (s) =>
              `(${q(s.named.domain)}, ${q(DASH_SUBJECT)}, ${q(body)}, ${q(iso(s.sentAt))}, ${s.variant ? q(s.variant) : 'NULL'})`,
          )
          .join(',') +
        `) AS v(domain, subject, body, sent_at, variant) ` +
        `JOIN organizations o ON o.domain = v.domain AND o.tenant_id = ${q(tenant)} ` +
        `JOIN prospects p ON p.organization_id = o.id AND p.tenant_id = ${q(tenant)};`,
    );
  }
  for (const part of chunk(responses, 30)) {
    psql(
      `INSERT INTO responses (tenant_id, outreach_log_id, channel, content, sentiment, response_type, received_at, rejection_feedback) ` +
        `SELECT ${q(tenant)}, ol.id, 'email', v.content, v.sentiment::sentiment, v.rtype::response_type, v.received_at::timestamptz, v.feedback::jsonb ` +
        `FROM (VALUES ` +
        part
          .map(
            (r) =>
              `(${q(r.send.named.domain)}, ${q(r.content)}, ${q(r.sentiment)}, ${q(r.type)}, ${q(iso(r.receivedAt))}, ${r.feedback ? q(JSON.stringify(r.feedback)) : 'NULL'})`,
          )
          .join(',') +
        `) AS v(domain, content, sentiment, rtype, received_at, feedback) ` +
        `JOIN organizations o ON o.domain = v.domain AND o.tenant_id = ${q(tenant)} ` +
        `JOIN prospects p ON p.organization_id = o.id AND p.tenant_id = ${q(tenant)} ` +
        `JOIN outreach_logs ol ON ol.prospect_id = p.id AND ol.project_id = ${q(projectId)};`,
    );
  }

  // Every variant predates the 30-day journal window, so the only entries are
  // the two the retirement cycle archived — a newer created_at would add
  // "started testing a new angle" lines the screenshot does not have.
  const born = iso(now - 70 * DAY);
  const retiredAt = iso(now - 7 * DAY);
  psql(
    `INSERT INTO message_variants (tenant_id, project_id, variant_id, subject_pattern, label, body_approach, created_at, updated_at, archived_at) VALUES
     (${q(tenant)}, ${q(projectId)}, ${q(DASH_PROOF)}, ${q(DASH_SUBJECT)}, 'Proof-led', 'Lead with a measured result.', ${q(born)}, ${q(born)}, NULL),
     (${q(tenant)}, ${q(projectId)}, ${q(DASH_SINGLE)}, ${q('One question about your speaking programme')}, 'Single-question', 'Ask one question, nothing else.', ${q(born)}, ${q(born)}, NULL),
     (${q(tenant)}, ${q(projectId)}, 'rst_20260715_a', ${q('The gap in most speaking programmes')}, 'Problem-direct', 'Name the problem first.', ${q(born)}, ${q(retiredAt)}, ${q(retiredAt)}),
     (${q(tenant)}, ${q(projectId)}, 'rst_20260715_c', ${q('Something we learned about speaking practice')}, 'Casual peer', 'Peer-to-peer tone.', ${q(born)}, ${q(retiredAt)}, ${q(retiredAt)});`,
  );
  psql(
    `INSERT INTO lever_state (project_id, tenant_id, variant_weights, updated_at)
     VALUES (${q(projectId)}, ${q(tenant)}, ${q(JSON.stringify({ [DASH_PROOF]: 0.72, [DASH_SINGLE]: 0.28 }))}::jsonb, NOW());`,
  );
  // getLeverDecisionsHistory reads decision.subject.{weights,archived,samples}
  // unguarded, so every row carries the whole block. `vitals` stays out: a
  // 'futile' verdict would raise the futility attention item.
  const sample = (variantId, total, replies, rewardSum) => ({ variantId, total, responses: replies, rewardSum });
  const cycleRetire = {
    subject: {
      weights: { [DASH_PROOF]: 0.55, [DASH_SINGLE]: 0.2, rst_20260715_a: 0.13, rst_20260715_c: 0.12 },
      archived: [
        { variantId: 'rst_20260715_a', pBest: 0.02, n: 30 },
        { variantId: 'rst_20260715_c', pBest: 0.01, n: 32 },
      ],
      // rewardSum is a sum over the arm's replies, not a rate.
      samples: [
        sample(DASH_PROOF, 114, 10, 6.5),
        sample(DASH_SINGLE, 30, 1, 0.5),
        sample('rst_20260715_a', 30, 1, 0.5),
        sample('rst_20260715_c', 32, 1, 0.5),
      ],
    },
  };
  const cycleToday = {
    subject: {
      weights: { [DASH_PROOF]: 0.72, [DASH_SINGLE]: 0.28 },
      archived: [],
      samples: [sample(DASH_PROOF, 152, 12, 7), sample(DASH_SINGLE, 34, 1, 0.5)],
    },
  };
  psql(
    `INSERT INTO lever_decisions (tenant_id, project_id, cycle_date, decision) VALUES
     (${q(tenant)}, ${q(projectId)}, ${q(ymd(now - 7 * DAY))}, ${q(JSON.stringify(cycleRetire))}::jsonb),
     (${q(tenant)}, ${q(projectId)}, ${q(ymd(now))}, ${q(JSON.stringify(cycleToday))}::jsonb);`,
  );
  const learnings = DASH_LEARNINGS.map((line) =>
    line.replace(/\[D-(\d+)\]/, (_, d) => `[${ymd(now - Number(d) * DAY)}]`),
  );
  psql(
    `INSERT INTO project_documents (tenant_id, project_id, slug, content, created_at, approved_at)
     VALUES (${q(tenant)}, ${q(projectId)}, 'learnings', ${q(`# Learnings\n\n${learnings.join('\n')}\n`)}, NOW(), NOW());`,
  );
  // Without a connected mailbox the page leads with "Gmail disconnected".
  // chk_sending_identities_secret_owner is why a non-alias identity has to
  // carry secret bytes.
  psql(
    `INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, scope, secret, sign_in_account, granted_at, updated_at)
     VALUES (${q(tenant)}, 'ui-dashboard-identity', ${q(ctx.persona.userId)}, 'gmail_oauth', 'sam@northwind-labs.example',
             'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
             decode('00', 'hex'), true, NOW(), NOW());`,
  );
  // On the free plan this many contacted prospects trip the quota item and
  // flip the header to "Paused".
  psql(
    `INSERT INTO tenant_plans (tenant_id, plan) VALUES (${q(tenant)}, 'unlimited')
     ON CONFLICT (tenant_id) DO UPDATE SET plan = 'unlimited';`,
  );
  psql(
    // `command` is the column the `instruction` field still lives in.
    `INSERT INTO suggestions (tenant_id, project_id, kind, dedupe_key, title, body, command) VALUES
     (${q(tenant)}, ${q(projectId)}, 'add-means', 'wantedly-story-posts',
      ${q('Wantedly stories reach the schools email is bouncing at')},
      ${q(
        'Four of the eight bounces this month are schools whose only published contact is a Wantedly page. ' +
          'Wantedly needs a company account and its terms accepted, so Ace cannot sign up on your behalf.',
      )},
      ${q('Add Wantedly as an outreach means.')});`,
  );
}

// ─── scenarios ──────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'signin',
    summary: 'Sign-in page: from the landing CTA, returning, and after account deletion',
    stack: 'self-host',
    persona: false,
    setup: async () => [
      { name: 'signup', path: '/login?signup=1', expect: 'Continue with Google' },
      { name: 'returning', path: '/login', expect: 'Continue with Google' },
      { name: 'deleted', path: '/login?deleted=1', expect: 'Your account has been deleted.' },
    ],
  },
  {
    name: 'first-chat',
    summary: 'The first chat of a brand-new workspace — no project yet',
    stack: 'self-host',
    setup: async () => [
      { name: 'empty', path: '/chat', expectSelector: 'textarea[placeholder="https://your-company.com"]' },
    ],
  },
  {
    name: 'new-project',
    summary: 'The chat of a project created from the switcher, before its first setup',
    stack: 'self-host',
    setup: async (ctx) => {
      // No sender identity either: the website prompt must not wait on it.
      await apiFor(ctx)('POST', '/api/projects', { name: 'Second product' });
      return [{ name: 'empty', path: '/chat', expectSelector: 'textarea[placeholder="https://your-company.com"]' }];
    },
  },
  {
    name: 'approval',
    summary: 'A tool call waiting for approval: an ordinary one and a destructive one',
    stack: 'self-host',
    setup: async (ctx) => {
      const projectId = await seedProject(ctx, { name: 'Northwind outbound', settings: { outboundMode: 'draft' } });
      const [dana] = await seedProspects(ctx, projectId, 1);
      const DRAFT_SUBJECT = 'Fewer back-and-forths before a first call';
      const ordinary = seedThread(ctx, {
        projectId,
        title: 'Draft for Harbor Dental',
        userText: 'Write to Harbor Dental about the enquiry note.',
        modelText: "Here's the draft — it goes out only if you say so.",
        // The args carry what the tool actually takes, so approving the card
        // runs the same call the agent would have made.
        toolName: 'send_email_and_record',
        args: { projectId, prospectId: dana.prospectId, subject: DRAFT_SUBJECT, body: outreachBody(dana, 0) },
        summary: {
          title: 'Draft this email',
          facts: [
            { label: 'Project', value: 'Northwind outbound' },
            { label: 'To', value: `${dana.name} at ${dana.org} (${dana.email})` },
            { label: 'What happens', value: 'It is held as a draft for your review — nothing is sent' },
            { label: 'Subject', value: DRAFT_SUBJECT },
          ],
          body: outreachBody(dana, 0),
          confirmLabel: 'Save draft',
        },
      });
      const destructive = seedThread(ctx, {
        projectId,
        title: 'Clear out the old project',
        userText: 'Delete the Northwind outbound project.',
        modelText: 'That removes its outreach history as well. Confirm below.',
        toolName: 'delete_project',
        args: { projectId },
        summary: {
          title: 'Delete this project',
          facts: [
            { label: 'Project', value: 'Northwind outbound' },
            { label: 'What goes', value: 'Its outreach history, replies, documents, settings and message angles' },
            { label: 'What stays', value: 'Prospects and organizations — those belong to the workspace' },
          ],
          warning: 'This cannot be undone.',
          confirmLabel: 'Delete project',
        },
      });
      return [
        { name: 'ordinary', path: `/chat?t=${ordinary}`, expect: 'Draft this email' },
        { name: 'destructive', path: `/chat?t=${destructive}`, expect: 'This cannot be undone.' },
      ];
    },
  },
  {
    name: 'delete-account',
    summary: 'The account deletion page of a workspace that has data to lose',
    stack: 'self-host',
    setup: async (ctx) => {
      const projectId = await seedProject(ctx, { name: 'Northwind outbound', settings: {} });
      await seedProspects(ctx, projectId, 3);
      return [{ name: 'page', path: '/account-settings/delete', expect: 'Delete my account permanently' }];
    },
  },
  {
    name: 'inquiry',
    summary: 'The recipient-facing /q page behind a real inquiry link',
    stack: 'self-host',
    signedIn: false,
    setup: async (ctx) => {
      const oneLiner = 'We help owner-run clinics answer new enquiries without the back-and-forth.';
      const projectId = await seedProject(ctx, {
        name: 'Northwind outbound',
        settings: { outboundMode: 'draft', inquiryLandingEnabled: true, inquiryOneLiner: oneLiner },
      });
      const [dana] = await seedProspects(ctx, projectId, 1);
      // An inquiry link is an opt-out link, so the send path refuses to build
      // one from a host that is not public https — which localhost never is.
      // The e2e recipient override is the documented way past that gate
      // (services/outreach.ts assertPublicHttpsSendHosts).
      if (!devVars.E2E_RECIPIENT_OVERRIDE) {
        throw new Error(
          'set E2E_RECIPIENT_OVERRIDE in backend/.dev.vars (any test mailbox) — an inquiry link cannot be issued from a localhost host without it',
        );
      }
      // The inquiry link rides on the channels LeadAce does not send itself —
      // email carries its own footer at send time.
      await apiFor(ctx)('POST', '/api/outreach/record-with-inquiry', {
        projectId,
        prospectId: dana.prospectId,
        channel: 'form',
        subject: 'Fewer back-and-forths before a first call',
        body: outreachBody(dana, 0),
      });
      const shortId = psql(
        `SELECT short_id FROM inquiry_tokens WHERE tenant_id = ${q(ctx.persona.tenantId)} ORDER BY created_at DESC LIMIT 1;`,
      );
      if (!shortId) throw new Error('no inquiry token was allocated');
      return [{ name: 'landing', path: `/q/${shortId}`, expect: oneLiner }];
    },
  },
  {
    name: 'plans-free',
    summary: 'Plans on the free tier: usage so far and the upgrade cards',
    stack: 'cloud',
    setup: async (ctx) => {
      const projectId = await seedProject(ctx, { name: 'Northwind outbound', settings: { outboundMode: 'send' } });
      const prospects = await seedProspects(ctx, projectId, 6);
      await recordSent(ctx, projectId, prospects.slice(0, 4));
      // The tier names are static, so the usage figure is what proves the
      // seeding landed.
      return [{ name: 'page', path: '/plans', expect: ['Starter', '4 / 30'] }];
    },
  },
  {
    name: 'plans-credits',
    summary: 'Plans on a paid tier with prepaid credits and auto top-up',
    stack: 'cloud',
    setup: async (ctx) => {
      // A tenant is created with a free plan row (drizzle/0097), so a paid
      // fixture is an update. It deliberately carries no subscription id: a
      // real paid tenant has one (the webhook writes customer and subscription
      // together), but reading it goes to Stripe. /me/subscription therefore
      // 404s here and the plan-change cards stay out of the screenshot — the
      // one way this page differs from a real Starter workspace.
      psql(
        `UPDATE tenant_plans SET
           plan = 'starter',
           current_period_start = NOW() - INTERVAL '9 days',
           current_period_end = NOW() + INTERVAL '21 days',
           auto_top_up_enabled = true,
           auto_top_up_amount_cents = 2500,
           auto_top_up_threshold_cents = 500,
           stripe_customer_id = ${q(`cus_ui_${ctx.tag}`)},
           updated_at = NOW()
         WHERE tenant_id = ${q(ctx.persona.tenantId)};`,
      );
      // A purchase and nothing else: credits are only ever debited once an
      // allowance is used up, so a balance with usage against it while most of
      // the month's prospects are still unspent is a state the app cannot reach.
      psql(
        `INSERT INTO credit_ledger (tenant_id, kind, amount_cents, reference)
         VALUES (${q(ctx.persona.tenantId)}, 'purchase', 2500, ${q(`cs_ui_${ctx.tag}`)});`,
      );
      const projectId = await seedProject(ctx, { name: 'Northwind outbound', settings: { outboundMode: 'send' } });
      const prospects = await seedProspects(ctx, projectId, 8);
      await recordSent(ctx, projectId, prospects);
      return [{ name: 'page', path: '/plans', expect: ['Prepaid credits', '$25.00', '8 / 100'] }];
    },
  },
  {
    name: 'notifications',
    summary: 'The bell with notifications (one unread), and the notification settings',
    stack: 'self-host',
    setup: async (ctx) => {
      await seedProject(ctx, { name: 'Northwind outbound', settings: {} });
      const t = q(ctx.persona.tenantId);
      psql(`UPDATE tenants SET notifications_seen_at = now() - interval '2 hours' WHERE id = ${t};
        INSERT INTO notifications (tenant_id, category, reference, subject, body, link, created_at) VALUES
        (${t}, 'cron', 'ui:1', 'daily cycle failed: Northwind outbound', 'Search step failed upstream — upstream LLM request failed', '/chat', now() - interval '1 hour'),
        (${t}, 'general', 'ui:2', 'discover succeeded: Northwind outbound', 'Registered 8 of 12 (6 with email); 4 skipped.', '/chat', now() - interval '5 hours'),
        (${t}, 'cron', 'ui:3', 'daily cycle succeeded: Northwind outbound', 'evaluate: 2 responses scored | draft: 20 sent | journal: saved', '/chat', now() - interval '1 day');`);
      return [
        { name: 'bell', path: '/dashboard', click: 'button[aria-haspopup="menu"][aria-label^="Alerts"]', expect: 'daily cycle failed: Northwind outbound' },
        { name: 'settings', path: '/workspace-settings', click: 'text=Scheduled runs', expect: 'Scheduled runs' },
      ];
    },
  },
  {
    name: 'dashboard',
    summary: 'The dashboard of a project with a month of outreach behind it',
    stack: 'self-host',
    setup: async (ctx) => {
      const projectId = await seedProject(ctx, { name: 'SpeechMonster', settings: { outboundMode: 'send' } });
      seedDashboardFixture(ctx, projectId);
      return [
        {
          name: 'page',
          path: '/dashboard',
          expect: [
            '2 meeting requests waiting',
            'Optimizing across 2 message angles',
            'Three minutes a day',
            'Add Wantedly as an outreach means.',
          ],
        },
        {
          name: 'suggestion-menu',
          path: '/dashboard',
          click: 'button[aria-label="Other ways to run this"]',
          expect: 'Copy Claude Code command',
        },
      ];
    },
  },
  {
    name: 'project-settings',
    summary: 'The settings of a project that already sends',
    stack: 'self-host',
    setup: async (ctx) => {
      await seedProject(ctx, { name: 'Northwind outbound', settings: { outboundMode: 'send' } });
      return [
        {
          name: 'follow-up',
          path: '/project-settings',
          // The page scrolls in its own pane; the click brings the help text into the shot.
          click: 'text=Turning this on also picks up',
          expect: 'Auto follow-up on unanswered emails',
        },
      ];
    },
  },
];

// ─── stack ──────────────────────────────────────────────────────────────────

const spawned = [];

// Generous timeout: vite compiles the route on the first request, which can
// take longer than a health check ever would.
async function reachable(url, timeoutMs = 20_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not come up at ${url}`);
}

// Detached so the whole process group dies with it — wrangler and vite both
// leave grandchildren behind otherwise.
function start(label, command, args, options) {
  console.log(`  starting ${label}…`);
  const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
  // Without a listener a spawn failure raises an unhandled 'error' event, which
  // would take the process down before whatever already started can be stopped.
  child.on('error', (e) => console.error(`  ${label} failed to start: ${e.message}`));
  child.unref();
  spawned.push(child);
}

function stopSpawned() {
  for (const child of spawned) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  spawned.length = 0;
}

async function ensureStack(kind) {
  if (!(await reachable(`${API_URL}/health`)) || !(await reachable(APP_URL))) {
    throw new Error(`the local stack is not running (${API_URL}, ${APP_URL}) — start it with \`make dev\``);
  }
  if (kind !== 'cloud') return { apiUrl: API_URL, appUrl: APP_URL };

  if (API_URL === CLOUD_API_URL || APP_URL === CLOUD_APP_URL) {
    throw new Error(
      `the everyday stack sits on the cloud-edition ports (${CLOUD_API_URL} / ${CLOUD_APP_URL}) — move it in dev.ports.env`,
    );
  }

  if (!(await reachable(`${CLOUD_API_URL}/health`))) {
    start('cloud-edition API worker', join(REPO_ROOT, 'e2e', 'cloud-edition-up.sh'), [], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLOUD_PORT: '8789' },
    });
    await waitFor(`${CLOUD_API_URL}/health`, 'cloud-edition API worker');
  }
  // The probe lib-cloud.sh uses: the webhook route 404s on a self-hosted worker
  // (the edition guard refuses first) and 400s on a cloud one (no signature).
  // Without it, whatever else holds the port would be used as if it were ours.
  const edition = await fetch(`${CLOUD_API_URL}/api/stripe/webhook`, { method: 'POST' }).then(
    (r) => r.status,
    () => 0,
  );
  if (edition !== 400) {
    throw new Error(
      `${CLOUD_API_URL} is not a cloud-edition worker (webhook probe answered ${edition}, expected 400) — stop what is on that port`,
    );
  }
  if (!(await reachable(CLOUD_APP_URL))) {
    start('cloud-edition frontend', join(REPO_ROOT, 'frontend', 'node_modules', '.bin', 'vite'), [
      'dev',
      '--port',
      '5274',
      '--strictPort',
    ], {
      cwd: join(REPO_ROOT, 'frontend'),
      env: {
        ...process.env,
        PUBLIC_API_URL: CLOUD_API_URL,
        PUBLIC_LEADACE_EDITION: 'cloud',
        // Placeholders: the cards render and price out; Checkout itself needs
        // real Stripe test keys and is out of scope here.
        PUBLIC_STRIPE_PRICE_STARTER_MONTHLY: 'price_ui_starter',
        PUBLIC_STRIPE_PRICE_PRO_MONTHLY: 'price_ui_pro',
        PUBLIC_STRIPE_PRICE_SCALE_MONTHLY: 'price_ui_scale',
      },
    });
    await waitFor(CLOUD_APP_URL, 'cloud-edition frontend');
  }
  return { apiUrl: CLOUD_API_URL, appUrl: CLOUD_APP_URL };
}

// ─── running ────────────────────────────────────────────────────────────────

async function launchBrowser(headless) {
  try {
    return await chromium.launch({ channel: 'chrome', headless });
  } catch (e) {
    throw new Error(`could not launch Chrome (${e.message}) — install Google Chrome and retry.`);
  }
}

async function prepare(scenario) {
  const stack = await ensureStack(scenario.stack);
  const tag = `${Date.now().toString(36)}`;
  const persona = scenario.persona === false ? null : await createPersona(scenario.name);
  const ctx = { ...stack, persona, tag };
  // A failure while seeding propagates to shutDown, which takes every live
  // persona with it — unless --keep asked for the half-built one to stay.
  const pages = await scenario.setup(ctx);
  return { ctx, pages };
}

async function newContext(browser, ctx, scenario, theme) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  });
  if (scenario.signedIn !== false && ctx.persona) {
    await context.addCookies(await sessionCookies(ctx.persona.session));
  }
  // The cookie notice is dismissed up front: it sits over the bottom of every
  // page and has nothing to do with the screen under review.
  await context.addInitScript(
    `try {
       localStorage.setItem('leadace.theme', ${JSON.stringify(theme)});
       localStorage.setItem('leadace.cookie_consent', 'accepted');
     } catch (e) {}`,
  );
  return context;
}

async function open(scenarioName) {
  const scenario = SCENARIOS.find((s) => s.name === scenarioName);
  if (!scenario) throw new Error(`unknown scenario "${scenarioName}" — try \`npm run ui -- list\``);

  const { ctx, pages } = await prepare(scenario);
  const browser = await launchBrowser(false);
  const context = await newContext(browser, ctx, scenario, 'light');
  for (const page of pages) {
    const tab = await context.newPage();
    await tab.goto(`${ctx.appUrl}${page.path}`);
  }
  console.log(`\n${scenario.name} — ${scenario.summary}`);
  if (ctx.persona) console.log(`  persona: ${ctx.persona.email} (tenant ${ctx.persona.tenantId})`);
  for (const page of pages) console.log(`  ${page.name}: ${ctx.appUrl}${page.path}`);
  console.log('\nClose the browser window when you are done.');

  await new Promise((resolve) => browser.on('disconnected', resolve));
  if (keepPersonas && ctx.persona) console.log(`\n--keep: ${ctx.persona.email} and its tenant are still there.`);
  return 0;
}

async function shoot(names, themes) {
  const wanted = names.length > 0 ? names : SCENARIOS.map((s) => s.name);
  const unknown = wanted.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);

  mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await launchBrowser(true);
  const failures = [];
  const written = [];

  for (const name of wanted) {
    const scenario = SCENARIOS.find((s) => s.name === name);
    console.log(`\n=== ${name} — ${scenario.summary} ===`);
    const { ctx, pages } = await prepare(scenario);
    try {
      for (const theme of themes) {
        const context = await newContext(browser, ctx, scenario, theme);
        for (const page of pages) {
          const tab = await context.newPage();
          const errors = [];
          tab.on('pageerror', (e) => errors.push(e.message));
          const url = `${ctx.appUrl}${page.path}`;
          const response = await tab.goto(url, { waitUntil: 'networkidle' });
          if (page.click) {
            await tab.click(page.click);
            await tab.waitForLoadState('networkidle');
          }
          const file = join(SHOT_DIR, `${name}--${page.name}--${theme}.png`);
          await tab.screenshot({ path: file, fullPage: true });
          written.push(file);

          const status = response?.status() ?? 0;
          const body = await tab.textContent('body');
          const missing = [page.expect ?? []].flat().filter((text) => !body.includes(text));
          const noSelector = page.expectSelector && (await tab.locator(page.expectSelector).count()) === 0;
          if (status >= 400 || missing.length > 0 || noSelector) {
            const why =
              status >= 400
                ? `HTTP ${status}`
                : `did not render ${missing.map((t) => `"${t}"`).join(' or ') || page.expectSelector}`;
            failures.push(`${name}/${page.name} (${theme}): ${why}`);
            console.log(`  FAIL ${page.name} (${theme}) — ${why}`);
          } else {
            console.log(`  ok   ${page.name} (${theme})`);
          }
          if (errors.length > 0) console.log(`       console errors: ${errors.join(' | ')}`);
          await tab.close();
        }
        await context.close();
      }
    } finally {
      if (ctx.persona && !keepPersonas) await destroyPersona(ctx.persona);
      else if (ctx.persona) console.log(`  --keep: ${ctx.persona.email} left in place`);
    }
  }
  await browser.close();

  console.log(`\n${written.length} screenshot(s) in ${SHOT_DIR}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f}`);
    return 2;
  }
  console.log('All scenarios rendered what they were seeded with.');
  return 0;
}

function list() {
  console.log('Scenarios:\n');
  for (const s of SCENARIOS) {
    console.log(`  ${s.name.padEnd(16)} ${s.summary}`);
    if (s.stack === 'cloud') console.log(`  ${''.padEnd(16)} (boots a cloud-edition worker + frontend)`);
  }
  console.log('\n  npm run ui -- open <scenario>      open it in Chrome, signed in');
  console.log('  npm run ui -- shot [<scenario>…]   light + dark screenshots into e2e/output/ui');
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  keepPersonas = args.includes('--keep');
  const themeArg = args.includes('--theme') ? args[args.indexOf('--theme') + 1] : null;
  if (themeArg && themeArg !== 'light' && themeArg !== 'dark') {
    throw new Error(`--theme takes light or dark, not "${themeArg}"`);
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--theme');
  const [mode, ...rest] = positional;

  if (!SERVICE_KEY || !ANON_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY (backend/.dev.vars) and PUBLIC_SUPABASE_ANON_KEY (frontend/.env) are required');
  }
  // `make dev` runs Postgres in Docker but installs no client, and the
  // scenarios seed state the app itself cannot reach.
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('psql is not on PATH — install a Postgres client (brew install libpq)');
  }

  switch (mode) {
    case 'open':
      if (!rest[0]) throw new Error('open needs a scenario name');
      return open(rest[0]);
    case 'shot':
      return shoot(rest, themeArg ? [themeArg] : ['light', 'dark']);
    case 'list':
    case undefined:
      return list();
    default:
      throw new Error(`unknown command "${mode}" — expected list, open or shot`);
  }
}

async function shutDown(code, message) {
  if (message) console.error(`\n${message}`);
  if (!keepPersonas) await destroyLivePersonas();
  stopSpawned();
  process.exit(code);
}

process.on('SIGINT', () => shutDown(130));

main()
  .then((code) => shutDown(code))
  .catch((e) => shutDown(1, e.message));
