import { listProspects } from '$lib/api/prospects';
import { PAGE_SIZE, parsePageNumber } from '$lib/pagination';
import { PROSPECT_GROUPS, type ProspectGroup, type ProspectStatus } from '$lib/types/prospects';
import type { PageServerLoad } from './$types';
import { STATUSES } from './constants';

function parseStatus(raw: string | null): ProspectStatus | '' {
  return raw && (STATUSES as string[]).includes(raw) ? (raw as ProspectStatus) : '';
}

function parseGroup(raw: string | null): ProspectGroup {
  return (PROSPECT_GROUPS as readonly string[]).includes(raw ?? '') ? (raw as ProspectGroup) : 'ace';
}

function parsePriority(raw: string | null): number | '' {
  if (!raw) return '';
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : '';
}

export const load: PageServerLoad = async ({ fetch, parent, url, locals }) => {
  const { activeProjectId } = await parent();
  const status = parseStatus(url.searchParams.get('status'));
  const priority = parsePriority(url.searchParams.get('priority'));
  const q = url.searchParams.get('q')?.trim() ?? '';
  const group = parseGroup(url.searchParams.get('group'));
  const page = parsePageNumber(url.searchParams.get('page'));

  if (!activeProjectId) {
    return {
      activeProjectId: null,
      prospects: [],
      total: 0,
      groups: { ace: 0, yours: 0, need_outside: 0, out: 0 },
      page,
      filters: { status, priority, q, group },
    };
  }

  const res = await listProspects(
    activeProjectId,
    {
      page,
      limit: PAGE_SIZE,
      status: status === '' ? undefined : status,
      priority: priority === '' ? undefined : priority,
      q: q || undefined,
      group,
    },
    fetch,
    locals.session?.access_token,
  );

  return {
    activeProjectId,
    prospects: res.prospects,
    total: res.total,
    groups: res.groups,
    page,
    filters: { status, priority, q, group },
  };
};
