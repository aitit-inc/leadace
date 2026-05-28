import {
  type ProspectStatus,
  type responseTypeEnum,
  type sentimentEnum,
} from '../db/schema'

type ResponseType = (typeof responseTypeEnum.enumValues)[number]
type Sentiment = (typeof sentimentEnum.enumValues)[number]

// Maps a recorded response to the next prospect status. Returns null when the
// response shouldn't change status (auto-replies). When `reapproachMonths` is
// set, what would otherwise be a hard rejection becomes 'deferred' (contacted,
// waiting for the recontact window to elapse).
export function nextStatusFromResponse(args: {
  responseType: ResponseType
  sentiment: Sentiment
  reapproachMonths: number | null
}): ProspectStatus | null {
  switch (args.responseType) {
    case 'bounce':
      return 'inactive'
    case 'auto_reply':
      return null
    case 'rejection':
      return args.reapproachMonths !== null ? 'deferred' : 'rejected'
    case 'meeting_request':
      return 'responded'
    case 'reply':
      if (args.sentiment === 'negative') {
        return args.reapproachMonths !== null ? 'deferred' : 'rejected'
      }
      return 'responded'
  }
}

export function addMonthsUtc(base: Date, months: number): Date {
  const originalDay = base.getUTCDate()
  const result = new Date(base)
  // Pin to day 1 before the month increment so an oversized originalDay
  // (Jan 31 + 1mo) cannot cascade into the following month (Mar 3). Then
  // clamp to the target month's last day.
  result.setUTCDate(1)
  result.setUTCMonth(result.getUTCMonth() + months)
  const lastDayOfTargetMonth = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0,
  )).getUTCDate()
  result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth))
  return result
}

export function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000)
}
