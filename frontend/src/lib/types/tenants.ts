export type TenantSettings = {
  id: string;
  name: string;
  legalName: string | null;
  physicalAddress: string | null;
  contactEmail: string | null;
  defaultSenderCountry: string | null;
  privacyPolicyUrl: string | null;
};
