import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

export type Db = ReturnType<typeof createDb>

function connect(databaseUrl: string) {
  // prepare: false is required for transaction poolers (Supabase Supavisor)
  return postgres(databaseUrl, { prepare: false })
}

export function createDb(databaseUrl: string): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(connect(databaseUrl), { schema })
}

export async function withDb<T>(databaseUrl: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = connect(databaseUrl)
  try {
    return await fn(drizzle(client, { schema }))
  } finally {
    await client.end()
  }
}
