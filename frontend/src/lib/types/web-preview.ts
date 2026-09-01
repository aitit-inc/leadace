// Mirrors backend domain/web-preview.ts WebPreviewResult + services WebPreview.
export type WebPreviewSegment = {
  name: string;
  who: string;
  why: string;
};

export type WebPreviewEmail = {
  segment: string;
  to: string;
  subject: string;
  body: string;
};

export type WebPreviewResult = {
  company: { name: string; oneLiner: string };
  locale: 'en' | 'ja';
  segments: WebPreviewSegment[];
  emails: WebPreviewEmail[];
  footer: string;
  footerIsProvisional: boolean;
};

export type WebPreview = {
  url: string;
  result: WebPreviewResult;
  createdAt: string;
};
