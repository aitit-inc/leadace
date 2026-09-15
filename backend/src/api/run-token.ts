// A token for a tool call no person's request carries (a schedule's run, a
// thread runner's turn). It acts as the user it names, is signed with the
// secret the API already accepts (auth/verify-jwt HS256 path), never leaves
// this Worker, and carries no audience — it is not an MCP token.
import { SignJWT } from 'jose'

// Long enough for one tool call, short enough to be worthless if it ever
// escaped the isolate.
const RUN_TOKEN_TTL_SECONDS = 900

export async function mintRunToken(userId: string, jwtSecret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + RUN_TOKEN_TTL_SECONDS)
    .sign(new TextEncoder().encode(jwtSecret))
}
