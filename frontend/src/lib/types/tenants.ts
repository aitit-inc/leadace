export type TenantSettings = {
  id: string;
  name: string;
  legalName: string | null;
  physicalAddress: string | null;
  defaultSenderCountry: string | null;
  // Japanese footer variants, used when the sending project's targetLanguage
  // is 'ja'. Null = fall back to the default field above.
  legalNameJa: string | null;
  physicalAddressJa: string | null;
};
