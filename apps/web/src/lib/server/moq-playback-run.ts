import "server-only";
import {
	MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH,
	moqRunNamespaceSuffix,
	type StepLogEntry,
	stepLogSchema,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import { z } from "zod";

export const moqPlaybackRunSelect = {
	id: true,
	liveChannelId: true,
	organizationId: true,
	status: true,
	endedAt: true,
	cancelRequested: true,
	bitmovinEncodingId: true,
	stepLog: true,
} as const satisfies Prisma.LiveChannelRunSelect;

type MoqPlaybackRun = Prisma.LiveChannelRunGetPayload<{
	select: typeof moqPlaybackRunSelect;
}>;

export const moqStoredOutputSchema = z.object({
	credentialId: z.uuid(),
	trackNamespace: z.tuple([
		z.string().min(1).max(MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH),
	]),
	draftVersion: z.enum(["DRAFT_16", "DRAFT_18"]),
});

export function hasCompletedMoqMuxing(
	entries: readonly StepLogEntry[],
	encodingStep: string,
	outputStep: string,
): boolean {
	return entries.some(
		(entry) =>
			(entry.kind === "CREATE_MUXING_FMP4" ||
				entry.kind === "CREATE_MUXING_CMAF") &&
			entry.status === "DONE" &&
			entry.refs.encodingId === encodingStep &&
			entry.refs.outputId === outputStep,
	);
}

/** Verify the stored run graph before opening credentials or admitting a measurement. */
export function readMoqPlaybackBinding(
	run: MoqPlaybackRun | null,
	target: { channelId: string; runId: string; organizationId: string },
) {
	if (
		!run ||
		run.id !== target.runId ||
		run.liveChannelId !== target.channelId ||
		run.organizationId !== target.organizationId
	) {
		return {
			ok: false,
			status: 404,
			code: "MOQ_PLAYBACK_RUN_NOT_FOUND",
		} as const;
	}
	const unavailable = {
		ok: false,
		status: 409,
		code: "MOQ_PLAYBACK_RUN_UNBOUND",
	} as const;
	if (run.status !== "RUNNING" || run.endedAt || run.cancelRequested)
		return unavailable;
	const encodingId = z.uuid().safeParse(run.bitmovinEncodingId);
	if (!encodingId.success) return unavailable;

	// The descriptor audit keeps the encoding ID even when a later graph check fails.
	const unbound = { ...unavailable, encodingId: encodingId.data };
	const parsed = stepLogSchema.safeParse(run.stepLog);
	if (!parsed.success) return unbound;
	const outputs = parsed.data.filter((entry) =>
		entry.kind.startsWith("CREATE_OUTPUT_"),
	);
	const encodings = parsed.data.filter(
		(entry) => entry.kind === "CREATE_ENCODING",
	);
	const output = outputs[0];
	const encoding = encodings[0];
	const outputId = z.uuid().safeParse(output?.resourceId);
	if (
		outputs.length !== 1 ||
		output?.kind !== "CREATE_OUTPUT_MOQ" ||
		output.status !== "DONE" ||
		!outputId.success ||
		encodings.length !== 1 ||
		encoding?.status !== "DONE" ||
		encoding.resourceId !== encodingId.data
	) {
		return unbound;
	}
	const stored = moqStoredOutputSchema.safeParse(output.payload);
	const startedAt = Date.parse(output.startedAt ?? "");
	const linkedMuxing = hasCompletedMoqMuxing(
		parsed.data,
		encoding.step,
		output.step,
	);
	if (!stored.success || !Number.isFinite(startedAt) || !linkedMuxing) {
		return { ...unbound, code: "MOQ_PLAYBACK_DELIVERY_UNSUPPORTED" } as const;
	}
	if (
		!stored.data.trackNamespace[0].endsWith(moqRunNamespaceSuffix(target.runId))
	) {
		return unbound;
	}
	return {
		ok: true,
		encodingId: encodingId.data,
		outputId: outputId.data,
		output: stored.data,
		startedAt,
	} as const;
}
