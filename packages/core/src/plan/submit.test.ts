import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AUDIO_CODECS, encodingPlanSchema } from "./schema";
import {
	type EncodingJobCreateData,
	type SubmitEncodingJobDeps,
	submitEncodingJob,
} from "./submit";

/**
 *  PR1 — THE cross-pinning test (design §4): the same plan
 * submitted through route-shaped deps and worker-shaped deps must produce
 * BYTE-IDENTICAL create payloads. Everything else pins the pipeline's
 * refusal codes and the enqueue-failure recovery.
 */

const FIXTURE = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
		),
		"utf8",
	),
) as { bitmovin: { accountId?: string } };
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000aa";
const PLAN = {
	...FIXTURE,
	bitmovin: { ...FIXTURE.bitmovin, accountId: ACCOUNT_ID },
};

function makeDeps(over: Partial<SubmitEncodingJobDeps> = {}) {
	const created: EncodingJobCreateData[] = [];
	const enqueued: string[] = [];
	const failed: string[] = [];
	const deps: SubmitEncodingJobDeps = {
		validationOptions: {},
		recordEgress: vi.fn(async () => {}),
		loadAccountDefaults: async () => ({ defaults: {} }),
		createJob: async (data) => {
			created.push(data);
			return { id: `job-${created.length}` };
		},
		enqueue: async (jobId) => {
			enqueued.push(jobId);
		},
		markEnqueueFailed: async (jobId) => {
			failed.push(jobId);
		},
		...over,
	};
	return { deps, created, enqueued, failed };
}

