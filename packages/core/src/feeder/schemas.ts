import { z } from "zod";

/**
 * Pseudo-live feeder contracts (P3-PR3), shared by the web routes
 * (validation at create) and the feeder worker (re-parse of the persisted
 * row — DB JSON crosses processes, same rule as queue payloads).
 *
 * Secrets discipline: the SRT passphrase NEVER appears here — targets
 * carry a vault `passphraseCredentialId` ref resolved at spawn only.
 * `streamKey` is connection-routing material under the same ledgered
 * redaction exception as LiveChannel.streamKey (the worker rebuilds the
 * push URL from the row across restarts).
 */

export const feederProtocolSchema = z.enum(["RTMP", "SRT_CALLER"]);
export type FeederProtocolId = z.infer<typeof feederProtocolSchema>;

export const feederSourceSchema = z
	.object({
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		key: z.string().min(1),
	})
	.strict();
export type FeederSource = z.infer<typeof feederSourceSchema>;

/** RTMP push: base ingest URL (incl. app path) + stream key. */
export const feederRtmpTargetSchema = z
	.object({
		url: z
			.string()
			.regex(/^rtmps?:\/\/.+/, "must be an rtmp:// or rtmps:// URL"),
		streamKey: z.string().min(1),
	})
	.strict();
export type FeederRtmpTarget = z.infer<typeof feederRtmpTargetSchema>;

/**
 * SRT caller push (the feeder dials Bitmovin's listener — caller mode
 * only; listener-side SRT is for real external feeds). Strict on purpose:
 * a client posting a literal `passphrase` must be REJECTED, not silently
 * stripped — the only passphrase transport is the vault ref.
 */
export const feederSrtTargetSchema = z
	.object({
		host: z.string().min(1),
		port: z.number().int().min(1).max(65535),
		passphraseCredentialId: z.uuid().optional(),
	})
	.strict();
export type FeederSrtTarget = z.infer<typeof feederSrtTargetSchema>;

/** POST /api/feeder-sessions body — target shape is pinned to the protocol. */
/**
 * : `switchFromActive` makes the immediate create a TWO-PHASE
 * switch — the session downloads, probes and gates its source first, stops
 * the channel's active feeder only once it is READY, and spawns after that
 * feeder is proven gone (the scheduled switch's model, with lead 0). Without
 * it a second session on a channel that already has one is two pushes at one
 * ingest.
 */
const switchFromActiveField = {
	switchFromActive: z.boolean().optional(),
};

export const createFeederSessionSchema = z.discriminatedUnion("protocol", [
	z
		.object({
			liveChannelId: z.uuid(),
			source: feederSourceSchema,
			protocol: z.literal("RTMP"),
			target: feederRtmpTargetSchema,
			...switchFromActiveField,
		})
		.strict(),
	z
		.object({
			liveChannelId: z.uuid(),
			source: feederSourceSchema,
			protocol: z.literal("SRT_CALLER"),
			target: feederSrtTargetSchema,
			...switchFromActiveField,
		})
		.strict(),
]);
export type CreateFeederSessionRequest = z.infer<
	typeof createFeederSessionSchema
>;
