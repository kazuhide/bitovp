import {
	type AisaFinalizationProof,
	type AisaLiveResultSnapshot,
	aisaResultSchema,
} from "@bitovp/core";
import {
	type AisaLiveClient,
	type AisaLiveCreateRequest,
	AisaLiveError,
	type AisaLiveVersions,
	aisaLivePreviewEnabled,
	createAisaLiveClient,
} from "@bitovp/core/aisa-live-client";
import { z } from "zod";
import type { OpsContext } from "./ops/context";
import type { SdkOps } from "./sdk-ops";

const analysisSchema = z.object({
	analysisId: z.uuid(),
	encodingId: z.uuid(),
	status: z.enum([
		"CREATED",
		"QUEUED",
		"RUNNING",
		"FINISHED",
		"CANCELED",
		"ERROR",
		"TRANSFER_ERROR",
	]),
	name: z.string().optional(),
});
export type AisaLiveAnalysis = z.infer<typeof analysisSchema>;
export type AisaLiveObservation = {
	analysis: AisaLiveAnalysis;
	snapshot?: AisaLiveResultSnapshot;
	finalization?: AisaFinalizationProof;
};

/** These callbacks run inside the existing provision lease and run-generation fence. */
export type AisaLiveControl = {
	runId(): string;
	analysisId(): string | undefined;
	encodingId?(): string | undefined;
	creationMayExist?(): boolean;
	beforeCreate?(): Promise<void>;
	startMayExist?(): boolean;
	beforeStart?(): Promise<void>;
	allowCreate?(): boolean;
	onObservation?(observation: AisaLiveObservation): Promise<void>;
	/** Runtime stop waits for Analysis drain before using the Encoding stop fallback. */
	sleep?(ms: number): Promise<void>;
};

export class AisaLiveIdentityError extends Error {
	constructor() {
		super("AISA_LIVE_IDENTITY_MISMATCH");
	}
}
export class AisaLiveFinalizationPendingError extends Error {
	constructor() {
		super("AISA_LIVE_FINALIZATION_PENDING");
	}
}

export function createAisaLiveOps(
	ctx: OpsContext,
	liveOps: Pick<SdkOps, "stopLiveEncoding" | "restartLiveEncoding">,
	encodingOps: Pick<SdkOps, "getEncodingStatus">,
): Pick<
	SdkOps,
	| "createAisaLiveAnalysis"
	| "getAisaLiveAnalysis"
	| "startAisaLiveAnalysis"
	| "stopAisaLiveAnalysis"
	| "stopLiveEncoding"
	| "restartLiveEncoding"