describe("submitEncodingJob", () => {
	it("pins native cloud generation6 in the persisted encoding plan", async () => {
		const t = makeDeps({ cloudVmafProfileAvailable: async () => true });
		const qc = {
			vmaf: true,
			model: "vmaf_v1.0.16_3d0h",
			measurementMethod: "FRAME_INDEX_BT709_10BIT",
			execution: { backend: "CLOUD", profileId: "gcp-auto", budgetUsd: 5 },
		};
		const result = await submitEncodingJob({ ...PLAN, qc }, t.deps);
		expect(result.ok).toBe(true);
		expect(t.created[0]?.plan.qc).toMatchObject(qc);
	});

	it.each([
		"local",
		"trim",
		"no-mirrors",
	])("refuses native generation6 %s before encoding creation", async (scenario) => {
		const t = makeDeps({ cloudVmafProfileAvailable: async () => true });
		const execution =
			scenario === "local"
				? { backend: "LOCAL" }
				: { backend: "CLOUD", profileId: "gcp-auto", budgetUsd: 5 };
		const result = await submitEncodingJob(
			{
				...PLAN,
				...(scenario === "trim"
					? {
							trimmingStreams: [
								{
									key: "trim",
									kind: "TIME_BASED",
									sourceKey: "unused",
									offset: 1,
								},
							],
						}
					: {}),
				qc: {
					vmaf: scenario !== "no-mirrors",
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
					execution,
				},
			},
			t.deps,
		);
		expect(result).toMatchObject({
			ok: false,
			code: "VALIDATION",
			issues: expect.arrayContaining([
				expect.objectContaining({ code: "QC_FRAME_INDEX_SOURCE" }),
			]),
		});
		expect(t.created).toEqual([]);
		expect(t.enqueued).toEqual([]);
	});

	it.each([
		["missing resolver", undefined, "QC_CLOUD_UNAVAILABLE"],
		[
			"unknown or disabled profile",
			async (): Promise<boolean> => false,
			"QC_CLOUD_PROFILE_INVALID",
		],
		[
			"lookup failure",
			async (): Promise<boolean> => {
				throw new Error("secret database detail");
			},
			"QC_CLOUD_UNAVAILABLE",
		],
	] as const)("refuses cloud submission for %s before create/enqueue", async (_name, cloudVmafProfileAvailable, code) => {
		const t = makeDeps({ cloudVmafProfileAvailable });
		const outcome = await submitEncodingJob(
			{
				...PLAN,
				qc: {
					vmaf: true,
					execution: { backend: "CLOUD", profileId: "gcp-auto", budgetUsd: 5 },
				},
			},
			t.deps,
		);
		expect(outcome).toMatchObject({ ok: false, code });
		expect(JSON.stringify(outcome)).not.toContain("secret database detail");
		expect(t.created).toEqual([]);
		expect(t.enqueued).toEqual([]);
		expect(t.deps.recordEgress).not.toHaveBeenCalled();
	});

	it("preserves cloud selection through submission when the profile is enabled", async () => {
		const available = vi.fn(async () => true);
		const t = makeDeps({ cloudVmafProfileAvailable: available });
		const execution = { backend: "CLOUD", profileId: "gcp-auto", budgetUsd: 5 };
		const outcome = await submitEncodingJob(
			{ ...PLAN, qc: { vmaf: true, execution } },
			t.deps,
		);
		expect(outcome.ok).toBe(true);
		expect(available).toHaveBeenCalledWith("gcp-auto");
		expect(t.created[0]?.plan.qc?.execution).toEqual(execution);
	});

	it.each([
		undefined,
		{ backend: "LOCAL" },
	])("local/legacy submission skips cloud lookup (%s)", async (execution) => {
		const available = vi.fn(async () => {
			throw new Error("must not read cloud");
		});
		const t = makeDeps({ cloudVmafProfileAvailable: available });
		const outcome = await submitEncodingJob(
			{ ...PLAN, qc: { vmaf: true, ...(execution ? { execution } : {}) } },
			t.deps,
		);
		expect(outcome.ok).toBe(true);
		expect(available).not.toHaveBeenCalled();
		expect(t.created).toHaveLength(1);
	});

	it.each([
		true,
		false,
	])("HLS cross-manifest collision=%s is checked before job creation", async (collision) => {
		const plan = encodingPlanSchema.parse(PLAN);
		const hls = plan.manifests.find((m) => m.kind === "HLS");
		if (!hls) throw new Error("HLS fixture required");
		plan.manifests.push({
			...hls,
			key: "second-hls",
			manifestName: "second.m3u8",
			destination: {
				...hls.destination,
				path: collision ? hls.destination.path : "separate-hls/",
			},
		});
		const { deps, created, enqueued } = makeDeps();
		const result = await submitEncodingJob(plan, deps);
		if (collision) {
			expect(result).toMatchObject({
				ok: false,
				code: "VALIDATION",
				issues: expect.arrayContaining([
					expect.objectContaining({ code: "PLAN_HLS_MEDIA_URI_COLLISION" }),
				]),
			});
			expect(deps.recordEgress).not.toHaveBeenCalled();
		} else {
			expect(result.ok).toBe(true);
		}
		expect(created).toHaveLength(collision ? 0 : 1);
		expect(enqueued).toHaveLength(collision ? 0 : 1);
	});
	it("refuses unselected DASH audio before creating or enqueuing a job", async () => {
		const plan = encodingPlanSchema.parse(PLAN);
		const audioKeys = new Set(
			plan.renditions
				.filter((r) => AUDIO_CODECS.has(r.codec))
				.map((r) => r.key),
		);
		plan.manifests = plan.manifests.filter((m) => m.kind === "DASH");
		plan.muxings = plan.muxings.filter((m) => !audioKeys.has(m.streamKey));
		const { deps, created, enqueued } = makeDeps();
		const result = await submitEncodingJob(plan, deps);
		expect(result).toMatchObject({
			ok: false,
			code: "VALIDATION",
			issues: expect.arrayContaining([
				expect.objectContaining({ code: "PLAN_DASH_AUDIO_UNSELECTED" }),
			]),
		});
		expect(created).toEqual([]);
		expect(enqueued).toEqual([]);
	});
	it("CROSS-PIN: route-shaped and worker-shaped deps produce identical rows", async () => {
		// Two independent dep sets — nothing shared but the plan. If the
		// pipeline consulted anything ambient, the payloads would diverge.
		const route = makeDeps();
		const worker = makeDeps();
		const first = await submitEncodingJob(PLAN, route.deps);
		const second = await submitEncodingJob(PLAN, worker.deps);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(route.created).toHaveLength(1);
		expect(worker.created).toHaveLength(1);
		// Deep-equal INCLUDING the compiled step log — the orchestrator
		// replays this; divergence here is two different encodings.
		expect(route.created[0]).toEqual(worker.created[0]);
		expect(route.created[0]?.status).toBe("QUEUED");
		expect(route.created[0]?.totalSteps).toBeGreaterThan(5);
		expect(route.created[0]?.doneSteps).toBe(0);
	});

	it("stamps template provenance when passed, nulls when not (ledger #109)", async () => {
		const withProv = makeDeps({
			provenance: {
				presetId: "11111111-2222-4333-8444-555555555555",
				presetRevision: 3,
			},
		});
		const without = makeDeps();
		await submitEncodingJob(PLAN, withProv.deps);
		await submitEncodingJob(PLAN, without.deps);
		expect(withProv.created[0]?.presetId).toBe(
			"11111111-2222-4333-8444-555555555555",
		);
		expect(withProv.created[0]?.presetRevision).toBe(3);
		// Explicit nulls, not absent keys — the create payload is pinned and a
		// Prisma create with an absent column is the same write, but the pin
		// keeps every caller honest about the full shape.
		expect(without.created[0]?.presetId).toBeNull();
		expect(without.created[0]?.presetRevision).toBeNull();
	});

	it("enqueues under the created row id (BullMQ dedup contract)", async () => {
		const { deps, enqueued } = makeDeps();
		const outcome = await submitEncodingJob(PLAN, deps);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(enqueued).toEqual([outcome.id]);
		}
	});

	it("refuses garbage with PARSE before any IO", async () => {
		const { deps, created } = makeDeps();
		const outcome = await submitEncodingJob({ nope: 1 }, deps);
		expect(outcome).toMatchObject({ ok: false, code: "PARSE" });
		expect(created).toHaveLength(0);
		expect(deps.recordEgress).not.toHaveBeenCalled();
	});

	it("refuses a plan without an account id BEFORE the egress record (route order)", async () => {
		const { deps, created } = makeDeps();
		const outcome = await submitEncodingJob(FIXTURE, deps);
		expect(outcome).toMatchObject({ ok: false, code: "NO_ACCOUNT_ID" });
		expect(deps.recordEgress).not.toHaveBeenCalled();
		expect(created).toHaveLength(0);
	});

	it("refuses a missing account BEFORE validation and egress — the defaults must exist to be validated (ledger #139(e))", async () => {
		// This test used to pin the OPPOSITE order (egress filed first).
		// #139(e) inverted it: account defaults are injected BEFORE
		// validation so the injected values are validated, which requires
		// the account load up front — and an egress record for a submission
		// that named no real account would have audited a plan that could
		// never be submitted in that shape.
		const { deps, created } = makeDeps({
			loadAccountDefaults: async () => null,
		});
		const outcome = await submitEncodingJob(PLAN, deps);
		expect(outcome).toMatchObject({ ok: false, code: "ACCOUNT_MISSING" });
		expect(deps.recordEgress).not.toHaveBeenCalled();
		expect(created).toHaveLength(0);
	});

	it("an enqueue failure marks the row failed THEN rethrows (retry-recoverable)", async () => {
		const { deps, failed } = makeDeps({
			enqueue: async () => {
				throw new Error("redis gone");
			},
		});
		await expect(submitEncodingJob(PLAN, deps)).rejects.toThrow("redis gone");
		expect(failed).toEqual(["job-1"]);
	});

	it("injects account defaults into the PERSISTED plan (replay carries them)", async () => {
		const { deps, created } = makeDeps({
			loadAccountDefaults: async () => ({
				defaults: { fallbackRegions: ["AWS_EU_WEST_1"] },
			}),
		});
		await submitEncodingJob(PLAN, deps);
		expect(created[0]?.plan.bitmovin.fallbackCloudRegions).toEqual([
			"AWS_EU_WEST_1",
		]);
	});
});
