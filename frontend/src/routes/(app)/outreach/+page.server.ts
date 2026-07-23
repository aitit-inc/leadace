import { listOutreach } from '$lib/api/outreach';
import { PAGE_SIZE, parsePageNumber } from '$lib/pagination';
import type { FunnelStageFilter } from '$lib/types/outreach';
import type { PageServerLoad } from './$types';

const STAGES: readonly FunnelStageFilter[] = ['approached', 'reached', 'engaged', 'won'];

function parseStage(raw: string | null): FunnelStageFilter | '' {
  return raw && (STAGES as string[]).includes(raw) ? (raw as FunnelStageFilter) : '';
}

function parsePeriod(raw: string | null): '7d' | '30d' | '' {
  return raw === '7d' || raw === '30d' ? raw : '';
}

export const load: PageServerLoad = async ({ fetch, parent, url, locals }) => {
  const { activeProjectId } = await parent();
  const page = parsePageNumber(url.searchParams.get('page'));
  const stage = parseStage(url.searchParams.get('stage'));
  const period = parsePeriod(url.searchParams.get('period'));

  if (!activeProjectId) {
    return { activeProjectId: null, logs: [], total: 0, page, filters: { stage, period } };
  }

  const res = await listOutreach(
    activeProjectId,
    {
      page,
      limit: PAGE_SIZE,
      stage: stage === '' ? undefined : stage,
      period: period === '' ? undefined : period,
    },
    fetch,
    locals.session?.access_token,
  );

  return { activeProjectId, logs: res.logs, total: res.total, page, filters: { stage, period } };
};
