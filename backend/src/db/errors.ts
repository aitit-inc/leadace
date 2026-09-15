import { DrizzleQueryError } from 'drizzle-orm'

// 23505 = unique_violation. Catching it only helps when the statement ran in its
// own transaction: postgres.js rethrows a failed query when the enclosing
// transaction ends, even if the caller caught it.
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof DrizzleQueryError && e.cause !== undefined && 'code' in e.cause && e.cause.code === '23505'
}
