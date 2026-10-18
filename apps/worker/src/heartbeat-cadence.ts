/**
 * The heartbeat sweep's cadence, in ONE importable place (review-260 127-A9):
 * index.ts cannot be imported by tests (module side effects — see
 * sdk-ops.stamp.test.ts), so the constant lives here and index.ts imports it.
 * Core's INGEST_CONNECTED_MAX_AGE_MS is 3 × this by design; the coupling pin
 * in heartbeat-coupling.test.ts enforces the relation against THIS value.
 */
export const HEARTBEAT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Per-channel budget for one heartbeat poll + alert evaluation
 * . A single hung SDK poll must not stall the
 * sweep: past this deadline the channel's work is abandoned for the tick, its
 * lane is freed, and the sweep moves on. 10s is a third of the interval — far
 * more than a healthy `getLiveHeartbeat` GET needs, yet small enough that a
 * hung channel cannot push the sweep past the next 30s repeat.
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
