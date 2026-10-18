import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EncodingPlan, VmafCloudProfile } from "@bitovp/core";
import { VMAF_SCORING_VERSION } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { TENANT_ORGANIZATION } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { createVmafTrigger, type VmafQueueLike } from "./trigger";

const ENCODING_JOB_ID = "00000000-0000-4000-8000-0000000000e1";
const CLOUD_PROFILE: VmafCloudProfile = {
	id: "gcp-auto",
	label: "GCP automatic",
	provider: "GCP_BATCH",
	image: `registry.example/vmaf@sha256:${"a".repeat(64)}`,
	region: "us-central1",
	cpu: 8,
	memoryMiB: 32768,
	diskGiB: 100,
	maxParallel: 2,
	timeoutSeconds: 1800,
	queueTimeoutSeconds: 600,
	maxCostUsdPerHour: 2,
	transferUsdPerGiB: 0,
	overheadUsd: 0,
	maxStagingGiB: 100,
	staging: { provider: "GCS", bucket: "vmaf-staging" },
	project: "test-project",
	machineType: "n2-standard-8",
	serviceAccount: "vmaf@example.com",
	spot: true,
	profileVersion: 3,
};
const CLOUD_EXECUTION = {
	backend: "CLOUD",
	profileId: CLOUD_PROFILE.id,
	budgetUsd: 5,
} as const;
const NEW_VMAF_ID = "00000000-0000-4000-8000-0000000000a9";

/** Minimal plan stub — the trigger only reads plan.qc. */
function plan(qc: EncodingPlan["qc"]): EncodingPlan {
	return { qc } as EncodingPlan;
}

function setup(
	opts: {
		existing?: { id: string; status: string } | null;
		createError?: unknown;
		qcVmafEnabled?: boolean;
		cloudProfile?: VmafCloudProfile | null;
		profileError?: unknown;
	} = {},
) {
	const created: Record<string, unknown>[] = [];
	const prisma = {
		// : the trigger reads the flag AT FIRE TIME. The harness
		// default is ON, so every pre-existing case keeps testing what it was
		// written for; the off-case below overrides it.
		vmafExecutionProfile: {
			findMany: vi.fn(async () => {
				if (opts.profileError) throw opts.profileError;
				return opts.cloudProfile
					? [
							{
								id: opts.cloudProfile.id,
								label: opts.cloudProfile.label,
								config: opts.cloudProfile,
								version: opts.cloudProfile.profileVersion,
								enabled: true,
								resetAt: null,
							},
						]
					: [];
			}),
		},
		appSetting: {
			findUnique: vi.fn(async () => ({
				value: { qcVmaf: opts.qcVmafEnabled ?? true },
			})),
		},
		vmafJob: {
			findFirst: vi.fn(async () => opts.existing ?? null),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				if (opts.createError !== undefined) {
					throw opts.createError;
				}
				created.push(data);
				return { id: NEW_VMAF_ID };
			}),
		},
	} as unknown as AppPrismaClient;

	const added: { jobId: string; data: { vmafJobId: string } }[] = [];
	const queue: VmafQueueLike = {
		add: vi.fn(async (_name, data, opts2) => {
			added.push({ jobId: opts2.jobId, data });
		}),
	};

	return {
		trigger: createVmafTrigger({ prisma, queue }),
		created,
		added,
		prisma,
		queue,
	};
}

