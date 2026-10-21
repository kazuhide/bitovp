import { z } from "zod";
import { liveAutoShutdownSchema } from "./schema";

export type LiveAutoShutdownConfiguration = z.infer<
	typeof liveAutoShutdownSchema
>;

export const liveAutoShutdownUpdateParamsSchema = z.strictObject({
	configuration: liveAutoShutdownSchema,
	expectedRevision: z.string().min(1).max(240).nullable().optional(),
});
export type LiveAutoShutdownUpdateParams = z.infer<
	typeof liveAutoShutdownUpdateParamsSchema
>;

export const liveAutoShutdownUpdateReceiptSchema = z
	.strictObject({
		configuration: liveAutoShutdownSchema,
		appliedAt: z.iso.datetime(),
		scheduledShutdownAt: z.iso.datetime().nullable().optional(),
		requestId: z.string().min(1),
	})
	.superRefine((receipt, ctx) => {
		if (
			receipt.configuration.streamTimeoutMinutes !== undefined &&
			!receipt.scheduledShutdownAt
		)
			ctx.addIssue({
				code: "custom",
				path: ["scheduledShutdownAt"],
				message:
					"An armed runtime timer requires the encoder's accepted stop instant",
			});
	});
export type LiveAutoShutdownUpdateReceipt = z.infer<
	typeof liveAutoShutdownUpdateReceiptSchema
>;
const appliedRecordSchema = z.object({
	kind: z.literal("LIVE_AUTO_SHUTDOWN_UPDATE"),
	status: z.literal("DONE"),
	payload: liveAutoShutdownUpdateReceiptSchema,
});

/** Stable input for a digest shared by admission and the worker. */
export function liveAutoShutdownFingerprint(
	runId: string,
	configuration: LiveAutoShutdownConfiguration,
	expectedRevision?: string | null,
): string {
	return JSON.stringify({
		runId,
		...(expectedRevision ? { expectedRevision } : {}),
		configuration: {
			bytesReadTimeoutSeconds: configuration.bytesReadTimeoutSeconds,
			streamTimeoutMinutes: configuration.streamTimeoutMinutes,
			waitingForFirstConnectTimeoutMinutes:
				configuration.waitingForFirstConnectTimeoutMinutes,
		},
	});
}

/** Runtime receipts are never provisioning steps and never replayed. */
export function readLiveAutoShutdownUpdate(
	entries: unknown,
): LiveAutoShutdownUpdateReceipt | null {
	if (!Array.isArray(entries)) return null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const record = appliedRecordSchema.safeParse(entries[i]);
		if (record.success) return record.data.payload;
	}
	return null;
}
