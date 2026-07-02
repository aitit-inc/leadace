export type TenantSettings = {
  id: string;
  name: string;
  legalName: string | null;
  physicalAddress: string | null;
  defaultSenderCountry: string | null;
  // Japanese footer variants, sent verbatim to JP recipients. Null = fall back
  // to the default field above.
  legalNameJa: string | null;
  physicalAddressJa: string | null;
};
