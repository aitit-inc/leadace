// Mirrors backend services/public-scoreboard.ts LiveScoreboard.
export type LiveDay = { date: string; sent: number; replies: number };

export type LiveScoreboard = {
  projectName: string;
  activeSince: string | null;
  daysActive: number;
  sent: { today: number; total: number };
  replies: { total: number; positive: number };
  replyRate: number;
  recent: { days: number; sent: number; replyRate: number };
  bounceRate: number;
  signups: { today: number; total: number } | null;
  daily: LiveDay[];
  journal: { content: string; date: string } | null;
  computedAt: string;
};
