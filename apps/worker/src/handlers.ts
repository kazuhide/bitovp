import type { QueueKey } from "@bitovp/core";
import { DelayedError, type Job } from "bullmq";
import type { LiveChannelResult } from "./orchestrator/live-processor";
import { ATTEMPT_LEASE_MS } from "./orchestrator/processor";

export type HandlerResult =
	| {
			acknowledged: true;
			queue: QueueKey;
	  }
	| LiveChannelResult;

type Handler = (job: Job) => Promise<HandlerResult>;

/** Repeatable job name on the live-channel queue (no per-channel payload). */
export const HEARTBEAT_SWEEP_JOB = "heartbeat-sweep";

export type HandlerDeps = {
	usageStatistics(job: Job): Promise<unknown>;
	/** Runs one orchestrator job to completion (resume-aware). */
	orchestrate(jobData: unknown): Promise<{ status: string }>;
	/** Provision/action dispatcher for one live channel. */
	liveChannel(jobData: unknown): Promise<LiveChannelResult>;
	/** Polls heartbeats for every RUNNING channel (repeatable job). */
	liveHeartbeatSweep(): Promise<unknown>;
	/**
	 * Feeder session dispatcher (P3-PR3). "start" jobs stay active for the
	 * whole push — the feeder queue runs with concurrency > 1 so "stop"
	 * jobs can reach the in-process supervisor registry meanwhile.
	 */
	feeder(jobData: unknown): Promise<unknown>;
	/** VOD VMAF runner (P4-PR3): scores one VmafJob's qc mirrors. */
	vmaf(jobData: unknown): Promise<unknown>;
	/** Storage inspection (P5): bounded ffprobe over one customer object. */
	storageInspect(jobData: unknown): Promise<unknown>;
	/** Outbound notification delivery : one event, fan-out. */
	notify(jobData: unknown): Promise<unknown>;
	startupProbe: (data: unknown) => Promise<unknown>;
	/**
	 * Slate normalization : the whole job, because the queue carries
	 * two names — one row's preparation, and the repeatable promoter.
	 */
	slateNormalize(job: Job): Promise<unknown>;
};

export function createHandlers(deps: HandlerDeps): Record<QueueKey, Handler> {
	return {
		usageStatistics: async (job: Job) => {
			await deps.usageStatistics(job);
			return { acknowledged: true, queue: "usageStatistics" };
		},
		orchestrator: async (job: Job) => {
			const result = await deps.orchestrate(job.data);
			if (result.status === "LEASE_HELD") {
				// A restarted worker can receive this job before the previous
				// attempt's DB lease expires. Acknowledging would lose its only
				// wake-up. Retain the same queue job without a failed attempt;
				// the margin covers the strict lease-expiry comparison.
				await job.moveToDelayed(
					Date.now() + ATTEMPT_LEASE_MS + 1000,
					job.token,
				);
				throw new DelayedError();
			}
			return { acknowledged: true, queue: "orchestrator" };
		},
		notify: async (job: Job) => {
			await deps.notify(job.data);
			return { acknowledged: true, queue: "notify" };
		},
		liveChannel: async (job: Job) => {
			if (job.name === HEARTBEAT_SWEEP_JOB) {
				await deps.liveHeartbeatSweep();
				return { acknowledged: true, queue: "liveChannel" };
			}
			return deps.liveChannel(job.data);
		},
		storageInspect: async (job: Job) => {
			await deps.storageInspect(job.data);
			return { acknowledged: true, queue: "storageInspect" };
		},
		slateNormalize: async (job: Job) => {
			await deps.slateNormalize(job);
			return { acknowledged: true, queue: "slateNormalize" };
		},
		vmafRunner: async (job: Job) => {
			await deps.vmaf(job.data);
			return { acknowledged: true, queue: "vmafRunner" };
		},
		feederManager: async (job: Job) => {
			await deps.feeder(job.data);
			return { acknowledged: true, queue: "feederManager" };
		},
		startupProbe: async (job: Job) => {
			await deps.startupProbe(job.data);
			return { acknowledged: true, queue: "startupProbe" };
		},
	};
}
