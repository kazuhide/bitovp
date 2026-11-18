/** Shared by the public ingress, Next body clone, routes and browser finalizer. */
export const MOQ_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
export const MOQ_UPLOAD_BODY_TIMEOUT_MS = 10_000;
export const MOQ_ARCHIVE_MAX_UPLOADS = 2;
export const MOQ_ARCHIVE_MAX_READS = 2;
export const MOQ_OBSERVATION_MAX_BODY_BYTES = 256 * 1024;
// Concurrent observation writes may admit up to 16 MiB of request bodies.
export const MOQ_OBSERVATION_MAX_UPLOADS = 64;
// Queue10s + incoming body10s + three media steps15s each + response margin10s.
export const MOQ_ARCHIVE_SAVE_TIMEOUT_MS = 75_000;
export const MOQ_PLAYER_DISPOSE_TIMEOUT_MS = 2_000;
