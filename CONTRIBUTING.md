# Contributing to LeadAce

Thanks for taking an interest in LeadAce. We're a small team and we'd
love to have you contribute. This guide will get you oriented.

[1. Getting started](#1-getting-started)
[2. Issues](#2-issues)
[3. Pull requests](#3-pull-requests)
[4. License](#4-license)

## 1. Getting started

For local setup, follow the **Local development** section in
[docs/self-host.md](docs/self-host.md). The same Supabase + API/MCP
Workers + SvelteKit stack you'd run as a self-host install is what we
develop against.

Before writing code, please read [CLAUDE.md](CLAUDE.md). It is the
authoritative spec for the architectural guardrails we apply
consistently — 3-layer backend, tenant isolation, types-express-the-spec,
comment policy, and so on. Most review feedback traces back to one of
those rules, so the cheapest way to get a PR landed is to align with
them up front.

If you're looking for somewhere to start, browse the
[good first issue](https://github.com/aitit-inc/leadace/labels/good%20first%20issue)
label.

> Security issues do not go through public issues or PRs. See
> [SECURITY.md](SECURITY.md) for the private reporting flow.

## 2. Issues

If you find a bug, please open an issue and we'll triage it.

- Search [existing issues](https://github.com/aitit-inc/leadace/issues)
  before opening a new one.
- Include a clear description of the problem along with steps to
  reproduce. Logs, request payloads, and screenshots help a lot.
- For backend issues, include the affected route, the request you sent,
  and the response you got back.
- Mention the LeadAce version (plugin and self-host backend, if you're
  self-hosting) so we can rule out fixed-but-unreleased issues.

For feature requests, please open an issue and discuss the design
*before* opening a PR. We'd rather talk about the shape of a change
when it's still cheap to redirect than push back on a finished PR.

## 3. Pull requests

We actively welcome your pull requests. A few things to keep in mind:

- If you're fixing an issue, link it (`Closes #123` / `Fixes #456`) so
  it auto-closes on merge.
- Keep PRs scoped to one conceptual change. Smaller PRs review faster.
- Match the existing layering in `backend/src/`: HTTP adapter
  (`routes/`) → service (`services/`) → pure logic (`domain/`). The
  reference implementation is `routes/responses.ts` +
  `services/responses.ts` + `domain/{prospect-status,rejection-feedback}.ts`.
  See [.claude/rules/backend-architecture.md](.claude/rules/backend-architecture.md)
  for the full standard.
- Don't restate the code in comments — comments are for *why*, not
  *what*. See CLAUDE.md "Comments" for the rule.
- Update [docs/self-host.md](docs/self-host.md) and the relevant
  `.env.example` files when you add an environment variable, secret, or
  external dependency.
- Don't include generated artifacts (`.svelte-kit/`, `dist/`,
  `node_modules/`) or anything matched by `.gitignore` in the diff.
- If the change affects anything a user sees (landing page, app screens,
  email bodies, the inquiry landing), run it locally and attach
  screenshots of the rendered result to the PR, so reviewers check the
  actual display and not just the diff.

### Pre-flight checks

Before opening your PR, please run:

```bash
cd backend && npm run typecheck
cd frontend && npm run check
```

Both must be clean. We rely on TypeScript strict + Zod schemas +
drizzle's typed builder for correctness, and on integration verification
(curl, end-to-end skill runs) for behaviour. Running these locally
saves a CI round-trip.

### Testing

LeadAce intentionally does not have a unit-test suite for endpoints
that types already cover. Tests we welcome are the ones that cover
behaviour types cannot express — integration flows, business-logic edge
cases, regressions for specific bugs. If you're unsure whether a test
belongs, ask in the issue thread before writing it.

## 4. License

LeadAce is distributed under a [modified Apache 2.0 license](LICENSE).
By submitting a contribution, you agree that:

- Your contribution is your own work, or you have the right to submit
  it under that licence.
- You grant SurpassOne Inc. the right to use the contribution under
  that licence, including in the hosted commercial service at
  app.leadace.ai.

If you intend to operate LeadAce as a multi-tenant service for third
parties, contact `leo.uno@surpassone.com` for a commercial licence —
that use case is not covered by the open-source terms.
