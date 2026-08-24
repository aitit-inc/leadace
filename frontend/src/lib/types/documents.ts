export interface DocumentSummary {
  slug: string;
  updatedAt: string;
}

// Mirrors backend DocumentRow / history rows. approvedAt is null on versions
// the agent saved over MCP; playbooks need a human approval before skills use them.
export interface DocumentVersion {
  id: number;
  slug?: string;
  content: string;
  createdAt: string;
  approvedAt: string | null;
}
