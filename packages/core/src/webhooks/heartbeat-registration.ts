import { z } from "zod";

export const heartbeatRegistrationConfigSchema = z.strictObject({
	v: z.literal(1),
	mode: z.enum([
		"PER_ENCODING",
		"LEGACY_ACCOUNT",
		"PENDING_VERSION",
		"POLL_ONLY",
	]),
	requestedEncoderVersion: z.string().max(100).nullable(),
	resolvedEncoderVersion: z.string().max(100).nullable(),
	intervalS: z.number().int().positive(),
	registrationId: z.uuid(),
	channelId: z.uuid(),
	runId: z.uuid(),
	createAttempted: z.boolean(),
});

export type HeartbeatRegistrationConfig = z.infer<
	typeof heartbeatRegistrationConfigSchema
>;

export function parseHeartbeatRegistrationConfig(
	value: unknown,
): HeartbeatRegistrationConfig | null {
	const result = heartbeatRegistrationConfigSchema.safeParse(value);
	return result.success ? result.data : null;
}

/** Only concrete, released 2.x versions have a known capability contract. */
function versionMinor(version: string | null): number | null {
	if (!version || !/^2\.\d+\.\d+$/.test(version)) return null;
	const parts = version.split(".").map(Number);
	return parts.every(Number.isSafeInteger) ? (parts[1] ?? null) : null;
}

export function resolveHeartbeatMode(
	requested: string | null,
	resolved: string | null,
	_policy: "PER_ENCODING" | "AUTO" | "LEGACY_ACCOUNT" = "PER_ENCODING",
): HeartbeatRegistrationConfig["mode"] {
	const selected = versionMinor(resolved);
	if (selected !== null) return selected >= 285 ? "PER_ENCODING" : "POLL_ONLY";
	// A known old fixed version remains on Poll; no account-level fallback.
	const fixed = versionMinor(requested);
	if (!resolved && fixed !== null && fixed < 285) return "POLL_ONLY";
	return "PENDING_VERSION";
}

/** No plans, URLs, secrets or user-entered metadata cross this boundary. */
export function heartbeatCustomData(config: HeartbeatRegistrationConfig) {
	return {
		bitOvp: {
			v: 1 as const,
			registrationId: config.registrationId,
			channelId: config.channelId,
			runId: config.runId,
		},
	};
}
