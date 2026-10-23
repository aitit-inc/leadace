import { DrizzleQueryError } from 'drizzle-orm'

// 23505 = unique_violation. Catching it only helps when the statement ran in its
// own transaction: postgres.js rethrows a failed query when the enclosing
// transaction ends, even if the caller caught it.
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof DrizzleQueryError && e.cause !== undefined && 'code' in e.cause && e.cause.code === '23505'
}

// drizzle's failed-query message lists every param, and catches log it. Wrap
// each query that passes the encryption key or a plaintext secret.
export async function secretQuery<T>(query: PromiseLike<T>): Promise<T> {
  try {
    return await query
  } catch (e) {
    throw e instanceof DrizzleQueryError ? new DrizzleQueryError(e.query, [], e.cause) : e
  }
}
