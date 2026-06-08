// Buckets mirror backend/seed-content/tpl_industries.md section headers; an
// entry added there needs one here or it silently falls into `other`.

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
