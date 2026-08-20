// stdio entrypoint for the LeadAce MCP server.
//
// The production server is the Cloudflare Worker in ./index.ts, reached over
// Streamable HTTP with OAuth. This file exposes the *same* tool registry over
// stdio so the server can run inside a plain Node process — used by MCP
// directories (Glama etc.) that start the server in a container to verify it
// boots and answers introspection (initialize / tools/list), and usable by
// anyone who prefers a local stdio process with a pre-minted token.
//
// Tool calls are forwarded to the LeadAce API exactly as the Worker does.
// Without LEADACE_ACCESS_TOKEN they fail with 401; introspection still works.
//
//   LEADACE_API_URL       API base (default https://api.leadace.ai)
//   LEADACE_ACCESS_TOKEN  Bearer token for tool calls (optional)
//
// Run: npx tsx src/mcp/stdio.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildToolRegistry, SERVER_VERSION, type ToolCtx } from './index'

// Trailing slash stripped: callApi builds `${apiUrl}/api${path}`.
const apiUrl = (process.env.LEADACE_API_URL ?? 'https://api.leadace.ai').replace(/\/+$/, '')
const token = process.env.LEADACE_ACCESS_TOKEN
const ctx: ToolCtx = { apiUrl, authHeader: token ? `Bearer ${token}` : '' }

const server = new McpServer({ name: 'lead-ace', version: SERVER_VERSION })
for (const tool of buildToolRegistry()) {
  server.tool(tool.name, tool.description, tool.schema, (args) => tool.handler(args, ctx))
}

server.connect(new StdioServerTransport()).catch((e) => {
  console.error('[mcp.stdio] failed to start:', e)
  process.exit(1)
})
