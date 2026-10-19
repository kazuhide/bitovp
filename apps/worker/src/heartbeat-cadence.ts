/**
 * The heartbeat sweep's cadence, in ONE importable place (review-260 127-A9):
 * index.ts cannot be imported by tests (module side effects — see
 * sdk-ops.stamp.test.ts), so the constant lives here and index.ts imports it.
 * Core's INGEST_CONNECTED_MAX_AGE_MS is 3 × this by design; the coupling pin
 * in heartbeat-coupling.test.ts enforces the relation against THIS value.
 */
export const HEARTBEAT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Per-channel budget for provider status and heartbeat monitoring, including
 * response bodies. Expiry cancels the poll and becomes a failed observation;
 * alert evaluation is then awaited so missing monitoring can become stale.
 * A transport that ignores cancellation retains its channel's pending owner
 * until it settles; later ticks evaluate staleness without adding requests.
 * Database work and alert finalization are outside this transport guarantee.
 */
export const HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS = 10_000;

/**
 * How many channels the sweep polls in parallel.
 * A bounded lane count keeps one slow/hung channel from delaying the others'
 * freshness SLA while capping the fan-out of concurrent SDK calls and DB
 * writes. Each channel is independent (its own row/run), so parallel polls do
 * not contend.
 */
export const HEARTBEAT_SWEEP_CONCURRENCY = 8;
