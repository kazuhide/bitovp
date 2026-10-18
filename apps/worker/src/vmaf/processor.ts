import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	buildVmafCommand,
	computePooled,
	computePsnrPooled,
	type EncodingPlan,
	encodingPlanSchema,
	enumerateExistingMp4Targets,
	enumerateFrameIndexQcTargets,
	enumerateQcTargets,
	evaluateQcGate,
	gateExpectedRenditionKeys,
	PER_TITLE_ATTRIBUTION_VERSION,
	PER_TITLE_SCHEMA_VERSION,
	type PerTitleProviderResult,
	type PerTitleResultsSnapshot,
	parseVmafJson,
	perTitleResultsView,
	perTitleRungsFromSnapshot,
	type QcGate,
	type QcTarget,
	type RenditionPooled,
	redactSecrets,
	VMAF_FRAME_INDEX_SCORING_VERSION,
	type VmafCloudProfile,
	type VmafCommandOptions,
	type VmafExecution,
	vmafCloudProfileSchema,
	vmafExecutionSchema,
	vmafJobSchema,
	vmafSourceFor,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	autoTriggerKey,
	labManualTriggerPrefix,
	type Prisma,
} from "@bitovp/db";
import type { ProcessRunner } from "../feeder/supervisor";
import type { EmitProductEvent } from "../notify/emitter";
import type { ResolvedCredential } from "../orchestrator/executor";
import { ResetRowDeleted, whileRowExists } from "../reset/row-liveness";
import type { CloudScoreRequest } from "./cloud/controller";
import { signGcsVmafInput } from "./cloud/remote-input";
import {
	type DownloadProvenance,
	defaultVmafDownload,
	type VmafDownload,
} from "./download";
import { type Geometry, geometryFromProbe } from "./geometry";
import { isUnresolvableModel, unresolvableModelMessage } from "./model-error";
import {
	defaultKeyLister,
	type KeyLister,
	resolveDistortedKeys,
} from "./resolve-distorted";

/**
 * VOD VMAF runner (P4-PR3): scores a FINISHED qc-enabled encoding with our
 * own ffmpeg+libvmaf pipeline (Bitmovin has no VMAF API). Job data is
 * `{ vmafJobId }`; the row carries the encodingJob whose plan named the
 * renditions and the `qc/<key>.mp4` mirrors the compiler emitted.
 *
 * Per video rendition the compiler mirrored: download the REFERENCE (the
 * encoding's source mezzanine, once — every rendition shares it) and the
 * DISTORTED (`qc/<key>.mp4`), conform the distorted to the reference
 * geometry (libvmaf requires identical W×H + fps), run libvmaf, then pool
 * the per-frame scores into a VmafResult. The full per-frame array is
 * gzipped into `framesGzip` (a 3h clip is ~324k frames — JSON would bloat
 * the row and Postgres TOAST; gzip is the single efficient path and the
 * report gunzips). `frames` stays null.
 *
 * Status: PENDING → RUNNING (atomic claim) → FINISHED, or ERROR with a
 * redacted message on any failure. Partial VmafResults that already
 * succeeded are kept (they are real measurements); the JOB status reflects
 * the failure so the UI never reads a half-done run as complete.
 *
 * Secret discipline mirrors the feeder: credentials are resolved at use and
 * never logged; ffmpeg stderr is redacted before it enters an error string.
 */

/**
 * Producer surface of the orchestrator queue  — the
 * continuation hop that wakes an AWAITING_QC job once the verdict is written.
 * Structural so tests need no bullmq; `getJob` exists for the claim-failed
 * self-heal (a stalled-redelivery re-checks whether the continuation ever
 * landed and re-adds it if not).
 */
export type OrchestratorQueueLike = {
	add(
		name: string,
		data: { encodingJobId: string },
		opts: { jobId: string; removeOnComplete: number; removeOnFail: number },
	): Promise<unknown>;
	getJob(jobId: string): Promise<unknown | null | undefined>;
};

/**
 * Continuation jobId — a DASH, not a colon (BullMQ rejects `:` in custom
 * ids). Scoped PER MEASUREMENT (review-201 I2): a fixed id could fire once,
 * ever — BullMQ silently no-ops an add whose id exists in ANY state, and
 * removeOnComplete retains 1000 completions, so a deleted-and-remeasured
 * VmafJob's fresh verdict could never wake the parked job again (the exact
 * swallow the retry route's timestamped-id comment warns about). Keyed by
 * vmafJobId rather than a timestamp so the SAME measurement still dedupes
 * its redeliveries and the claim-failed self-heal can probe for it.
 */
export function qcContinuationJobId(
	encodingJobId: string,
	vmafJobId: string,
): string {
	return `${encodingJobId}-resume-post-qc-${vmafJobId}`;
}

export type VmafProcessorDeps = {
	cloudScore?: (request: CloudScoreRequest) => Promise<void>;
	resolveCloudProfile?: (profileId: string) => Promise<VmafCloudProfile>;
	/** Product-event emit ; never throws. */
	emitEvent?: EmitProductEvent;
	/** Orchestrator producer . Absent ⇒ gate plans still score
	    and store verdicts, but no continuation is enqueued — wire it in every
	    real deployment; tests without gates omit it. */
	orchestratorQueue?: OrchestratorQueueLike;
	prisma: AppPrismaClient;
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	runner: ProcessRunner;
	ffmpegPath: string;
	ffprobePath: string;
	/** Working directory root; a per-job subdir is created under it. */
	workDir: string;
	now(): string;
	/** Injectable download (tests run without fs/network). */
	download?: VmafDownload;
	/** Injectable object lister — resolves per-title placeholder mirror keys. */
	listKeys?: KeyLister;
	/** libvmaf worker threads (n_threads); omitted ⇒ libvmaf default. */
	threads?: number;
	/**
	 * Frame subsample stride (libvmaf n_subsample); omitted ⇒ full precision.
	 * When > 1, only every Nth frame is scored — faster, sparser per-frame
	 * series, less-reliable min (the pooled mean is barely affected).
	 */
	subsample?: number;
	/** How many qc mirrors (per-title rungs) to score concurrently (default 1). */
	concurrency?: number;
	/** Worker CPU core count at run time — recorded for report observability. */
	cores?: number;
	/**
	 * Resolves a model NAME to a local model-JSON path when the image bundles it
	 * (VMAF_MODEL_DIR), so the runner can load it with `model=path=` instead of
	 * `model=version=`. Required for the "VMAF v1" models (vmaf_v1.0.16_*), which
	 * no libvmaf build exposes as a built-in. Returns undefined ⇒ fall back to
	 * the built-in version (the v0.6.1 family, available on the host too).
	 */
	resolveModelPath?: (model: string) => string | undefined;
};

class CloudVmafStopped extends Error {}

export type VmafResult = {
	acknowledged: true;
	vmafJobId: string;
	status: string;
	results: number;
};

/**
 * DELETED, deliberately: a hand-written row type intersected onto Prisma's
 * inferred type and then `as`-cast onto a `select`ed query.
 *
 * The cast re-asserted `plan` / `createdAt` / `name` / `labels` whatever the
 * SELECT actually requested, so it did not leave one field unguarded — it left
 * the WHOLE select unguarded. Measured (review-final, reproduced here): drop
 * `name: true` from the select and `tsc` reports zero errors and all 38 tests
 * pass, while in production `row.encodingJob.name` becomes `undefined`,
 * `JOB_QC_FAILED` fails `productEventSchema`'s `name: z.string`, and
 * `notify/emitter.ts` logs "DROPPED schema-invalid" and RETURNS — so the QC
 * gate would block delivery and nobody would ever be told. On 's KEY
 * feature that is the worst available failure mode.
 *
 * Removing the cast typechecks clean — Prisma's inferred type already
 * satisfies every consumer — so the cast bought no safety and only
 * suppressed. This is the one construction, of 37 `select` sites in the
 * worker, that took the compiler out of the loop.
 */

