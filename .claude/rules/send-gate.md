---
paths:
  - "backend/src/services/pipeline/enrich.ts"
  - "backend/src/services/pipeline/draft.ts"
  - "backend/src/services/pipeline/context.ts"
  - "backend/src/services/llm/routes.ts"
  - "backend/src/services/llm/pages.ts"
  - "backend/src/services/llm/openai.ts"
  - "backend/src/services/fetch-page.ts"
  - "backend/src/domain/site-read.ts"
  - "backend/src/domain/jobs.ts"
  - "backend/seed-content/tpl_enrich_contacts.md"
  - "backend/seed-content/tpl_email_guidelines.md"
---

# Send gate

These files decide who gets an email, at which address, and what it says. Before merging a change that can shift those decisions, including a model change for one of these stages, run the `eval-gate` skill and put its result in the PR under 確認・検証したこと.

A change that cannot shift them needs one line in the PR saying why. If the dataset is not available, say the gate was not run.
