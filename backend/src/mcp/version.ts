// SERVER_VERSION is informational — the deployed backend's own version.
// Lives outside index.ts because workerd registers every top-level export of
// the Worker entry module as an entrypoint and rejects non-handler values
// ("Incorrect type for map entry"), which kills `wrangler dev` startup.
export const SERVER_VERSION = '1.0.0'