/**
 * Gate context threaded to markTerminal (#86/#198). Present only for the
 * encoding's exact AUTO measurement with a valid gate plan. Other measurements
 * retain scoring and terminal reporting without changing delivery decisions.
 */
type GateContext = {
	encodingJobId: string;
	gate: QcGate;
	/** The plan's promised measurement population (review-201 C2) — every
	    video rendition key, resolvability-unfiltered. */
	expected: string[];
	/**
	 * Per-title rungs the provider built that this run could not score
	 *  — filled in once the work list is known, held to the bar
	 * as failing actuals. Absent means "nothing unmeasured", never "unknown".
	 */
	unmeasured?: { rendition: string; variant?: string }[];
	jobName: string;
	jobLabels: string[];
};

/**
 * The captured per-title ladder for this encoding  — resolved by
 * the SAME rule the detail view uses (`perTitleResultsView`, core): best
 * evidence wins between the operator's manual capture and the capture step's
 * own response, scored by completeness and rung count. Review-329 caught the
 * first cut re-implementing this as "manual wins if it parses": a short manual
 * capture then shadowed a fuller step capture forever, and a rung absent from
 * the shorter snapshot was not `{missing}` — it was invisible, which is this
 * row's own failure mode through a different door.
 */
function capturedPerTitleSnapshot(job: {
	snapshots: unknown;
	stepLog: unknown;
}): PerTitleResultsSnapshot | undefined {
	const view = perTitleResultsView({
		stepLog: job.stepLog,
		snapshots: job.snapshots,
	});
	return "snapshot" in view ? view.snapshot : undefined;
}

/**
 * Provider output resource created for one exact plan output key.
 *
 * A per-title muxing snapshot can retain several delivery-mirror output legs
 * with the same object key. The persisted DONE create step is the run-bound
 * map from the plan key to provider id; array order is not identity. Conflicting
 * duplicate ids are ambiguous and therefore fail closed.
 */
function providerOutputIdFromStepLog(
	stepLog: unknown,
	outputKey: string,
): string | undefined {
	if (!Array.isArray(stepLog)) {
		return undefined;
	}
	const expectedStep = `output:${outputKey}`;
	const ids = new Set<string>();
	for (const entry of stepLog) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			(entry as Record<string, unknown>).step !== expectedStep ||
			(entry as Record<string, unknown>).status !== "DONE"
		) {
			continue;
		}
		const resourceId = (entry as Record<string, unknown>).resourceId;
		if (typeof resourceId === "string" && resourceId.length > 0) {
			ids.add(resourceId);
		}
	}
	return ids.size === 1 ? ids.values().next().value : undefined;
}

/** One rung the run was asked to measure and could not, with the reason. */
type UnmeasuredRung = { rendition: string; variant: string; reason: string };

/**
 * The unmeasured rungs, spelled out for the job's `error` field.
 *
 * Named per rung (`rendition[variant]: why`), never counted, because the count
 * alone is what made the paid audit's `unmeasured 7` unactionable: "the captured
 * ladder attributes no rung to this rendition" (attribution abstained — see
 * `attributeResult`, which needs exactly ONE per-title template of the codec)
 * and "none is a QC mirror under a qc/ directory" (the ladder was captured but
 * the mirrors are not in it) call for completely different next moves, and only
 * the reason string separates them.
 */
function describeUnmeasured(list: readonly UnmeasuredRung[]): string {
	if (list.length === 0) {
		return "No rung recorded a reason — the target list itself was empty.";
	}
	return `Unmeasured: ${list
		.map((u) => `${u.rendition}[${u.variant}]: ${u.reason}`)
		.join(" | ")}`;
}

/** Last non-empty stderr line, redacted — the ffmpeg failure reason. */
function stderrTail(stderr: string): string {
	const line =
		stderr
			.trim()
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.at(-1) ?? "no output";
	return redactSecrets(line);
}

/** renditionRef stored on the VmafResult row (identity for the report). */
function renditionRef(
	target: QcTarget,
	variant: string | undefined,
	probed?: { height?: number; bitrate?: number },
): Record<string, unknown> {
	return {
		renditionKey: target.renditionKey,
		codec: target.codec,
		// Per-title height/bitrate are null in the plan (the algorithm picks them
		// per rung), so fill them from the distorted mirror's ACTUAL ffprobe
		// values — that's what lets the quality ladder place per-title rungs.
		// Standard renditions keep their plan values (probed is only read here).
		height: target.height ?? probed?.height ?? null,
		bitrate: target.bitrate ?? probed?.bitrate ?? null,
		...(target.streamName ? { streamName: target.streamName } : {}),
		// Per-title: the resolved {height}_{bitrate}_{uuid} segment of the mirror
		// key — distinguishes the multiple rungs a per-title rendition produces.
		...(variant ? { perTitleVariant: variant } : {}),
	};
}

/**
 * ffprobe the distorted mirror for its real encoded height + bitrate (per-title
 * rungs carry no plan metadata). Best-effort: a probe failure returns {} so the
 * ladder simply omits the point — it must never fail the VMAF run.
 */
