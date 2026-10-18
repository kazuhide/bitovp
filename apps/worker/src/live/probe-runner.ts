import { createHash } from "node:crypto";
import {
	buildProbePlan,
	compileLiveChannel,
	initStepLog,
	PROBE_STOP_WAIT_MINUTES,
	probeBatchJobSchema,
	probeOutputPrefix,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import {
	assertSafeProbePrefix,
	type BrowserCredential,
	probeReaperForCredential,
	storageErrorText,
} from "@bitovp/storage";
import { createRunMirror } from "../orchestrator/run-mirror";

/**
 * Startup-probe batch runner .
 *
 * A probe rides the NORMAL live pipeline — the same channel row, provision
 * queue, worker, step log and finalize sampler as an operator's channel
 * (purpose PROBE flips the sample's source) — and this runner only
 * orchestrates around it: create → await RUNNING or the abandon deadline →
 * stop → reap the designated output subtree.
 *
 * SERIAL by design: parallel probes would measure queue contention we
 * caused ourselves. RESUMABLE by construction: each probe is a channel row
 * named after the batch, so a redelivered job skips the ones that already
 * finished (the stall-policy argument for this queue).
 *
 * Billing controls, layered : the PLAN's waiting-for-first-connect
 * auto-shutdown (encoder-side fuse — a probe never connects an input; set to
 * 30 min, the smallest value Bitmovin was observed to accept — 1 draws a
 * code-1000 start rejection, ), the runner's ABANDON DEADLINE (a
 * probe not RUNNING in time records CENSORED and stops waiting), and the
 * sweep-side `reconcileAbandonedProbes` (a dead runner's RUNNING probe is
 * stopped by the next tick — an in-process finally does not survive SIGKILL,
 * the design's own realized-leak citation). The encoder-side fuse is the
 * coarsest but the ONLY one that covers an encoder up cloud-side before our DB
 * ever records RUNNING.
 */

export const PROBE_SETTING_KEY = "live:startup-probe";
export const PROBE_STREAM_KEY = "probelaunch";
/** Cap mirrored from the design: abandon deadline ≤ 15 minutes. */
export const PROBE_MAX_ABANDON_MINUTES = 15;
const STOP_WAIT_MS = PROBE_STOP_WAIT_MINUTES * 60_000;

export type ProbeDesignationSetting = {
	credentialId: string;
	bucket: string;
	prefix: string;
	bitmovinAccountId: string;
	abandonDeadlineMinutes: number;
};

export async function loadProbeDesignation(
	prisma: AppPrismaClient,
): Promise<ProbeDesignationSetting | null> {
	const row = await prisma.appSetting.findUnique({
		where: { key: PROBE_SETTING_KEY },
	});
	if (!row) {
		return null;
	}
	const value = row.value as Partial<ProbeDesignationSetting>;
	if (
		typeof value.credentialId !== "string" ||
		typeof value.bucket !== "string" ||
		typeof value.prefix !== "string" ||
		typeof value.bitmovinAccountId !== "string" ||
		// review-287 n3: presence AND non-empty — the PUT enforces uuid, but
		// an empty string would otherwise pass typeof and land a plan with an
		// empty accountId that fails deeper. Deliberate, not incidental.
		value.bitmovinAccountId.length === 0
	) {
		return null;
	}
	return {
		credentialId: value.credentialId,
		bucket: value.bucket,
		prefix: value.prefix,
		bitmovinAccountId: value.bitmovinAccountId,
		abandonDeadlineMinutes: Math.min(
			PROBE_MAX_ABANDON_MINUTES,
			typeof value.abandonDeadlineMinutes === "number"
				? value.abandonDeadlineMinutes
				: 8,
		),
	};
}

export type ProbeRunnerDeps = {
	prisma: AppPrismaClient;
	/** Enqueue onto the live-channel queue (provision / stop actions). */
	enqueueLiveJob: (
		job: { liveChannelId: string; action: string },
		dedupeId: string,
	) => Promise<void>;
	resolveCredential: (credentialId: string) => Promise<{
		provider: string;
		config: Record<string, unknown>;
		secret: Record<string, string>;
	}>;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
	pollIntervalMs?: number;
};

/**
 * review-pr34 m5: the probe channel id is a FUNCTION of (requestId, region,
 * n) — a redelivered batch job lands on the SAME rows and the SAME output
 * prefixes even if the name-based resume lookup ever drifts, and a
 * half-crashed batch can never strand a subtree under an id nobody can
 * rederive. SHA-256 folded into RFC-4122 shape (the column is @db.Uuid).
 */
export function deterministicProbeId(
	requestId: string,
	region: string,
	n: number,
): string {
	const digest = createHash("sha256")
		.update(`bitovp-probe|${requestId}|${region}|${n}`)
		.digest();
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	const hex = digest.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type ProbeOutcome = {
	region: string;
	channelId: string;
	outcome: "RUNNING" | "FAILED" | "CENSORED" | "SKIPPED";
	cleanupError?: string;
};

export function createProbeBatchProcessor(deps: ProbeRunnerDeps) {
	const now = deps.now ?? (() => new Date());
	const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const pollMs = deps.pollIntervalMs ?? 5_000;
	const runs = createRunMirror(deps.prisma);

	async function latestRunId(channelId: string): Promise<string | null> {
		const run = await deps.prisma.liveChannelRun.findFirst({
			where: { liveChannelId: channelId },
			orderBy: { seq: "desc" },
			select: { id: true },
		});
		return run?.id ?? null;
	}

	/**
	 * review-pr34 m2: a probe that dies BEFORE provision creates a run row
	 * used to leave no evidence at all — the batch "finished" and the
	 * region's history had a silent hole. With no run to key the unique
	 * upsert, the dedupe key is a failedPhase marker carrying the channel id
	 * (deterministic per probe, m5), so redeliveries converge on one row.
	 */
	async function recordNoRunCensored(
		channelId: string,
		region: string,
		cleanupError?: string,
	): Promise<void> {
		const marker = `no-run:${channelId}`;
		const existing = await deps.prisma.startupSample.findFirst({
			where: { failedPhase: marker },
			select: { id: true },
		});
		if (existing) {
			return;
		}
		await deps.prisma.startupSample.create({
			data: {
				cloudRegion: region,
				source: "PROBE",
				outcome: "CENSORED",
				failedPhase: marker,
				...(cleanupError ? { cleanupError } : {}),
			},
		});
	}

	async function recordCensored(
		channelId: string,
		region: string,
	): Promise<void> {
		const runId = await latestRunId(channelId);
		if (!runId) {
			await recordNoRunCensored(channelId, region);
			return;
		}
		const existing = await deps.prisma.startupSample.findUnique({
			where: { liveChannelRunId: runId },
			select: { id: true },
		});
		if (existing) {
			return;
		}
		await deps.prisma.startupSample.create({
			data: {
				cloudRegion: region,
				source: "PROBE",
				outcome: "CENSORED",
				liveChannelRunId: runId,
			},
		});
	}

	async function recordCleanupError(
		channelId: string,
		region: string,
		message: string,
	): Promise<void> {
		const runId = await latestRunId(channelId);
		if (!runId) {
			await recordNoRunCensored(channelId, region, message);
			return;
		}
		const existing = await deps.prisma.startupSample.findUnique({
			where: { liveChannelRunId: runId },
			select: { id: true },
		});
		if (existing) {
			await deps.prisma.startupSample.update({
				where: { liveChannelRunId: runId },
				data: { cleanupError: message },
			});
			return;
		}
		await deps.prisma.startupSample.create({
			data: {
				cloudRegion: region,
				source: "PROBE",
				outcome: "CENSORED",
				cleanupError: message,
				liveChannelRunId: runId,
			},
		});
	}

	async function reap(
		channelId: string,
		region: string,
		designation: ProbeDesignationSetting,
	): Promise<string | undefined> {
		try {
			const prefix = probeOutputPrefix(designation, channelId);
			// Control 3 sits IN FRONT of every deletion — a derivation bug in
			// probeOutputPrefix dies here, not in the bucket.
			assertSafeProbePrefix(prefix, designation.prefix);
			const credential = await deps.resolveCredential(designation.credentialId);
			// The worker's resolver types provider as string; the reaper's
			// switch narrows and refuses unknown providers loudly.
			const reaper = probeReaperForCredential(credential as BrowserCredential);
			const { deleted } = await reaper.deleteObjectsUnderPrefix({
				bucket: designation.bucket,
				prefix,
			});
			// review-161-162 M8: the count finally has a production reader.
			console.log(`[probe] reaped ${deleted} objects under ${prefix}`);
			return undefined;
		} catch (err) {
			// C20 (review-161-162 B2): cleanupError is a persisted column — the
			// sanitized class goes there; the raw text goes to the worker log.
			console.error(`[probe] cleanup failed for ${channelId}:`, err);
			const message = storageErrorText(err);
			await recordCleanupError(channelId, region, message).catch(() => {});
			return message;
		}
	}

	async function stopProbe(channelId: string): Promise<void> {
		const { count } = await deps.prisma.liveChannel.updateMany({
			where: { id: channelId, status: "RUNNING" },
			data: { status: "STOPPING" },
		});
		if (count === 1) {
			await runs.mirror(channelId, { status: "STOPPING" }).catch(() => {});
			await deps.enqueueLiveJob(
				{ liveChannelId: channelId, action: "stop" },
				`probe-stop-${channelId}`,
			);
		}
	}

	async function runOneProbe(
		region: string,
		name: string,
		probeId: string,
		designation: ProbeDesignationSetting,
	): Promise<ProbeOutcome> {
		const existing = await deps.prisma.liveChannel.findFirst({
			where: { name, purpose: "PROBE" },
			select: { id: true, status: true },
		});
		let channelId: string;
		if (existing) {
			if (existing.status === "STOPPED" || existing.status === "ERROR") {
				// Resume: this probe already ran to a terminal state.
				return { region, channelId: existing.id, outcome: "SKIPPED" };
			}
			channelId = existing.id;
			if (existing.status === "CREATED") {
				// A crash BETWEEN create and enqueue leaves a CREATED row no
				// job will ever drive — the old resume polled it into a false
				// CENSORED. Same dedupe id: if the original enqueue DID land,
				// this is a no-op; if provision already ran, it is resumable
				// by step log (the orchestrator's own contract).
				await deps.enqueueLiveJob(
					{ liveChannelId: channelId, action: "provision" },
					`probe-${channelId}`,
				);
			}
		} else {
			channelId = probeId;
			const plan = buildProbePlan({
				name,
				cloudRegion: region,
				designation,
				probeId: channelId,
				streamKey: PROBE_STREAM_KEY,
			});
			await deps.prisma.liveChannel.create({
				data: {
					id: channelId,
					name,
					purpose: "PROBE",
					status: "CREATED",
					// review-287 m1: set the column too, symmetric with the
					// operator route — a probe should not be the one channel
					// that sits CREATED/ERROR with a plan account but a null
					// column (a null account would then ride its startup sample
					// and its DELETE audit row).
					bitmovinAccountId: designation.bitmovinAccountId,
					//  §5: infra, not a human — the batch runner is the
					// creator.
					createdBy: "worker:startup-probe",
					// review-pr34 M2: ride the EXISTING enforceCaps sweep too —
					// a probe that somehow keeps RUNNING past the deadline plus
					// the stop-wait tail gets the scheduler's once-per-run stop,
					// independent of this runner, the fuses, and the reconciler.
					maxRunMinutes:
						designation.abandonDeadlineMinutes + PROBE_STOP_WAIT_MINUTES,
					plan: plan as unknown as Prisma.InputJsonValue,
					stepLog: initStepLog(
						compileLiveChannel(plan),
					) as unknown as Prisma.InputJsonValue,
				},
			});
			await deps.enqueueLiveJob(
				{ liveChannelId: channelId, action: "provision" },
				`probe-${channelId}`,
			);
		}

		const deadlineMs =
			now().getTime() + designation.abandonDeadlineMinutes * 60_000;
		for (;;) {
			const row = await deps.prisma.liveChannel.findUnique({
				where: { id: channelId },
				select: { status: true },
			});
			if (!row) {
				return { region, channelId, outcome: "FAILED" };
			}
			if (row.status === "RUNNING" || row.status === "STOPPING") {
				// review-pr34 m6: STOPPING is the resume shape after a crash
				// between the stop claim and the terminal state — the probe
				// demonstrably REACHED RUNNING (the claim only fires from
				// RUNNING), so it must land as a RUNNING outcome with its
				// reap, never ride the deadline into a false CENSORED.
				if (row.status === "RUNNING") {
					await stopProbe(channelId);
				}
				// Wait (bounded) for the stop to confirm; the sample landed at
				// finalize either way, and #130 C1's retry-stop exit is the
				// escape if confirmation never comes.
				const stopDeadline = now().getTime() + STOP_WAIT_MS;
				while (now().getTime() < stopDeadline) {
					const after = await deps.prisma.liveChannel.findUnique({
						where: { id: channelId },
						select: { status: true },
					});
					if (after?.status === "STOPPED" || after?.status === "ERROR") {
						break;
					}
					await sleep(pollMs);
				}
				const cleanupError = await reap(channelId, region, designation);
				return { region, channelId, outcome: "RUNNING", cleanupError };
			}
			if (row.status === "ERROR" || row.status === "STOPPED") {
				// The failure writers (source PROBE) already recorded it; a
				// reconciler- or operator-driven stop can also land STOPPED
				// before we ever saw RUNNING. (The encoder-side fuse no longer
				// fires inside this window — it is 30 min, past the runner's
				// PROBE_MAX_ABANDON_MINUTES deadline; , review-288 N3.)
				const cleanupError = await reap(channelId, region, designation);
				return { region, channelId, outcome: "FAILED", cleanupError };
			}
			if (now().getTime() > deadlineMs) {
				await recordCensored(channelId, region).catch(() => {});
				// Do NOT fight the in-flight provision: if it reaches RUNNING
				// later, the finalize sampler upserts the REAL tail measurement
				// over this CENSORED row — exactly the OneFootball case — and
				// the reconciler/fuse stop the encoder. Best-effort cleanup of
				// whatever landed so far, noted on the sample.
				const cleanupError = await reap(channelId, region, designation);
				return { region, channelId, outcome: "CENSORED", cleanupError };
			}
			await sleep(pollMs);
		}
	}

	return async function processProbeBatch(data: unknown) {
		const batch = probeBatchJobSchema.parse(data);
		const designation = await loadProbeDesignation(deps.prisma);
		if (!designation) {
			throw new Error(
				"startup probes need a COMPLETE designated destination (credential + Bitmovin account + bucket + prefix; Settings → Live → Startup profiles) before a batch can run",
			);
		}
		const outcomes: ProbeOutcome[] = [];
		for (const region of batch.regions) {
			for (let n = 1; n <= batch.perRegion; n += 1) {
				const name = `probe-${batch.requestId.slice(0, 8)}-${region}-${n}`;
				outcomes.push(
					await runOneProbe(
						region,
						name,
						deterministicProbeId(batch.requestId, region, n),
						designation,
					),
				);
			}
		}
		return { acknowledged: true, outcomes };
	};
}

/**
 * The out-of-process teardown (design §4): a RUNNING probe with nobody
 * driving it is a billing leak — the runner stops probes it watches, but a
 * SIGKILLed runner watches nothing. Every sweep tick, stop RUNNING probes
 * older than the fuse-plus-slack window. Best-effort by contract.
 */
export async function reconcileAbandonedProbes(
	prisma: AppPrismaClient,
	enqueueLiveJob: ProbeRunnerDeps["enqueueLiveJob"],
	now: Date,
	olderThanMinutes = 3,
): Promise<number> {
	const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
	const stuck = await prisma.liveChannel.findMany({
		where: {
			purpose: "PROBE",
			status: "RUNNING",
			// review-pr34 B2: NOT updatedAt — the heartbeat sweep polls every
			// RUNNING channel (probes included) and bumps updatedAt every 30s,
			// so an updatedAt cutoff NEVER fires: the out-of-process teardown
			// was dead code while the ledger row claimed it worked.
			// runningSince is an EVENT time (the enforceCaps anchor) — it is
			// stamped once at RUNNING and never refreshed by observers.
			runningSince: { not: null, lt: cutoff },
		},
		select: { id: true },
		take: 20,
	});
	// review-pr34 Q3: a heartbeat error path can move a probe RUNNING→ERROR
	// with nobody enqueuing a stop — the encoder keeps its pointer and only
	// the plan fuses cover it. ERROR rows are OUTSIDE the heartbeat sweep's
	// population (it polls RUNNING only), so updatedAt is a valid anchor
	// here, unlike the RUNNING arm above.
	const errored = await prisma.liveChannel.findMany({
		where: {
			purpose: "PROBE",
			status: "ERROR",
			bitmovinEncodingId: { not: null },
			updatedAt: { lt: cutoff },
		},
		select: { id: true },
		take: 20,
	});
	let stopped = 0;
	const runs = createRunMirror(prisma);
	for (const probe of [
		...stuck.map((row) => ({ id: row.id, from: "RUNNING" as const })),
		...errored.map((row) => ({ id: row.id, from: "ERROR" as const })),
	]) {
		const { count } = await prisma.liveChannel.updateMany({
			where: { id: probe.id, status: probe.from },
			data: { status: "STOPPING" },
		});
		if (count === 1) {
			await runs.mirror(probe.id, { status: "STOPPING" }).catch(() => {});
			await enqueueLiveJob(
				{ liveChannelId: probe.id, action: "stop" },
				`probe-reconcile-stop-${probe.id}`,
			);
			stopped += 1;
		}
	}
	return stopped;
}
