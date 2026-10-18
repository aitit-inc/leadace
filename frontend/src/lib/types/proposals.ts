// Mirrors backend services/loop/proposals.ts ProposalRow (Date columns arrive as ISO strings).
import type { ReachDiff, ReachSettings } from './dashboard';

export type ProposalStatus = 'pending' | 'applied' | 'stopped' | 'outdated';

// A loosening or a frame applies on `applyOn` unless the person stops it;
// `from` is the setting it was written against. A means waits for the person
// to set it up.
export type ProposedChange =
  | ({ kind: 'loosen'; applyOn: string; reason: string } & Pick<ReachDiff, 'outboundChannels' | 'targetCountries'>)
  | {
      kind: 'frame';
      applyOn: string;
      reason: string;
      salesStrategyFrom: number;
      reachFrom: ReachSettings;
      reach: ReachSettings;
      salesStrategy: string;
      variants: { variantId: string; label: string; subjectPattern: string; bodyApproach: string }[];
      strategies: { slug: string; approach: string }[];
    }
  | { kind: 'add-means'; strategy: string; instruction: string };

export interface Proposal {
  id: number;
  change: ProposedChange;
  title: string;
  body: string;
  status: ProposalStatus;
  createdAt: string;
}
