import { defineConfig } from 'vitest/config'

// Backend tests cover pure business logic only (domain/ + extracted pure
// cores). No Workers runtime, no DB — see .claude/rules/backend-architecture.md
// § Testing. Plain node environment is sufficient; DB I/O is covered by the
// e2e/regression-*.sh curl harness, not here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