async function probeDistortedMetrics(
	deps: VmafProcessorDeps,
	path: string,
	signal: AbortSignal,
): Promise<{ height?: number; bitrate?: number }> {
	const toInt = (v: string | undefined): number | undefined => {
		if (v === undefined) {
			return undefined;
		}
		const n = Number.parseInt(v, 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	};
	try {
		const probe = await deps.runner.run(
			deps.ffprobePath,
			[
				"-v",
				"error",
				"-print_format",
				"json",
				"-show_streams",
				"-show_format",
				path,
			],
			{ signal },
		);
		if (probe.code !== 0) {
			return {};
		}
		const j = JSON.parse(probe.stdout) as {
			streams?: { codec_type?: string; height?: number; bit_rate?: string }[];
			format?: { bit_rate?: string; size?: string; duration?: string };
		};
		const video = (j.streams ?? []).find((s) => s.codec_type === "video");
		// Mirror is a video-only progressive MP4, so format bit_rate ≈ video
		// bitrate; fall back to the stream's, then to size×8 / duration.
		const dur = Number.parseFloat(j.format?.duration ?? "");
		const size = toInt(j.format?.size);
		const computed =
			size !== undefined && Number.isFinite(dur) && dur > 0
				? Math.round((size * 8) / dur)
				: undefined;
		return {
			height: video?.height,
			bitrate: toInt(j.format?.bit_rate) ?? toInt(video?.bit_rate) ?? computed,
		};
	} catch {
		return {};
	}
}

/**
 * Resolves an input/output key to a download-ready (credential, bucket).
 *
 * The rule itself lives in CORE (`vmafSourceFor`), not here. It used to be an
 * inline `kind === "S3" || kind === "AZURE"` allowlist, and the plan schema
 * grew past it without anything going red: `GENERIC_S3` (audit e57f2d3,
 * AKR-E57-008) plus `GCS` and `GCS_SERVICE_ACCOUNT`, found by deriving the
 * population from the schema union instead of from the reported instance. All
 * three are browsable by `packages/storage` and were refused here anyway —
 * AFTER Bitmovin had run and billed the encode.
 *
 * Sharing the rule with the plan validator is the fix that matters. The rail
 * refuses an unscoreable QC plan before any operation runs; this stays as the
 * backstop for a plan that predates the rail. Two copies of the rule is how
 * the gap opened, so there is now one.
 */
async function resolveInputSource(
	deps: VmafProcessorDeps,
	plan: EncodingPlan,
	inputKey: string,
): Promise<{ credential: ResolvedCredential; bucket: string }> {
	const input = plan.inputs.find((i) => i.key === inputKey);
	if (!input) {
		throw new Error(`plan input "${inputKey}" not found`);
	}
	const source = vmafSourceFor(input);
	if (!source.streamable) {
		throw new Error(
			`VMAF reference download cannot use input "${inputKey}": ${source.reason}`,
		);
	}
	return {
		credential: await deps.resolveCredential(source.credentialId),
		bucket: source.bucket,
	};
}

async function resolveOutputSource(
	deps: VmafProcessorDeps,
	plan: EncodingPlan,
	outputKey: string,
): Promise<{ credential: ResolvedCredential; bucket: string }> {
	const output = plan.outputs.find((o) => o.key === outputKey);
	if (!output) {
		throw new Error(`plan output "${outputKey}" not found`);
	}
	const source = vmafSourceFor(output);
	if (!source.streamable) {
		throw new Error(
			`VMAF distorted download cannot use output "${outputKey}": ${source.reason}`,
		);
	}
	return {
		credential: await deps.resolveCredential(source.credentialId),
		bucket: source.bucket,
	};
}

export function createVmafProcessor(deps: VmafProcessorDeps) {
	const download = deps.download ?? defaultVmafDownload;
	const listKeys = deps.listKeys ?? defaultKeyLister;
	const concurrency = Math.max(1, deps.concurrency ?? 1);

	/**
	 * Wake the parked encoding job . SWALLOWS failures by
	 * design: the verdict transaction has already committed, and flipping this
	 * green run to ERROR over a Redis hiccup would misreport a real
	 * measurement. The residual (verdict written, wake lost) is healed by the
	 * claim-failed path below on any stalled-redelivery of this vmaf job, and
	 * recorded in  for the Redis-outage-survivor case it can't reach.
	 */
	async function enqueueContinuation(
		encodingJobId: string,
		vmafJobId: string,
	): Promise<void> {
		if (!deps.orchestratorQueue) {
			console.error(
				`[vmaf] gate verdict for encoding ${encodingJobId} has no orchestrator queue wired — the job stays parked until a manual resume`,
			);
			return;
		}
		try {
			await deps.orchestratorQueue.add(
				"orchestrate",
				{ encodingJobId },
				{
					jobId: qcContinuationJobId(encodingJobId, vmafJobId),
					removeOnComplete: 1000,
					removeOnFail: 1000,
				},
			);
		} catch (err) {
			console.error(
				`[vmaf] continuation enqueue for encoding ${encodingJobId} failed (verdict already stored):`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	async function markTerminal(
		vmafJobId: string,
		status: "FINISHED" | "ERROR",
		resultCount: number,
		error?: string,
		// On FINISHED, pin doneUnits to the total so the bar reads 100% even if a
		// best-effort increment was dropped. This is the authoritative status
		// write (not best-effort), so it carries the reconciliation. ERROR keeps
		// the partial count — it reflects what actually scored.
		finalUnits?: number,
		// Only the encoding's AUTO measurement may judge its configured gate.
		gateCtx?: GateContext,
		runningOnly = false,
	): Promise<VmafResult> {
		// Both terminal writes below spell `status,` first IN PLACE — the
		// emit-sites pin counts writes by that shape, and hoisting the object
		// into a variable is exactly the blindness its comment names.
		if (gateCtx && status === "FINISHED") {
			// Verdict over what this run actually persisted. Zero rows on a gate
			// plan is a verdict too: every rule fails on unmeasured targets —
			// the gate refuses loudly rather than passing an unmeasured encode.
			const rows = await deps.prisma.vmafResult.findMany({
				where: { vmafJobId },
				select: { renditionRef: true, pooled: true },
			});
			const measurements: RenditionPooled[] = rows.map(
				(result: { renditionRef: unknown; pooled: unknown }) => {
					const ref = result.renditionRef as {
						renditionKey?: string;
						perTitleVariant?: string;
					};
					return {
						rendition: ref.renditionKey ?? "unknown",
						...(ref.perTitleVariant !== undefined
							? { variant: ref.perTitleVariant }
							: {}),
						pooled: result.pooled as RenditionPooled["pooled"],
					};
				},
			);
			const verdict = evaluateQcGate(
				gateCtx.gate,
				measurements,
				gateCtx.expected,
				gateCtx.unmeasured ?? [],
			);
			// Status + verdict + denormalized copy land ATOMICALLY: the
			// orchestrator boundary treats FINISHED-without-verdict as
			// fail-closed, so a torn write must be impossible, and the jobs
			// list's qcVerdict must never disagree with the row it mirrors.
			// This is qcVerdict's ONE writer (schema contract); the job row's
			// status stays the orchestrator's.
			await deps.prisma.$transaction([
				deps.prisma.vmafJob.update({
					where: {
						id: vmafJobId,
						...(runningOnly ? { status: "RUNNING" as const } : {}),
					},
					data: {
						status,
						error: error === undefined ? null : redactSecrets(error),
						// status is FINISHED on this whole path.
						...(finalUnits !== undefined ? { doneUnits: finalUnits } : {}),
						gateVerdict: verdict as unknown as Prisma.InputJsonValue,
					},
				}),
				// updateMany, not update (review-201 I3): AWAITING_QC is not an
				// active status, so the parked encoding row is DELETABLE, and
				// VmafJob.encodingJob is SetNull — update would throw P2025 on
				// the missing row and roll the measurement's own FINISHED +
				// verdict back with it. updateMany no-ops on zero rows and the
				// no-torn-write guarantee holds for the rows that exist.
				deps.prisma.encodingJob.updateMany({
					where: { id: gateCtx.encodingJobId },
					data: { qcVerdict: verdict as unknown as Prisma.InputJsonValue },
				}),
			]);
			if (gateCtx.gate.onFail === "MARK_ONLY") {
				// MARK_ONLY has no continuation (nothing is parked) — the runner
				// is the transition, so it also carries the FAIL notification.
				if (!verdict.pass) {
					const failed = verdict.ruleResults.filter((r) => !r.pass).length;
					await deps.emitEvent?.({
						kind: "JOB_QC_FAILED",
						jobId: gateCtx.encodingJobId,
						name: gateCtx.jobName,
						labels: gateCtx.jobLabels,
						reason: `QC gate failed: ${failed} of ${verdict.ruleResults.length} rule(s) below threshold`,
						path: `/vod/jobs/${gateCtx.encodingJobId}`,
					});
				}
			} else {
				// BLOCK_MANIFESTS: wake the parked job. PASS and FAIL both ride
				// the continuation — the orchestrator (single writer of status)
				// decides FINISHED vs QC_FAILED there, and emits on FAIL.
				await enqueueContinuation(gateCtx.encodingJobId, vmafJobId);
			}
		} else {
			await deps.prisma.vmafJob.update({
				where: {
					id: vmafJobId,
					...(runningOnly ? { status: "RUNNING" as const } : {}),
				},
				data: {
					status,
					error: error === undefined ? null : redactSecrets(error),
					...(status === "FINISHED" && finalUnits !== undefined
						? { doneUnits: finalUnits }
						: {}),
				},
			});
			if (gateCtx && gateCtx.gate.onFail === "BLOCK_MANIFESTS") {
				// Measurement ERROR on a blocking gate: the job is parked and
				// must still be woken — the boundary maps a non-FINISHED
				// measurement to QC_FAILED with a "measurement failed" reason
				// (design §6: measurement failed ≠ quality failed).
				await enqueueContinuation(gateCtx.encodingJobId, vmafJobId);
			}
		}
		// : the vmaf terminal choke point (both processors share the
		// shape). Best-effort emitter — cannot fail the run.
		await deps.emitEvent?.(
			status === "FINISHED"
				? {
						kind: "VMAF_FINISHED",
						vmafJobId,
						path: `/qc/${vmafJobId}`,
					}
				: {
						kind: "VMAF_ERROR",
						vmafJobId,
						error: redactSecrets(error ?? "vmaf failed"),
						path: `/qc/${vmafJobId}`,
					},
		);
		return {
			acknowledged: true,
			vmafJobId,
			status,
			results: resultCount,
		};
	}

	/**
	 * Best-effort progress write: a failed update must NEVER fail the run (the
	 * scoring + VmafResult rows are the source of truth). Logs + continues.
	 */
	async function writeProgress(
		vmafJobId: string,
		data: Prisma.VmafJobUpdateInput,
	): Promise<void> {
		try {
			await deps.prisma.vmafJob.update({ where: { id: vmafJobId }, data });
		} catch (err) {
			console.warn(
				`[vmaf] progress update for job ${vmafJobId} failed (ignored):`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	/** Scores ONE rendition; throws on ffmpeg failure (caller fails the job). */
	async function scoreTarget(
		vmafJobId: string,
		model: string,
		// When true, enable libvmaf's psnr feature in the same pass and persist
		// per-frame + pooled PSNR alongside VMAF (P4-PR5).
		wantPsnr: boolean,
		target: QcTarget,
		referencePath: string,
		geometry: Geometry & { frameRate?: string },
		referenceProvenance: DownloadProvenance,
		jobDir: string,
		out: { credential: ResolvedCredential; bucket: string },
		distortedKey: string,
		variant: string | undefined,
		providerResult: PerTitleProviderResult | undefined,
		signal: AbortSignal,
		execution: VmafExecution,
		pairCount: number,
		executionProfile?: VmafCloudProfile,
		measurementMethod?: "FRAME_INDEX_BT709_10BIT",
		referenceCredential?: ResolvedCredential,
	): Promise<void> {
		const slot = (variant ?? "std").replace(/[^A-Za-z0-9._-]/g, "_");
		// The local extension follows the mirror's: a VP9 mirror is a WebM
		// . ffmpeg probes content before trusting a suffix, so
		// this is honesty rather than necessity — but a `.webm` written as
		// `.mp4` on disk is the kind of thing a later reader trusts.
		const ext = target.distorted.path.endsWith(".webm") ? "webm" : "mp4";
		const distortedPath = join(
			jobDir,
			`dist-${target.renditionKey}-${slot}.${ext}`,
		);
		const logPath = join(jobDir, `vmaf-${target.renditionKey}-${slot}.json`);
		const distortedProvenance = await download({
			signal,
			credential: out.credential,
			bucket: out.bucket,
			key: distortedKey,
			destPath: distortedPath,
			label: `distorted qc mirror for rendition ${target.renditionKey}${variant ? ` rung ${variant}` : ""} (output "${target.distorted.outputKey}")`,
		});
		// Per-title rungs carry no plan height/bitrate — probe the downloaded
		// mirror so the quality ladder can place them. Standard renditions keep
		// their plan values, so skip the extra probe there.
		const probed =
			target.height === null || target.bitrate === null
				? await probeDistortedMetrics(deps, distortedPath, signal)
				: undefined;
		// Prefer a bundled model FILE when the image ships one (VMAF v1 models are
		// only reachable this way; the v0.6.1 family resolves either way). Falls
		// back to the built-in `model=version=` when no file is bundled.
		const modelPath = deps.resolveModelPath?.(model);
		let distortedOriginal:
			| { width: number; height: number; bitdepth: number }
			| undefined;
		if (measurementMethod) {
			const probe = await deps.runner.run(
				deps.ffprobePath,
				["-v", "error", "-show_streams", "-of", "json", distortedPath],
				{ signal },
			);
			if (probe.code !== 0)
				throw new Error("Cannot probe existing MP4 geometry");
			const video = JSON.parse(probe.stdout).streams?.find(
				(stream: { codec_type?: string }) => stream.codec_type === "video",
			);
			const depth =
				Number(video?.bits_per_raw_sample) ||
				Number(String(video?.pix_fmt).match(/p(10|12)le$/)?.[1]) ||
				8;
			distortedOriginal = {
				width: video?.width,
				height: video?.height,
				bitdepth: depth,
			};
		}
		try {
			const scoringOptions: VmafCommandOptions = {
				referencePath,
				distortedPath,
				model,
				...(measurementMethod
					? {
							measurementMethod,
							referenceFrameRate: geometry.frameRate,
							distortedOriginal,
						}
					: {}),
				...(modelPath ? { modelPath } : {}),
				logPath,
				// Conform the distorted side to the reference (libvmaf needs an
				// exact W×H + fps match). The mirror is already at the rendition
				// resolution; scaling up to the source is the standard VMAF setup.
				scaleToReference: { width: geometry.width, height: geometry.height },
				...(!measurementMethod && geometry.fps !== undefined
					? { fpsConform: geometry.fps }
					: {}),
				...(deps.threads !== undefined ? { threads: deps.threads } : {}),
				// Cloud receipts require every frame, regardless of local performance tuning.
				...(execution.backend === "CLOUD"
					? { subsample: 1 }
					: deps.subsample !== undefined
						? { subsample: deps.subsample }
						: {}),
				// PSNR rides the same libvmaf invocation (no extra pass / no
				// Bitmovin QC API); off ⇒ the argv is byte-identical to VMAF-only.
				...(wantPsnr ? { psnr: true } : {}),
			};
			let run: { code: number | null; stderr: string };
			if (execution.backend === "CLOUD") {
				if (!deps.cloudScore)
					throw new Error("Cloud VMAF is not configured on this worker");
				const ttl = Math.min(
					604800,
					(executionProfile?.provider === "GCP_BATCH" && executionProfile.spot
						? (executionProfile.spotPolicy?.deadlineSeconds ?? 0)
						: 0) +
						(executionProfile?.timeoutSeconds ?? 86400) +
						(executionProfile?.queueTimeoutSeconds ?? 7200) +
						900,
				);
				const [referenceRemote, distortedRemote] =
					executionProfile?.provider === "GCP_BATCH"
						? await Promise.all([
								referenceCredential
									? signGcsVmafInput(
											referenceCredential,
											referenceProvenance,
											ttl,
										)
									: undefined,
								signGcsVmafInput(out.credential, distortedProvenance, ttl),
							])
						: [];
				await deps.cloudScore({
					...(referenceRemote || distortedRemote
						? {
								remoteInputs: {
									reference: referenceRemote,
									distorted: distortedRemote,
								},
							}
						: {}),
					vmafJobId,
					pairCount,
					targetKey: `${target.renditionKey}/${slot}`,
					profileId: execution.profileId,
					profile: executionProfile,
					budgetUsd: execution.budgetUsd,
					options: scoringOptions,
					signal,
				});
				run = { code: 0, stderr: "" };
			} else {
				run = await deps.runner.run(
					deps.ffmpegPath,
					buildVmafCommand(scoringOptions),
					{ signal },
				);
			}
			if (run.code !== 0) {
				// libvmaf rejects an unresolvable model with a cryptic tail
				// ("Invalid argument") — surface the real cause + the fix instead.
				if (isUnresolvableModel(run.stderr)) {
					throw new Error(unresolvableModelMessage(model, modelPath));
				}
				throw new Error(
					`libvmaf failed for rendition ${target.renditionKey} (code ${run.code}): ${stderrTail(run.stderr)}`,
				);
			}
			const raw = await readFile(logPath, "utf8");
			const parsed = parseVmafJson(JSON.parse(raw));
			if (parsed.frames.length === 0) {
				throw new Error(
					`libvmaf produced no frame scores for rendition ${target.renditionKey}`,
				);
			}
			const pooled = computePooled(parsed.frames);
			// PSNR (when requested + actually present): pool the per-frame psnr_y
			// into mean/min/max and attach it to the result's pooled block. Absent
			// frames (feature off, or a log without psnr_y) ⇒ undefined ⇒ no
			// `pooled.psnr` key, so VMAF-only results are byte-identical to before.
			if (wantPsnr) {
				const psnrValues = parsed.frames
					.map((f) => f.psnr)
					.filter((v): v is number => typeof v === "number");
				const psnrPooled = computePsnrPooled(psnrValues);
				if (psnrPooled) {
					pooled.psnr = psnrPooled;
				}
			}
			// Per-frame array gzipped into framesGzip (now [{frameNum,vmaf,psnr?}]);
			// frames column stays null.
			const framesGzip = gzipSync(Buffer.from(JSON.stringify(parsed.frames)));
			await deps.prisma.vmafResult.create({
				data: {
					vmafJobId,
					renditionRef: renditionRef(
						target,
						variant,
						probed,
					) as Prisma.InputJsonValue,
					pooled: pooled as unknown as Prisma.InputJsonValue,
					framesGzip,
					//  slice 2: WHICH bytes this row compared — both
					// sides' version identity (demanded at read) and digest.
					provenance: {
						reference: referenceProvenance,
						distorted: distortedProvenance,
						...(providerResult !== undefined ? { providerResult } : {}),
					} as unknown as Prisma.InputJsonValue,
				},
			});
		} finally {
			await rm(distortedPath, { force: true }).catch(() => {});
			await rm(logPath, { force: true }).catch(() => {});
		}
	}

	async function run(
		vmafJobId: string,
		signal: AbortSignal,
	): Promise<VmafResult> {
		const row = await deps.prisma.vmafJob.findUnique({
			where: { id: vmafJobId },
			include: {
				encodingJob: {
					select: {
						plan: true,
						status: true,
						// Per-title over-counting scope: createdAt bounds the time window
						// that excludes a prior run's mirrors under the same output base.
						createdAt: true,
						// The captured per-title ladder : the population the
						// runner scores, read from the capture step or the manual capture.
						stepLog: true,
						snapshots: true,
						// Gate emit identity .
						name: true,
						labels: true,
					},
				},
			},
		});
		if (!row) {
			console.warn(`[vmaf] job ${vmafJobId} not found — skipping`);
			return {
				acknowledged: true,
				vmafJobId,
				status: "MISSING",
				results: 0,
			};
		}

		// Gate context : parsed LENIENTLY here because the claim
		// -failed self-heal below needs it on a row the strict path never
		// reaches. The strict parse inside the try still governs scoring.
		const gateCtx = ((): GateContext | undefined => {
			if (
				!row.encodingJob ||
				!row.encodingJobId ||
				row.triggerKey !== autoTriggerKey(row.encodingJobId)
			) {
				return undefined;
			}
			const parsed = encodingPlanSchema.safeParse(row.encodingJob.plan);
			if (!parsed.success || !parsed.data.qc?.gate) {
				return undefined;
			}
			return {
				encodingJobId: row.encodingJobId,
				gate: parsed.data.qc.gate,
				expected: gateExpectedRenditionKeys(parsed.data),
				jobName: row.encodingJob.name,
				jobLabels: row.encodingJob.labels,
			};
		})();

		/**
		 * Everything THIS RUN adds to `VmafJob.params`, accumulated in memory.
		 *
		 * Two writers touch the column during one run — the execution profile records
		 * the subsample stride, the reference probe records the source geometry — and
		 * both used to rebuild the object from the `params` read at job start. The
		 * second therefore reconstructed its own field from a stale `{}` and silently
		 * dropped the first, so every subsampled report looked full-precision: written
		 * then dropped, the same shape as the scoring-generation bug, and invisible
		 * because a test asserting the write's ARGUMENTS passes while the row is being
		 * clobbered two hundred lines later.
		 *
		 * Declared HERE, per run, not in the processor closure. As closure state it was
		 * shared by every job the single `createVmafProcessor` instance handled and
		 * merely re-seeded per run, which was safe only because `vmafRunner` takes
		 * BullMQ's default concurrency of 1 — an invariant living in another file, with
		 * three sibling queues already setting theirs explicitly. Interleaved, job B's
		 * seeding wiped A's stride and A's geometry write then persisted without it,
		 * permanently. Per-run scope removes the invariant instead of documenting it
		 * (review finding). Seeded from the row so a retry keeps what an earlier attempt
		 * recorded.
		 */
		let paramsAcc: Prisma.InputJsonObject =
			typeof row.params === "object" && row.params !== null
				? { ...(row.params as Prisma.InputJsonObject) }
				: {};
		const mergeParams = (
			patch: Prisma.InputJsonObject,
		): Prisma.InputJsonObject => {
			paramsAcc = { ...paramsAcc, ...patch };
			return paramsAcc;
		};
		// Atomic claim PENDING → RUNNING — the transition is the lock (a stale
		// duplicate matches zero rows and skips instead of re-running ffmpeg).
		const { count } = await deps.prisma.vmafJob.updateMany({
			where: { id: vmafJobId, status: "PENDING" },
			data: { status: "RUNNING", error: null },
		});
		if (count === 0) {
			// Claim-failed self-heal : a process death between
			// markTerminal's verdict transaction and the continuation enqueue
			// leaves this vmaf job "active" in BullMQ — the stalled redelivery
			// lands HERE (status already terminal). If the blocking gate's
			// continuation never made it onto the queue, add it now; if it did
			// (completed jobs are retained 1000-deep), the getJob probe finds it
			// and this is a no-op.
			if (
				gateCtx &&
				gateCtx.gate.onFail === "BLOCK_MANIFESTS" &&
				(row.status === "FINISHED" || row.status === "ERROR") &&
				deps.orchestratorQueue
			) {
				const existing = await deps.orchestratorQueue
					.getJob(qcContinuationJobId(gateCtx.encodingJobId, row.id))
					.catch(() => undefined);
				if (existing === null || existing === undefined) {
					await enqueueContinuation(gateCtx.encodingJobId, row.id);
				}
			}
			return {
				acknowledged: true,
				vmafJobId,
				status: row.status,
				results: 0,
			};
		}

		let resultCount = 0;
		let isCloud = false;
		const jobDir = join(deps.workDir, vmafJobId);
		try {
			const execution = vmafExecutionSchema.parse(
				paramsAcc.execution ?? { backend: "LOCAL" },
			);
			isCloud = execution.backend === "CLOUD";
			const executionProfile =
				execution.backend === "CLOUD"
					? paramsAcc.executionProfile
						? vmafCloudProfileSchema.parse(paramsAcc.executionProfile)
						: await deps.resolveCloudProfile?.(execution.profileId)
					: undefined;
			if (executionProfile && execution.backend === "CLOUD") {
				if (executionProfile.id !== execution.profileId)
					throw new Error("VMAF compute profile mismatch");
				await deps.prisma.vmafJob.updateMany({
					where: { id: vmafJobId, status: "RUNNING" },
					data: { params: mergeParams({ executionProfile }) },
				});
			}
			if (!row.encodingJob) {
				throw new Error(
					"VMAF job has no encoding job (the encoding was deleted)",
				);
			}
			const plan = encodingPlanSchema.parse(row.encodingJob.plan);
			const useOutputMp4 = paramsAcc.source === "OUTPUT_MP4";
			if (
				useOutputMp4 &&
				(gateCtx ||
					!row.triggerKey?.startsWith(
						labManualTriggerPrefix(row.encodingJobId ?? ""),
					) ||
					row.encodingJob.status !== "FINISHED")
			)
				throw new Error(
					"Existing MP4 measurements require a manual FINISHED encoding",
				);
			const measurementMethod =
				paramsAcc.measurementMethod === "FRAME_INDEX_BT709_10BIT"
					? paramsAcc.measurementMethod
					: undefined;
			if (measurementMethod && execution.backend !== "CLOUD")
				throw new Error("Frame-index measurement requires cloud validation");
			if (
				measurementMethod &&
				row.scoringVersion !== VMAF_FRAME_INDEX_SCORING_VERSION
			)
				throw new Error(
					"Frame-index measurement generation changed; create a new Lab measurement to retain the original report",
				);
			const nativeFrameIndex =
				measurementMethod &&
				paramsAcc.source === "QC_MIRROR" &&
				row.triggerKey === autoTriggerKey(row.encodingJobId ?? "") &&
				plan.qc?.measurementMethod === measurementMethod &&
				plan.qc.execution?.backend === "CLOUD" &&
				execution.backend === "CLOUD" &&
				plan.qc.execution.profileId === execution.profileId &&
				plan.qc.execution.budgetUsd === execution.budgetUsd;
			if (
				nativeFrameIndex &&
				!["FINISHED", "AWAITING_QC"].includes(row.encodingJob.status)
			)
				throw new Error(
					"Native frame-index measurement requires a completed encoding",
				);
			if (
				measurementMethod &&
				!nativeFrameIndex &&
				(gateCtx ||
					!row.triggerKey?.startsWith(
						labManualTriggerPrefix(row.encodingJobId ?? ""),
					) ||
					row.encodingJob.status !== "FINISHED")
			)
				throw new Error(
					"Frame-index measurements require a manual FINISHED encoding",
				);
			const targets = useOutputMp4
				? enumerateExistingMp4Targets(plan)
				: measurementMethod
					? enumerateFrameIndexQcTargets(plan)
					: enumerateQcTargets(plan);
			if (measurementMethod && targets.length === 0)
				throw new Error(
					"Frame-index measurement requires complete mirrors with a direct full-length source",
				);
			if (useOutputMp4 && targets.length === 0)
				throw new Error("No eligible existing MP4 outputs");
			if (targets.length === 0) {
				// A qc job with no targets means the plan was not qc-enabled (or
				// every rendition's mirror/source was unresolvable) — finishing
				// with zero results is correct, not an error.
				return await markTerminal(
					vmafJobId,
					"FINISHED",
					0,
					undefined,
					undefined,
					gateCtx,
					isCloud,
				);
			}

			await mkdir(jobDir, { recursive: true });

			// Reference download + probe, ONCE per unique source (every rendition
			// of a single-input ladder shares it). Keyed by inputKey+inputPath.
			const refCache = new Map<
				string,
				{
					path: string;
					geometry: Geometry & { frameRate?: string };
					provenance: DownloadProvenance;
					credential: ResolvedCredential;
				}
			>();
			const referenceFor = async (
				target: QcTarget,
			): Promise<{
				path: string;
				geometry: Geometry & { frameRate?: string };
				provenance: DownloadProvenance;
				credential: ResolvedCredential;
			}> => {
				const cacheKey = `${target.reference.inputKey}\0${target.reference.inputPath}`;
				const cached = refCache.get(cacheKey);
				if (cached) {
					return cached;
				}
				const src = await resolveInputSource(
					deps,
					plan,
					target.reference.inputKey,
				);
				const referencePath = join(jobDir, `ref-${refCache.size}.mp4`);
				const referenceProvenance = await download({
					signal,
					credential: src.credential,
					bucket: src.bucket,
					key: target.reference.inputPath,
					destPath: referencePath,
					label: `reference source for rendition ${target.renditionKey} (input "${target.reference.inputKey}")`,
				});
				const probe = await deps.runner.run(
					deps.ffprobePath,
					[
						"-v",
						"error",
						"-print_format",
						"json",
						"-show_streams",
						referencePath,
					],
					{ signal },
				);
				if (probe.code !== 0) {
					throw new Error(
						`ffprobe failed on the reference source (code ${probe.code}): ${stderrTail(probe.stderr)}`,
					);
				}
				const videoStream = JSON.parse(probe.stdout).streams?.find(
					(stream: { codec_type?: string }) => stream.codec_type === "video",
				);
				const geometry = {
					...geometryFromProbe(probe.stdout),
					...(measurementMethod
						? {
								frameRate:
									videoStream?.r_frame_rate || videoStream?.avg_frame_rate,
							}
						: {}),
				};
				const entry = {
					path: referencePath,
					geometry,
					provenance: referenceProvenance,
					credential: src.credential,
				};
				refCache.set(cacheKey, entry);
				// Persist the reference's geometry so the report can state the terms of
				// its own comparison. A VMAF number without the upscale factor beside it
				// is what turned a healthy pipeline into an hours-long investigation:
				// 300 kbps at 360p against a 1080p source scores ~15, correctly. Written
				// into the existing `params` JSON rather than a new column — the probe
				// already happens here, so this costs nothing.
				//
				// Only the FIRST distinct reference writes (the `set` above precedes this
				// guard), which is why the accumulator is sufficient on the per-title and
				// multi-target paths where `referenceFor` runs repeatedly: this write can
				// only ADD to what the run has already recorded, and a second reference
				// never reaches it. Were the guard ever relaxed, merging still keeps the
				// stride — the failure mode would be a later geometry overwriting an
				// earlier one, which is a different question from this one.
				if (refCache.size === 1) {
					await deps.prisma.vmafJob
						.update({
							where: { id: vmafJobId },
							data: {
								params: mergeParams({
									reference: {
										width: geometry.width,
										height: geometry.height,
										...(geometry.fps !== undefined
											? { fps: geometry.fps }
											: {}),
									},
								}),
							},
						})
						// Never fail a scoring run over report metadata.
						.catch((err: unknown) => {
							console.error(
								"[worker:vmaf] could not record reference geometry:",
								err,
							);
						});
				}
				return entry;
			};

			// A manual Lab choice overrides the saved plan; omission inherits it.
			const wantPsnr =
				typeof paramsAcc.psnr === "boolean"
					? paramsAcc.psnr
					: plan.qc?.psnr === true;

			// Over-counting fix (per-title only). PER-TITLE qc mirrors carry a
			// templated `{height}_{bitrate}_{uuid}` path, so they are resolved by
			// listing the bucket — and the placeholder regex would match EVERY run's
			// rungs ever written under that prefix (a re-run, or another job pointed
			// at the same output base, leaves stale mirrors there). Pass this
			// encoding's createdAt as the `modifiedSince` lower bound so a prior
			// run's older mirrors are dropped (a re-run-as-new gets a later
			// createdAt). STANDARD renditions never over-counted: their qc path is
			// LITERAL, so resolveDistortedKeys returns that one key with no listing
			// and the bound is irrelevant — passed only for templated paths.
			// createdAt is stamped at plan-build, BEFORE the encode runs — a
			// deliberately loose floor (always earlier than the mirror writes) so
			// THIS run's rungs are never wrongly dropped; don't tighten it to a
			// nonexistent "startedAt". Residual: an OLDER run still writing to the
			// same base after this floor isn't excluded (time window, not identity).
			const mirrorScopeFloor = row.encodingJob.createdAt.toISOString();

			// Build the full work list (target × resolved mirror key) up front — the
			// per-title placeholder resolution lists the bucket here — then score the
			// flat list with bounded concurrency below.
			type WorkItem = {
				target: QcTarget;
				out: { credential: ResolvedCredential; bucket: string };
				key: string;
				variant: string | undefined;
				providerResult?: PerTitleProviderResult;
			};
			const work: WorkItem[] = [];
			/**
			 *  (paid audit HIGH-10): the per-title population is the
			 * ladder the provider BUILT — the CAPTURE_PER_TITLE_RESULTS snapshot —
			 * not whatever a bucket listing under the template finds in a time
			 * window. A rung with no mirror is recorded here by name and held to
			 * the gate as unmeasured; the listing stays only as the fallback for
			 * encodings that never captured (and says so in `params.perTitle`).
			 */
			const snapshot = capturedPerTitleSnapshot(row.encodingJob);
			if (
				measurementMethod &&
				targets.some((target) => target.distorted.path.includes("{")) &&
				!snapshot
			)
				throw new Error(
					"Frame-index Per-Title measurement requires a captured RESULT population",
				);
			if (
				snapshot &&
				((snapshot.schemaVersion ?? 0) < PER_TITLE_SCHEMA_VERSION ||
					(snapshot.attributionVersion ?? 0) < PER_TITLE_ATTRIBUTION_VERSION)
			) {
				throw new Error(
					`legacy per-title RESULT snapshot version (schema ${snapshot.schemaVersion ?? 0}/${PER_TITLE_SCHEMA_VERSION}, attribution ${snapshot.attributionVersion ?? 0}/${PER_TITLE_ATTRIBUTION_VERSION}) cannot drive a VMAF/QC population`,
				);
			}
			if (
				snapshot &&
				snapshot.scan.resultsCaptured !== snapshot.streams.length
			) {
				throw new Error(
					`inconsistent per-title RESULT snapshot: scan reports ${snapshot.scan.resultsCaptured} captured result(s), but ${snapshot.streams.length} are persisted`,
				);
			}
			const unmeasured: UnmeasuredRung[] = [];
			// Templates the PROVIDER generated no RESULT for (audit
			// 602ec286 §5.4 item 4) — shown for what it is, "not generated", never a
			// synthetic failed measurement. NOT part of `expectedUnits`.
			const notGenerated: { rendition: string }[] = [];
			// RESULT streams a target scored or marked unmeasured, so the sweep below
			// can find any the provider generated that NOTHING placed.
			const coveredStreamIds = new Set<string>();
			let population: "snapshot" | "listing" | "none" = "none";
			for (const target of targets) {
				const isPerTitle = target.distorted.path.includes("{");
				const providerOutputId =
					isPerTitle && snapshot
						? providerOutputIdFromStepLog(
								row.encodingJob.stepLog,
								target.distorted.outputKey,
							)
						: undefined;
				const out = await resolveOutputSource(
					deps,
					plan,
					target.distorted.outputKey,
				);
				if (isPerTitle && snapshot) {
					if (providerOutputId === undefined) {
						throw new Error(
							`Current per-title RESULT snapshot cannot be scored: DONE output:${target.distorted.outputKey} step-log entry carries no unambiguous provider output identity`,
						);
					}
					population = "snapshot";
					const rungs = perTitleRungsFromSnapshot(snapshot, {
						...target,
						providerOutputId,
					});
					for (const rung of rungs) {
						coveredStreamIds.add(rung.streamId);
						if ("missing" in rung) {
							unmeasured.push({
								rendition: target.renditionKey,
								variant: rung.variant,
								reason: rung.reason,
							});
							continue;
						}
						work.push({
							target,
							out,
							key: rung.key,
							variant: rung.variant,
							...(rung.providerResult !== undefined
								? { providerResult: rung.providerResult }
								: {}),
						});
					}
					if (!snapshot.scan.complete) {
						// A truncated provider scan cannot prove that the captured rungs are
						// this template's whole population. Keep the real rungs scoreable, but
						// add one explicit uncertainty unit per target so a partial set can
						// never satisfy a QC gate and release parked manifests.
						unmeasured.push({
							rendition: target.renditionKey,
							variant: "(capture incomplete)",
							reason:
								"the provider RESULT/muxing scan was incomplete, so the captured rungs cannot prove the template's whole population",
						});
					}
					if (
						snapshot.scan.complete &&
						rungs.length === 0 &&
						!snapshot.streams.some(
							(stream) =>
								stream.templateRendition === undefined &&
								(stream.codecType === undefined ||
									stream.codecType ===
										(plan.internal?.hevcV2 && target.codec === "H265"
											? "H265V2"
											: target.codec)),
						)
					) {
						// No RESULT attributed to this template. With explicit-marker / exact
						// fixed-settings attribution (audit 602ec286 §5.4 item 4), that means
						// the PROVIDER generated
						// none for it — per-title templates are not fixed rungs, so the
						// paid run's real ladder was 6 of 7 (`v900` had no RESULT). Shown
						// as "not generated", NOT a synthetic failed measurement, and NOT
						// counted in `expectedUnits`. The whole-population false-green this
						// would otherwise reopen (attribution abstaining on everything →
						// 0 work, 0 unmeasured → FINISHED 0/0) is held by the sweep below:
						// any RESULT the provider DID generate but nothing placed is
						// counted UNMEASURED, so `expectedUnits` stays > 0 and the guard
						// fires ERROR.
						notGenerated.push({ rendition: target.renditionKey });
					}
					continue;
				}
				if (isPerTitle) {
					// Only reached when no snapshot exists for the whole run.
					population = "listing";
				}
				// Per-title mirrors carry {height}_{bitrate}_{uuid} placeholders the
				// runner can't predict — without a captured ladder, resolve to the
				// real key(s) by listing, scoped to this run's time window, then
				// score each rung as its own result. A non-templated (standard) path
				// resolves to itself: one key, no listing, no variant.
				const distorted = await resolveDistortedKeys(
					listKeys,
					out.credential,
					out.bucket,
					target.distorted.path,
					isPerTitle ? mirrorScopeFloor : undefined,
				);
				for (const d of distorted) {
					work.push({ target, out, key: d.key, variant: d.variant });
				}
			}
			// Every RESULT the provider generated stays in the population (audit
			// 602ec286 §5.4 items 4/5). A per-title RESULT that no target scored and
			// no target marked unmeasured is one nothing could place — either
			// attribution abstained (a conflicting/missing stable witness) or it
			// landed on a rendition that is not a VMAF target. Either way it EXISTS,
			// so it is counted UNMEASURED rather than vanishing — which also holds the
			// whole-population line: were attribution to abstain on everything, these
			// keep `expectedUnits > 0` so the 0-result guard fires ERROR instead of a
			// false FINISHED 0/0 (the exact BLOCKER-6 shape, and what the
			// `notGenerated` reclassification above would otherwise reopen).
			if (snapshot && population === "snapshot") {
				for (const stream of snapshot.streams) {
					if (coveredStreamIds.has(stream.streamId)) {
						continue;
					}
					unmeasured.push({
						rendition: stream.templateRendition ?? "(unattributed)",
						variant: stream.streamId,
						reason:
							stream.templateRendition === undefined
								? "this captured RESULT could not be attributed to a template (no unique stable marker or exact copied fixed-settings match) — fail closed, not scored"
								: "this captured RESULT was attributed to a rendition with no VMAF target",
					});
				}
			}
			if (gateCtx) {
				gateCtx.unmeasured = unmeasured.map((u) => ({
					rendition: u.rendition,
					variant: u.variant,
				}));
				// A per-title template the provider generated no RESULT for is not
				// part of THIS run's population (audit 602ec286 §5.4 item 4), so it
				// must not synthesize a failing gate actual — the "synthetic failed
				// rung" the fix forbids. Removing it from the DEFAULT expected set is
				// narrow and snapshot-evidence-based: a standard rendition never
				// enters `notGenerated` (the #40 unmeasured-rendition protection
				// stands), and a rule that NAMES the template still holds it (its
				// `rule.renditions` bypasses `expected`).
				if (notGenerated.length > 0) {
					const gone = new Set(notGenerated.map((n) => n.rendition));
					gateCtx.expected = gateCtx.expected.filter((r) => !gone.has(r));
				}
			}
			if (population !== "none") {
				// Which population this report scored, the rungs it could not, and the
				// templates the provider generated no RESULT for — beside `reference`
				// and `subsample`, report metadata that must never fail the run.
				await deps.prisma.vmafJob
					.update({
						where: { id: vmafJobId },
						data: {
							params: mergeParams({
								perTitle: { population, unmeasured, notGenerated },
							}),
						},
					})
					.catch((err: unknown) => {
						console.error(
							"[worker:vmaf] could not record the per-title population:",
							err,
						);
					});
			}

			// Now the unit count is known (incl. per-title rungs): record the
			// progress baseline + execution profile for the report. Best-effort —
			// a failed progress write must NEVER fail the run.
			//
			// `subsample` goes in too, because it changes what the numbers MEAN and not
			// just how long they take: libvmaf's `n_subsample=N` scores every Nth frame,
			// so the per-frame series is sparser and the `min` can miss the transient
			// worst frame entirely while the pooled mean barely moves. Two reports can
			// therefore both be scoring generation 2 and still not be comparable on
			// their minima, and nothing recorded which side of that a report was on. It
			// rides in the existing `params` JSON beside `reference` (same reason: no new
			// column for report metadata). Local runs omit it when unset or 1; cloud
			// runs explicitly record their enforced full-frame stride.
			// Explicit 1 also replaces stale local-stride metadata carried by retries.
			const subsampling = isCloud
				? 1
				: deps.subsample !== undefined && deps.subsample > 1
					? deps.subsample
					: undefined;
			// Each cloud pair owns a separate resource; local scoring keeps its CPU limit.
			const jobConcurrency = isCloud ? work.length : concurrency;
			await writeProgress(vmafJobId, {
				totalUnits: work.length,
				doneUnits: 0,
				...(isCloud
					? { cores: null, threads: null }
					: {
							...(deps.cores !== undefined ? { cores: deps.cores } : {}),
							...(deps.threads !== undefined ? { threads: deps.threads } : {}),
						}),
				concurrency: jobConcurrency,
				...(isCloud || subsampling !== undefined
					? {
							params: mergeParams({
								...(isCloud
									? { automaticCompute: true, pairCount: work.length }
									: {}),
								...(subsampling !== undefined
									? { subsample: subsampling }
									: {}),
							}),
						}
					: {}),
			});

			// Pre-fetch each unique reference source SEQUENTIALLY (download once;
			// referenceFor caches by inputKey+inputPath), so the concurrent pool
			// below only reads the cache — no double-download or filename race.
			for (const target of targets) {
				await referenceFor(target);
			}

			// Bounded pool: `concurrency` workers pull from a shared index. On the
			// first error, stop pulling and let in-flight runs settle, then rethrow
			// (partial results already persisted stay; markTerminal ERROR follows).
			let next = 0;
			let firstError: unknown;
			const poolWorker = async (): Promise<void> => {
				while (next < work.length && firstError === undefined) {
					const item = work[next] as WorkItem;
					next += 1;
					try {
						const reference = await referenceFor(item.target);
						await scoreTarget(
							vmafJobId,
							row.model,
							wantPsnr,
							item.target,
							reference.path,
							reference.geometry,
							reference.provenance,
							jobDir,
							item.out,
							item.key,
							item.variant,
							item.providerResult,
							signal,
							execution,
							work.length,
							executionProfile,
							measurementMethod,
							reference.credential,
						);
						resultCount += 1;
						// Atomic increment — multiple pool workers bump concurrently, so
						// a read-modify-write would lose updates. Best-effort: a failed
						// progress write must not fail the run (results already persisted).
						await writeProgress(vmafJobId, { doneUnits: { increment: 1 } });
					} catch (err) {
						if (firstError === undefined) {
							firstError = err;
						}
					}
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(jobConcurrency, work.length) }, () =>
					poolWorker(),
				),
			);
			if (firstError !== undefined) {
				throw firstError;
			}

			/**
			 * A run that scored NOTHING is not a finished measurement (paid
			 * re-audit eb7c983 BLOCKER-6).
			 *
			 *  made a rung with no mirror UNMEASURED instead of fatal —
			 * right for the rung, wrong for the job, because nothing then held the
			 * whole-population case. When EVERY rung is unmeasured the pool has no
			 * work, no unit errors, and `markTerminal(FINISHED)` below reported a
			 * green report with `totalUnits 0 / doneUnits 0 / results 0` — the paid
			 * run `d62708cc` exactly (FINISHED, 0/0, results 0, unmeasured 7). A
			 * gate plan would have caught it (every rule fails on an unmeasured
			 * rendition); a plan WITHOUT a gate had no second reader at all, and
			 * `processor.test.ts` pinned that FINISHED as correct.
			 *
			 * So the population is the bar: `work + unmeasured` is what this job was
			 * asked to measure, and scoring none of it ends ERROR — with the count
			 * and every rung's own reason in the message, because "0 results" alone
			 * cannot tell an operator whether the ladder was never captured, the
			 * mirrors were never written, or the capture attributed no rung to the
			 * rendition. No new status: ERROR is the existing terminal for "this
			 * measurement did not happen".
			 */
			const expectedUnits = work.length + unmeasured.length;
			if (expectedUnits > 0 && resultCount === 0) {
				throw new Error(
					`VMAF scored 0 of ${expectedUnits} expected rendition unit(s) — nothing was measured. ${describeUnmeasured(unmeasured)}`,
				);
			}

			/**
			 * PARTIAL: some rungs scored, some could not. FINISHED (the numbers that
			 * exist are real), but the row carries the shortfall in `error` as well
			 * as in `params.perTitle.unmeasured` — a reader looking at a status
			 * column and a result count would otherwise read "7 of 12 rungs" as a
			 * complete ladder. FINISHED-with-error is representable: markTerminal
			 * writes `status` and `error` in the same update on both its branches.
			 */
			const shortfall =
				unmeasured.length > 0
					? `${unmeasured.length} of ${expectedUnits} rung(s) unmeasured — this report is PARTIAL. ${describeUnmeasured(unmeasured)}`
					: undefined;

			return await markTerminal(
				vmafJobId,
				"FINISHED",
				resultCount,
				shortfall,
				work.length,
				gateCtx,
				isCloud,
			);
		} catch (err) {
			if (signal.aborted) throw signal.reason;
			if (
				!(await deps.prisma.vmafJob.findUnique({
					where: { id: vmafJobId },
					select: { id: true },
				}))
			)
				throw new ResetRowDeleted();
			const message = err instanceof Error ? err.message : "vmaf failed";
			// Partial results already persisted stay (real measurements); the job
			// status reflects the failure so the run never reads as complete.
			await markTerminal(
				vmafJobId,
				"ERROR",
				resultCount,
				message,
				undefined,
				gateCtx,
				isCloud,
			);
			throw err;
		} finally {
			// Remove the whole per-job scratch dir (reference + any stragglers).
			await rm(jobDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	return {
		async process(jobData: unknown): Promise<VmafResult> {
			const { vmafJobId } = vmafJobSchema.parse(jobData);
			// Terminal redelivery must enter run's failed-claim self-heal to wake
			// a blocking gate after a crash between ERROR persistence and enqueue.
			// The PENDING claim prevents restarting compute; later liveness checks
			// still abort a cloud run when the operator stops it.
			let initialRead = true;
			try {
				return await whileRowExists(
					async () => {
						const row = await deps.prisma.vmafJob.findUnique({
							where: { id: vmafJobId },
							select: { id: true, status: true, params: true },
						});
						const params = row?.params as {
							execution?: { backend?: string };
						} | null;
						const startup = initialRead;
						initialRead = false;
						if (
							!startup &&
							params?.execution?.backend === "CLOUD" &&
							row?.status === "ERROR"
						)
							throw new CloudVmafStopped("Cloud measurement stopped");
						return Boolean(row);
					},
					(signal) => run(vmafJobId, signal),
				);
			} catch (error) {
				if (error instanceof CloudVmafStopped)
					return { acknowledged: true, vmafJobId, status: "ERROR", results: 0 };
				if (error instanceof ResetRowDeleted)
					return {
						acknowledged: true,
						vmafJobId,
						status: "MISSING",
						results: 0,
					};
				throw error;
			}
		},
	};
}

export type VmafProcessor = ReturnType<typeof createVmafProcessor>;
