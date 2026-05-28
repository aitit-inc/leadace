import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

export type Db = ReturnType<typeof createDb>

export function createDb(databaseUrl: string): ReturnType<typeof drizzle<typeof schema>> {
  // prepare: false is required for transaction poolers (Supabase Supavisor)
  const client = postgres(databaseUrl, { prepare: false })
  return drizzle(client, { schema })
}
