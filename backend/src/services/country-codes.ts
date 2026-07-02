import { buildCountryCodeReference, type CountryCodeReference } from '../domain/country'

// Not a ServiceResult: a static lookup has no failure to map to HTTP.
export function listCountryCodes(): CountryCodeReference {
  return buildCountryCodeReference()
}
