export type MailboxHealth =
  | { kind: 'no_mailbox' }
  | {
      kind: 'active';
      email: string;
      warmupEnabled: boolean;
      warmupStartedAt: string | null;
      dailyCapOverride: number | null;
      pausedUntil: string | null;
      rampWeek: number;
      rampWeeks: number;
      steadyStatePerDay: number;
      cap: number;
      used: number;
      remaining: number;
    };

export type MailboxHealthActive = Extract<MailboxHealth, { kind: 'active' }>;

export type MailboxWarmupPatch = {
  warmupEnabled?: boolean;
  dailyCapOverride?: number | null;
  pausedUntil?: string | null;
};