describe("createVmafTrigger", () => {
	it("creates exactly one native generation6 cloud QC mirror report", async () => {
		const t = setup({ cloudProfile: CLOUD_PROFILE });
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({
				vmaf: true,
				model: "vmaf_v1.0.16_3d0h",
				execution: CLOUD_EXECUTION,
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
			} as EncodingPlan["qc"]),
		});
		expect(t.created).toHaveLength(1);
		expect(t.created[0]).toMatchObject({
			triggerKey: `vod-auto:${ENCODING_JOB_ID}`,
			scoringVersion: 6,
			params: {
				source: "QC_MIRROR",
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				execution: CLOUD_EXECUTION,
			},
		});
		expect(t.added).toHaveLength(1);
	});

	it.each([
		true,
		false,
	])("pins cloud execution and the enabled profile snapshot (vmaf=%s)", async (vmaf) => {
		const t = setup({ cloudProfile: CLOUD_PROFILE });
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({
				vmaf,
				psnr: true,
				model: "vmaf_v0.6.1",
				execution: CLOUD_EXECUTION,
			}),
		});
		expect(t.created[0]).toMatchObject({
			status: "PENDING",
			params: {
				execution: CLOUD_EXECUTION,
				executionProfile: CLOUD_PROFILE,
			},
		});
		expect(t.prisma.vmafExecutionProfile.findMany).toHaveBeenCalledOnce();
		expect(t.added).toHaveLength(1);
	});

	it.each([
		undefined,
		{ backend: "LOCAL" } as const,
	])("keeps default/local automatic measurement local (%s)", async (execution) => {
		const t = setup({ profileError: new Error("should not read profiles") });
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({
				vmaf: true,
				model: "vmaf_v0.6.1",
				...(execution ? { execution } : {}),
			}),
		});
		expect(t.created[0]).toMatchObject({
			status: "PENDING",
			params: { execution: { backend: "LOCAL" } },
		});
		expect(t.prisma.vmafExecutionProfile.findMany).not.toHaveBeenCalled();
		expect(t.added).toHaveLength(1);
	});

	it.each([
		[
			"missing or disabled profile",
			{},
			/Unknown or disabled cloud compute profile/,
		],
		[
			"profile lookup unavailable",
			{ profileError: new Error("database contains secret-token") },
			/Cloud compute profiles are unavailable/,
		],
	])("records explicit ERROR without local enqueue for %s", async (_name, opts, message) => {
		const t = setup(opts);
		await expect(
			t.trigger({
				encodingJobId: ENCODING_JOB_ID,
				plan: plan({
					vmaf: true,
					model: "vmaf_v0.6.1",
					execution: CLOUD_EXECUTION,
				}),
			}),
		).rejects.toThrow(message);
		expect(t.created[0]).toMatchObject({
			status: "ERROR",
			params: { execution: CLOUD_EXECUTION },
			error: expect.stringMatching(message),
		});
		expect(JSON.stringify(t.created)).not.toContain("secret-token");
		expect(t.added).toEqual([]);
	});

	it("re-enqueues an already pinned cloud report without resolving an edited or disabled profile", async () => {
		const t = setup({
			existing: { id: "pinned-cloud", status: "PENDING" },
			profileError: new Error("profile disabled"),
		});
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({
				vmaf: true,
				model: "vmaf_v0.6.1",
				execution: CLOUD_EXECUTION,
			}),
		});
		expect(t.prisma.vmafExecutionProfile.findMany).not.toHaveBeenCalled();
		expect(t.created).toEqual([]);
		expect(t.added).toEqual([
			{ jobId: "pinned-cloud", data: { vmafJobId: "pinned-cloud" } },
		]);
	});

	it("does not adopt the default organization's environment profile for another tenant", async () => {
		const previous = process.env.VMAF_COMPUTE_PROFILES;
		process.env.VMAF_COMPUTE_PROFILES = JSON.stringify([CLOUD_PROFILE]);
		try {
			const t = setup();
			Object.defineProperty(t.prisma, TENANT_ORGANIZATION, {
				value: "00000000-0000-4000-8000-000000000099",
			});
			await expect(
				t.trigger({
					encodingJobId: ENCODING_JOB_ID,
					plan: plan({
						vmaf: true,
						model: "vmaf_v0.6.1",
						execution: CLOUD_EXECUTION,
					}),
				}),
			).rejects.toThrow(/Unknown or disabled/);
			expect(t.created[0]).toMatchObject({
				status: "ERROR",
				params: { execution: CLOUD_EXECUTION },
			});
			expect(t.added).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.VMAF_COMPUTE_PROFILES;
			else process.env.VMAF_COMPUTE_PROFILES = previous;
		}
	});

	it("re-enqueues the canonical retry rather than selecting a retained failed report", async () => {
		const s = setup();
		(s.prisma.vmafJob.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
			async (args) => {
				return args?.where?.triggerKey === `vod-auto:${ENCODING_JOB_ID}`
					? ({ id: NEW_VMAF_ID, status: "PENDING" } as never)
					: ({ id: "old-failed", status: "ERROR" } as never);
			},
		);
		await s.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
		});
		expect(s.added).toEqual([
			{ jobId: NEW_VMAF_ID, data: { vmafJobId: NEW_VMAF_ID } },
		]);
		expect(s.created).toHaveLength(0);
	});

	it("creates NOTHING while QC/VMAF is off — the flag is read at fire time (ledger #131)", async () => {
		const s = setup({ qcVmafEnabled: false });
		await s.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
		});
		expect(s.created).toHaveLength(0);
		expect(s.added).toHaveLength(0);
	});

	it("still creates while the flag is ON — the off-case above is not passing for some other reason", async () => {
		const s = setup({ qcVmafEnabled: true });
		await s.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
		});
		expect(s.created).toHaveLength(1);
		expect(s.added).toHaveLength(1);
	});

	it("creates one VmafJob and enqueues it when the plan requests VMAF", async () => {
		const t = setup();
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: true, model: "vmaf_4k_v0.6.1" }),
		});

		expect(t.created).toHaveLength(1);
		expect(t.created[0]).toMatchObject({
			encodingJobId: ENCODING_JOB_ID,
			mode: "VOD",
			model: "vmaf_4k_v0.6.1",
			status: "PENDING",
			// DB-enforced auto-trigger idempotency : the unique
			// triggerKey is what makes a cross-worker double-FINISHED safe.
			triggerKey: `vod-auto:${ENCODING_JOB_ID}`,
			/**
			 * EXPLICIT, not the column default. The column defaults to 1 so the
			 * migration labels every historical row correctly — which means a new
			 * row that relied on the default would claim to be pre-fix, and the
			 * comparison screen would warn about mixed generations on a set that is
			 * uniform.
			 */
			scoringVersion: 3,
		});
		// Enqueued exactly once, jobId = the new VmafJob id (dedup key).
		expect(t.added).toEqual([
			{ jobId: NEW_VMAF_ID, data: { vmafJobId: NEW_VMAF_ID } },
		]);
	});

	it("does nothing when the plan did not request VMAF", async () => {
		const t = setup();
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: false, model: "vmaf_v0.6.1" }),
		});
		expect(t.created).toHaveLength(0);
		expect(t.added).toHaveLength(0);
	});

	it("creates and enqueues a job for a psnr-only plan (PSNR rides the VMAF pass)", async () => {
		// The mirror is compiled for psnr-only too, so the trigger MUST enqueue —
		// otherwise the mirror is written but never scored (lockstep with the
		// compiler/enumerateQcTargets vmaf||psnr gate).
		const t = setup();
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: false, psnr: true, model: "vmaf_v0.6.1" }),
		});
		expect(t.created).toHaveLength(1);
		expect(t.added).toEqual([
			{ jobId: NEW_VMAF_ID, data: { vmafJobId: NEW_VMAF_ID } },
		]);
	});

	it("does nothing when the plan carries no qc block", async () => {
		const t = setup();
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan(undefined),
		});
		expect(t.created).toHaveLength(0);
		expect(t.added).toHaveLength(0);
	});

	it("is idempotent: never creates a second VmafJob when one already exists", async () => {
		const t = setup({ existing: { id: "already-there", status: "RUNNING" } });
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
		});
		expect(t.prisma.vmafJob.findFirst).toHaveBeenCalledWith({
			where: {
				encodingJobId: ENCODING_JOB_ID,
				triggerKey: `vod-auto:${ENCODING_JOB_ID}`,
			},
			select: { id: true, status: true },
		});
		expect(t.created).toHaveLength(0);
		expect(t.added).toHaveLength(0);
	});

	it("re-enqueues an existing PENDING row — the forever-park exit (review-201 C1)", async () => {
		// The create→enqueue gap is non-transactional by design; a crash (or a
		// single queue.add failure) leaves a PENDING row with nothing queued.
		// The AWAITING_QC boundary re-fires this trigger every pass, and the
		// old pre-check returned on the row it had itself created — so the
		// promised recovery had no code performing it and the park had NO
		// exit (retry 409s, cancel 409s, no sweeper). Kill: restore the bare
		// `return` and this goes red.
		const t = setup({ existing: { id: "already-there", status: "PENDING" } });
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
		});
		expect(t.created).toHaveLength(0); // still no SECOND row
		expect(t.added).toEqual([
			{ jobId: "already-there", data: { vmafJobId: "already-there" } },
		]);
	});

	it("does NOT re-enqueue a terminal existing row (FINISHED measures nothing twice)", async () => {
		const t = setup({ existing: { id: "already-there", status: "FINISHED" } });
		await t.trigger({
			encodingJobId: ENCODING_JOB_ID,
			plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
		});
		expect(t.added).toHaveLength(0);
	});

	it("swallows the unique-violation race (P2002 on triggerKey): the winner enqueues, the loser returns", async () => {
		// Two workers pass the findFirst pre-check simultaneously; the second
		// insert hits the VmafJob.triggerKey unique index. That worker must
		// neither throw (FINISHED handling would error) nor enqueue (the winner
		// already did, keyed by ITS row id). The fake mirrors the public
		// `code`/`meta.target` fields of PrismaClientKnownRequestError (the
		// no-live-DB convention rules out asserting against the real class; if
		// Prisma/driver adapters ever change that surface, update the matcher).
		const t = setup({
			createError: { code: "P2002", meta: { target: ["triggerKey"] } },
		});
		await expect(
			t.trigger({
				encodingJobId: ENCODING_JOB_ID,
				plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
			}),
		).resolves.toBeUndefined();
		expect(t.added).toHaveLength(0);
	});

	it("rethrows a P2002 on a DIFFERENT constraint (never masks a future unique as a lost race)", async () => {
		const t = setup({
			createError: { code: "P2002", meta: { target: ["someOtherColumn"] } },
		});
		await expect(
			t.trigger({
				encodingJobId: ENCODING_JOB_ID,
				plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
			}),
		).rejects.toMatchObject({ code: "P2002" });
		expect(t.added).toHaveLength(0);
	});

	it("rethrows non-unique create errors", async () => {
		const boom = new Error("db down");
		const t = setup({ createError: boom });
		await expect(
			t.trigger({
				encodingJobId: ENCODING_JOB_ID,
				plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
			}),
		).rejects.toThrow("db down");
		expect(t.added).toHaveLength(0);
	});
});

