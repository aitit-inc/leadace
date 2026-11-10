export const PROSPECT_GROUPS = ['ace', 'yours', 'need_outside', 'out'] as const
export type ProspectGroup = (typeof PROSPECT_GROUPS)[number]
