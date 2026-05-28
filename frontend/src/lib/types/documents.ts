export interface DocumentSummary {
  slug: string;
  updatedAt: string;
}

export interface DocumentVersion {
  id: number;
  slug?: string;
  content: string;
  createdAt: string;
}