describe("the column default must be a PRE-current generation", () => {
	/**
	 * The design invariant behind the two opposite defaults, pinned properly.
	 *
	 * The first version of this asserted `VMAF_SCORING_VERSION > 1`, which can only
	 * fail if someone sets the constant back to 1 — not an edit anyone makes. The
	 * real invariant is a RELATIONSHIP: a row that falls back to the column default
	 * must never claim to be current. That is what makes the migration comment and
	 * the three explicit writes mean something, and it survives every future bump
	 * of the constant (review catch).
	 *
	 * Which direction the remaining risk points is the reason this matters. With
	 * the default below current, a future creation path that forgets to write
	 * explicitly produces a false "understated" badge — loud, visible,
	 * self-correcting. With the default AT current it produces a silent false
	 * "trustworthy", which is the direction that hurts.
	 */
	it("reads the Prisma default and asserts it is below the current generation", () => {
		const schema = readFileSync(
			join(__dirname, "../../../../packages/db/prisma/schema.prisma"),
			"utf8",
		);
		const declared = /scoringVersion\s+Int\s+@default\((\d+)\)/.exec(schema);
		// A schema that no longer declares the column at all must fail here rather
		// than skip: the invariant would be unenforced and silently so.
		expect(
			declared,
			"schema.prisma must declare scoringVersion's default",
		).not.toBeNull();
		const columnDefault = Number(declared?.[1]);
		expect(columnDefault).toBeLessThan(VMAF_SCORING_VERSION);
	});
});
it("does not create automatic VMAF work for an inactive organization", async () => {
	const f = setup();
	await createVmafTrigger({ ...f, allowNewWork: async () => false })({
		encodingJobId: ENCODING_JOB_ID,
		plan: plan({ vmaf: true, model: "vmaf_v0.6.1" }),
	});
	expect(f.created).toEqual([]);
	expect(f.added).toEqual([]);
});
