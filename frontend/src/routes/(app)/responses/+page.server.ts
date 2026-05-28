import { listResponses } from '$lib/api/responses';
import { PAGE_SIZE, parsePageNumber } from '$lib/pagination';
import type { ResponseType, Sentiment } from '$lib/types/responses';
import type { PageServerLoad } from './$types';
import { SENTIMENTS, TYPES } from './constants';

function parseSentiment(raw: string | null): Sentiment | '' {
  return raw && (SENTIMENTS as string[]).includes(raw) ? (raw as Sentiment) : '';
}

function parseType(raw: string | null): ResponseType | '' {
  return raw && (TYPES as string[]).includes(raw) ? (raw as ResponseType) : '';
}

export const load: PageServerLoad = async ({ fetch, parent, url, locals }) => {
  const { activeProjectId } = await parent();
  const sentiment = parseSentiment(url.searchParams.get('sentiment'));
  const responseType = parseType(url.searchParams.get('responseType'));
  const page = parsePageNumber(url.searchParams.get('page'));

  if (!activeProjectId) {
    return {
      activeProjectId: null,
      responses: [],
      total: 0,
      page,
      filters: { sentiment, responseType },
    };
  }

  const res = await listResponses(
    activeProjectId,
    {
      page,
      limit: PAGE_SIZE,
      sentiment: sentiment === '' ? undefined : sentiment,
      responseType: responseType === '' ? undefined : responseType,
    },
    fetch,
    locals.session?.access_token,
  );

  return {
    activeProjectId,
    responses: res.responses,
    total: res.total,
    page,
    filters: { sentiment, responseType },
  };
};
