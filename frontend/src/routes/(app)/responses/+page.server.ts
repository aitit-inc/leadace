import { listResponses } from '$lib/api/responses';
import { PAGE_SIZE, parsePageNumber } from '$lib/pagination';
import type { ResponseType, Sentiment } from '$lib/types/responses';
import type { PageServerLoad } from './$types';
import { ANSWERS, SENTIMENTS, TYPES, type AnswerFilter } from './constants';

function parseSentiment(raw: string | null): Sentiment | '' {
  return raw && (SENTIMENTS as string[]).includes(raw) ? (raw as Sentiment) : '';
}

function parseType(raw: string | null): ResponseType | '' {
  return raw && (TYPES as string[]).includes(raw) ? (raw as ResponseType) : '';
}

function parseAnswer(raw: string | null): AnswerFilter | '' {
  return ANSWERS.find((a) => a === raw) ?? '';
}

export const load: PageServerLoad = async ({ fetch, parent, url, locals, depends }) => {
  depends('app:responses');
  const { activeProjectId } = await parent();
  const sentiment = parseSentiment(url.searchParams.get('sentiment'));
  const responseType = parseType(url.searchParams.get('responseType'));
  const answer = parseAnswer(url.searchParams.get('answer'));
  const page = parsePageNumber(url.searchParams.get('page'));

  if (!activeProjectId) {
    return {
      activeProjectId: null,
      responses: [],
      total: 0,
      page,
      filters: { sentiment, responseType, answer },
    };
  }

  const res = await listResponses(
    activeProjectId,
    {
      page,
      limit: PAGE_SIZE,
      sentiment: sentiment === '' ? undefined : sentiment,
      responseType: responseType === '' ? undefined : responseType,
      answer: answer === '' ? undefined : answer,
    },
    fetch,
    locals.session?.access_token,
  );

  return {
    activeProjectId,
    responses: res.responses,
    total: res.total,
    page,
    filters: { sentiment, responseType, answer },
  };
};
