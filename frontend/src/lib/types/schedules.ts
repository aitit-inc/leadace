// Mirrors backend `ScheduleView` (services/schedules.ts).

// 0 = Sunday … 6 = Saturday, as Date#getDay reports it.
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const EVERY_DAY: DayOfWeek[] = [0, 1, 2, 3, 4, 5, 6];
// Mirrors MAX_SCHEDULES_PER_PROJECT in backend/src/domain/schedules.ts.
export const MAX_SCHEDULES_PER_PROJECT = 5;
export const WEEKDAYS: DayOfWeek[] = [1, 2, 3, 4, 5];
export const DAY_LABELS: Record<DayOfWeek, string> = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
};

export type Schedule = {
  id: string;
  projectId: string;
  prompt: string;
  timezone: string;
  hour: number;
  days: DayOfWeek[];
  enabled: boolean;
  threadId: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type NewSchedule = {
  projectId: string;
  prompt: string;
  timezone: string;
  hour: number;
  days: DayOfWeek[];
};

export type SchedulePatch = Partial<Omit<NewSchedule, 'projectId'>> & { enabled?: boolean };