> {
	const { options, audited } = ctx;
	let client: AisaLiveClient | undefined;
	const load = (versions?: AisaLiveVersions) => {
		if (versions)
			return createAisaLiveClient({
				apiKey: options.apiKey,
				tenantOrgId: options.tenantOrgId ?? undefined,
				versions,
			});
		client ??= createAisaLiveClient({
			apiKey: options.apiKey,
			tenantOrgId: options.tenantOrgId ?? undefined,
		});
		return client;
	};
	const safeAnalysis = (
		raw: unknown,
		expectedId?: string,
	): AisaLiveAnalysis => {
		const parsed = analysisSchema.safeParse(raw);
		if (
			!parsed.success ||
			(expectedId && parsed.data.analysisId !== expectedId)
		)
			throw new AisaLiveIdentityError();
		return parsed.data;
	};
	const get = async (id: string) => {
		const analysis = safeAnalysis(await load().get(id), id);
		const expectedAnalysis = options.aisaLive?.analysisId();
		const expectedEncoding = options.aisaLive?.encodingId?.();
		if (
			(expectedAnalysis && analysis.analysisId !== expectedAnalysis) ||
			(expectedEncoding && analysis.encodingId !== expectedEncoding)
		)
			throw new AisaLiveIdentityError();
		await options.aisaLive?.onObservation?.({ analysis });
		return analysis;
	};
	const check = async (attempted: boolean) =>
		options.startControl?.check(attempted);
	const findExact = async (
		name: string,
	): Promise<AisaLiveAnalysis | undefined> => {
		const matches: string[] = [];
		const limit = 100;
		for (let offset = 0; offset < 10_000; offset += limit) {
			const raw = await load().list({ offset, limit });
			const page = z
				.object({
					items: z.array(analysisSchema),
					totalCount: z.number().optional(),
				})
				.safeParse(raw);
			if (!page.success)
				throw new Error("AISA_LIVE_RECONCILIATION_UNAVAILABLE");
			for (const item of page.data.items)
				if (item.name === name) matches.push(item.analysisId);
			if (matches.length > 1) throw new Error("AISA_LIVE_IDENTITY_AMBIGUOUS");
			if (
				page.data.items.length < limit &&
				(page.data.totalCount === undefined ||
					page.data.totalCount <= offset + page.data.items.length)
			) {
				if (!matches[0]) return undefined;
				const found = await get(matches[0]);
				if (found.name !== name) throw new Error("AISA_LIVE_IDENTITY_MISMATCH");
				return found;
			}
		}
		throw new Error("AISA_LIVE_RECONCILIATION_SCAN_INCOMPLETE");
	};
	const observeFinal = async (analysis: AisaLiveAnalysis) => {
		try {
			const parsed = aisaResultSchema.safeParse(
				await load().latest(analysis.analysisId),
			);
			if (
				!parsed.success ||
				parsed.data.analysisId !== analysis.analysisId ||
				parsed.data.encodingId !== analysis.encodingId
			)
				throw new AisaLiveIdentityError();
			await options.aisaLive?.onObservation?.({
				analysis,
				snapshot: parsed.data,
				...(["FINISHED", "ERROR", "CANCELED", "TRANSFER_ERROR"].includes(
					analysis.status,
				)
					? {
							finalization: {
								analysisId: analysis.analysisId,
								encodingId: analysis.encodingId,
								status: analysis.status as AisaFinalizationProof["status"],
								result: parsed.data.isFinal
									? ("FINAL" as const)
									: ("AVAILABLE_PARTIAL" as const),
								observedAt: new Date().toISOString(),
							},
						}
					: {}),
			});
			return (
				parsed.data.isFinal ||
				["ERROR", "CANCELED", "TRANSFER_ERROR"].includes(analysis.status)
			);
		} catch (error) {
			if (
				error instanceof AisaLiveError &&
				error.httpStatusCode === 404 &&
				error.code === "LIVE_ANALYSIS_RESULT_NOT_AVAILABLE"
			) {
				if (["ERROR", "CANCELED", "TRANSFER_ERROR"].includes(analysis.status)) {
					await options.aisaLive?.onObservation?.({
						analysis,
						finalization: {
							analysisId: analysis.analysisId,
							encodingId: analysis.encodingId,
							status: analysis.status as AisaFinalizationProof["status"],
							result: "UNAVAILABLE_TERMINAL_FAILURE",
							observedAt: new Date().toISOString(),
						},
					});
					return true;
				}
				return false;
			}
			throw error;
		}
	};
	const stopAnalysis = async (
		id: string,
		encodingId: string,
	): Promise<void> => {
		let analysis = await get(id);
		if (analysis.encodingId !== encodingId) throw new AisaLiveIdentityError();
		if (
			!["FINISHED", "CANCELED", "ERROR", "TRANSFER_ERROR"].includes(
				analysis.status,
			)
		) {
			await check(false);
			await audited(
				"POST",
				`/ai-scene-analysis/live-analyses/${id}/stop`,
				{ analysisId: id, encodingId },
				() => load().stop(id),
				() => ({ stopRequested: true }),
			);
		}
		const deadline = Date.now() + 24_000;
		for (let attempt = 0; attempt < 12 && Date.now() < deadline; attempt++) {
			analysis = await get(id);
			if (analysis.encodingId !== encodingId) throw new AisaLiveIdentityError();
			if (analysis.status === "FINISHED" && (await observeFinal(analysis)))
				return;
			if (
				["CANCELED", "ERROR", "TRANSFER_ERROR"].includes(analysis.status) &&
				(await observeFinal(analysis))
			)
				return;
			await (
				options.aisaLive?.sleep ??
				((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
			)(2_000);
		}
		throw new AisaLiveFinalizationPendingError();
	};
	return {
		createAisaLiveAnalysis: async (request: AisaLiveCreateRequest) => {
			const control = options.aisaLive;
			// A cleanup may reconcile an already-dispatched CREATE by exact run
			// name after Preview is disabled; allowCreate=false still forbids POST.
			if (!aisaLivePreviewEnabled() && control?.allowCreate?.() !== false)
				throw new Error("AISA_LIVE_PREVIEW_DISABLED");
			if (
				!control?.beforeCreate ||
				!control.creationMayExist ||
				!z.uuid().safeParse(control.runId()).success
			)
				throw new Error("AISA_LIVE_CREATE_REQUIRES_DURABLE_RUN");
			await check(false);
			const suffix = ` [bitovp-run:${control.runId()}]`;
			const name = `${request.name.slice(0, 200 - suffix.length)}${suffix}`;
			const existing = await findExact(name);
			if (existing) return existing.analysisId;
			if (control.creationMayExist())
				throw new Error("AISA_LIVE_CREATE_OUTCOME_UNKNOWN");
			if (control.allowCreate?.() === false)
				throw new Error("AISA_LIVE_CREATE_FORBIDDEN_DURING_CANCELLATION");
			await control.beforeCreate();
			await check(false);
			try {
				const result = await audited(
					"POST",
					"/ai-scene-analysis/live-analyses",
					{
						name,
						cloudRegion: request.cloudRegion,
						encoderVersion: request.encoderVersion,
					},
					() => load().create({ ...request, name }),
					(raw) => safeAnalysis(raw),
				);
				return safeAnalysis(result).analysisId;
			} catch {
				const recovered = await findExact(name);
				if (recovered) return recovered.analysisId;
				throw new Error("AISA_LIVE_CREATE_OUTCOME_UNKNOWN");
			}
		},
		getAisaLiveAnalysis: get,
		startAisaLiveAnalysis: async (
			id: string,
			encodingId: string,
			versions?: AisaLiveVersions,
		) => {
			if (!aisaLivePreviewEnabled())
				throw new Error("AISA_LIVE_PREVIEW_DISABLED");
			const analysis = await get(id);
			if (analysis.encodingId !== encodingId)
				throw new Error("AISA_LIVE_IDENTITY_MISMATCH");
			if (["QUEUED", "RUNNING", "FINISHED"].includes(analysis.status)) return;
			if (analysis.status !== "CREATED")
				throw new Error("AISA_LIVE_START_REFUSED");
			const control = options.aisaLive;
			if (!control?.beforeStart || !control.startMayExist)
				throw new Error("AISA_LIVE_START_REQUIRES_DURABLE_RUN");
			if (control.startMayExist())
				throw new Error("AISA_LIVE_START_OUTCOME_UNKNOWN");
			await check(false);
			await control.beforeStart();
			await check(false);
			try {
				await audited(
					"POST",
					`/ai-scene-analysis/live-analyses/${id}/start`,
					{ analysisId: id, encodingId, ...versions },
					() => load(versions).start(id),
					() => ({ started: true }),
				);
			} catch {
				await check(true);
				const recovered = await get(id);
				if (
					recovered.encodingId === encodingId &&
					["QUEUED", "RUNNING", "FINISHED"].includes(recovered.status)
				)
					return;
				throw new Error("AISA_LIVE_START_OUTCOME_UNKNOWN");
			}
		},
		stopAisaLiveAnalysis: stopAnalysis,
		stopLiveEncoding: async (encodingId: string) => {
			const analysisId = options.aisaLive?.analysisId();
			if (!analysisId) return liveOps.stopLiveEncoding(encodingId);
			// Exact binding must be proven before either provider mutation. An
			// unreadable identity cannot authorize a stop of an unrelated encoder.
			let finalizationError: unknown;
			let binding: AisaLiveAnalysis | undefined;
			try {
				binding = await get(analysisId);
			} catch (error) {
				if (
					error instanceof AisaLiveIdentityError ||
					!(error instanceof AisaLiveError) ||
					options.aisaLive?.encodingId?.() !== encodingId
				)
					throw error;
				finalizationError = error;
			}
			if (binding && binding.encodingId !== encodingId)
				throw new AisaLiveIdentityError();
			if (binding) {
				try {
					await stopAnalysis(analysisId, encodingId);
				} catch (error) {
					if (error instanceof AisaLiveIdentityError) throw error;
					finalizationError = error;
				}
			}
			// Only after a bounded drain attempt may the ordinary stop prevent a
			// provider failure from leaving the paid Encoding running indefinitely.
			const task = await encodingOps.getEncodingStatus(encodingId);
			if (!["FINISHED", "CANCELED", "ERROR"].includes(task.status)) {
				await check(false);
				await liveOps.stopLiveEncoding(encodingId);
			}
			if (finalizationError) throw new AisaLiveFinalizationPendingError();
		},
		restartLiveEncoding: async (encodingId: string) => {
			if (options.aisaLive?.analysisId())
				throw new Error("AISA_LIVE_RESTART_REQUIRES_NEW_RUN");
			return liveOps.restartLiveEncoding(encodingId);
		},
	};
}
