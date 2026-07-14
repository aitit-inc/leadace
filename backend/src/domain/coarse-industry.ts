// Buckets mirror backend/seed-content/tpl_industries.md section headers; an
// entry added there needs one here or add_prospects / CSV import rejects it
// as unknown_industry (the FINE_TO_COARSE keys are the controlled vocabulary).

export const COARSE_INDUSTRIES = [
  'software_tech',
  'vertical_tech',
  'hardware_industrial',
  'commerce_consumer',
  'services',
  'public_nonprofit',
  'other',
] as const
export type CoarseIndustry = (typeof COARSE_INDUSTRIES)[number]

const FINE_TO_COARSE: Readonly<Record<string, CoarseIndustry>> = {
  'B2B SaaS': 'software_tech',
  'Consumer Software / Apps': 'software_tech',
  'Marketplace / Platform': 'software_tech',
  'DevTools / Developer Platform': 'software_tech',
  'Data / Analytics': 'software_tech',
  'AI / ML': 'software_tech',
  'Cybersecurity': 'software_tech',
  'Cloud Infrastructure / Hosting': 'software_tech',
  'FinTech': 'vertical_tech',
  'HealthTech / Biotech': 'vertical_tech',
  'EdTech': 'vertical_tech',
  'HR Tech / Recruiting Software': 'vertical_tech',
  'Marketing / AdTech': 'vertical_tech',
  'Sales / CRM Tech': 'vertical_tech',
  'LegalTech': 'vertical_tech',
  'PropTech / Real Estate Tech': 'vertical_tech',
  'AgTech': 'vertical_tech',
  'CleanTech / EnergyTech': 'vertical_tech',
  'LogisticsTech / Supply Chain Tech': 'vertical_tech',
  'MobilityTech': 'vertical_tech',
  'RetailTech / E-commerce Tech': 'vertical_tech',
  'ConstructionTech': 'vertical_tech',
  'GovTech': 'vertical_tech',
  'Hardware / IoT / Robotics': 'hardware_industrial',
  'Manufacturing': 'hardware_industrial',
  'Construction': 'hardware_industrial',
  'Energy / Utilities': 'hardware_industrial',
  'Logistics / Transportation': 'hardware_industrial',
  'Agriculture': 'hardware_industrial',
  'E-commerce / Retail': 'commerce_consumer',
  'Food / Beverage': 'commerce_consumer',
  'Fashion / Apparel': 'commerce_consumer',
  'Beauty / Wellness': 'commerce_consumer',
  'Media / Publishing': 'commerce_consumer',
  'Entertainment / Gaming': 'commerce_consumer',
  'Travel / Hospitality': 'commerce_consumer',
  'Sports / Fitness': 'commerce_consumer',
  'Financial Services': 'services',
  'Healthcare Provider': 'services',
  'Education Institution': 'services',
  'Professional Services / Consulting': 'services',
  'Legal Services': 'services',
  'Accounting / Tax': 'services',
  'Staffing / Recruiting Services': 'services',
  'Real Estate Services': 'services',
  'Marketing / Advertising Agency': 'services',
  'Construction / Contracting': 'services',
  'Government / Public Sector': 'public_nonprofit',
  'Nonprofit': 'public_nonprofit',
  'Industry Association / Federation': 'public_nonprofit',
}

export function coarseIndustry(industry: string | null | undefined): CoarseIndustry {
  if (!industry) return 'other'
  return FINE_TO_COARSE[industry.trim()] ?? 'other'
}

// Inverted for SQL CASE generation; 'other' has no fine members — it is the
// ELSE branch (null, 'Other', legacy free-form labels).
export const COARSE_TO_FINES: Readonly<Record<CoarseIndustry, readonly string[]>> = (() => {
  const inverted: Record<CoarseIndustry, string[]> = {
    software_tech: [],
    vertical_tech: [],
    hardware_industrial: [],
    commerce_consumer: [],
    services: [],
    public_nonprofit: [],
    other: [],
  }
  for (const [fine, coarse] of Object.entries(FINE_TO_COARSE)) inverted[coarse].push(fine)
  return inverted
})()

// 'Other' is tpl_industries' documented catch-all — valid input, folds to 'other'.
const KNOWN_INDUSTRIES: ReadonlySet<string> = new Set([...Object.keys(FINE_TO_COARSE), 'Other'])

export function isKnownIndustry(industry: string): boolean {
  return KNOWN_INDUSTRIES.has(industry.trim())
}
