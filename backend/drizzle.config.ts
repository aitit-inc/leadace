import { defineConfig } from 'drizzle-kit'
import { existsSync, readFileSync } from 'node:fs'

// Auto-load DATABASE_URL from .dev.vars when not set in env.
// wrangler reads .dev.vars natively, but drizzle-kit doesn't — so `npm run db:migrate`
// would otherwise need an explicit `DATABASE_URL=... npm run db:migrate`.
if (!process.env['DATABASE_URL'] && existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf-8').split('\n')) {
    const m = line.match(/^DATABASE_URL\s*=\s*"?([^"\n]+?)"?\s*$/)
    if (m) {
      process.env['DATABASE_URL'] = m[1]
      break
    }
  }
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
})
