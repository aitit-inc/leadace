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
