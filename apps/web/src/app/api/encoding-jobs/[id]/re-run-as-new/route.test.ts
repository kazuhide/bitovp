import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileFindMany = vi.fn(async () => []);
const findUnique = vi.fn();
const create = vi.fn();
const update = vi.fn();
const getAccount = vi.fn();
const queueAdd = vi.fn();
const credentialFindMany = vi.fn(
	async () => [] as { id: string; provider: string }[],
);

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			appSetting: { findUnique: async () => ({ value: { qcVmaf: true } }) },
			vmafExecutionProfile: { findMany: profileFindMany },
			encodingJob: { findUnique, create, update },
			credential: { findMany: credentialFindMany },
		},
		bitmovinAccounts: { get: getAccount },
		// : rail 3b's resolver. These five route tests are the
		// ones whose route reaches `submitterValidationOptions`, which now
		// REQUIRES it — the other ~85 context mocks in this app are
		// untouched because their routes never ask. An empty set is the
		// honest default here: "looked, found none", which is what a
		// deployment with no MSL credentials returns.
		credentials: {
			publishingAuthCredentialIds: async () => new Set<string>(),
		},
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getOrchestratorQueue: () => ({ add: queueAdd }),
}));

import { POST } from "./route";

const fixturePath = join(
	__dirname,
	"../../../../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
);
const basePlan = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
	string,
	unknown
>;
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";
const SOURCE_ID = "00000000-0000-4000-8000-0000000000aa";
const NEW_ID = "00000000-0000-4000-8000-0000000000bb";

function planWithAccount(): Record<string, unknown> {
	return {
		...basePlan,
		bitmovin: { ...(basePlan.bitmovin as object), accountId: ACCOUNT_ID },
	};
}

const params = { params: Promise.resolve({ id: SOURCE_ID }) };
const req = () => new Request("http://test", { method: "POST" });

beforeEach(() => {
	vi.clearAllMocks();
	profileFindMany.mockResolvedValue([]);
	vi.stubEnv("VMAF_COMPUTE_PROFILES", "");
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	vi.stubEnv("DEPLOYMENT_PROFILE", "UNRESTRICTED");
	getAccount.mockResolvedValue({ id: ACCOUNT_ID });
	queueAdd.mockResolvedValue({});
	create.mockImplementation(async () => ({ id: NEW_ID }));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/encoding-jobs/[id]/re-run-as-new", () => {
	it("rechecks a saved cloud profile before creating a re-run", async () => {
		findUnique.mockResolvedValueOnce({
			id: SOURCE_ID,
			plan: {
				...planWithAccount(),
				qc: {
					vmaf: true,
					execution: {
						backend: "CLOUD",
						profileId: "removed-profile",
						budgetUsd: 5,
					},
				},
			},
		});
		const res = await POST(req(), params);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(
			/Unknown or disabled cloud compute profile/,
		);
		expect(profileFindMany).toHaveBeenCalledOnce();
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	for (const side of ["inputs", "outputs"] as const) {
		it.each([
			["GENERIC_S3", "GENERIC_S3"],
			["GENERIC_S3", "AKAMAI_OBJECT_STORAGE"],
			["AKAMAI_NETSTORAGE", "AKAMAI_NETSTORAGE"],
		] as const)(`unrestricted saved ${side}: %s / %s`, async (kind, provider) => {
			const candidate = JSON.parse(
				readFileSync(
					fixturePath.replace(
						"fixed-bitrate-hls-on-aws",
						"akamai-netstorage-io",
					),
					"utf8",
				),
			);
			candidate.bitmovin = {
				...candidate.bitmovin,
				accountId: ACCOUNT_ID,
				cloudRegion: "AKAMAI_JP_OSA",
			};
			for (const field of ["inputs", "outputs"] as const) {
				candidate[field][0].kind = kind;
				if (kind === "GENERIC_S3") candidate[field][0].bucket = "media";
			}
			credentialFindMany.mockResolvedValue(
				["inputs", "outputs"].map((field) => ({
					id: candidate[field][0].credentialId,
					provider:
						field === side
							? provider
							: kind === "GENERIC_S3"
								? "AKAMAI_OBJECT_STORAGE"
								: "AKAMAI_NETSTORAGE",
				})),
			);
			findUnique.mockResolvedValue({ id: SOURCE_ID, plan: candidate });
			// Re-running the saved plan remains available.
			expect((await POST(req(), params)).status).toBe(201);
			vi.clearAllMocks();
			const res = await POST(req(), params);
			expect(res.status).toBe(201);
			expect(credentialFindMany).toHaveBeenCalled();
			expect(create).toHaveBeenCalledOnce();
			expect(queueAdd).toHaveBeenCalledOnce();
			expect(update).not.toHaveBeenCalled();
		});
	}

	it("400s an invalid id", async () => {
		const res = await POST(req(), {
			params: Promise.resolve({ id: "not-a-uuid" }),
		});
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it("404s an unknown source job", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect((await POST(req(), params)).status).toBe(404);
		expect(create).not.toHaveBeenCalled();
	});

	it("creates a NEW QUEUED job (distinct id, columns set) without touching the source", async () => {
		findUnique.mockResolvedValueOnce({
			id: SOURCE_ID,
			plan: planWithAccount(),
			remoteStopRequestedAt: new Date("2026-09-01T00:00:00Z"),
		});
		const res = await POST(req(), params);
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe(NEW_ID);
		expect(body.sourceId).toBe(SOURCE_ID);

		// A brand-new row is created QUEUED with the denormalized columns.
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.status).toBe("QUEUED");
		expect(data).not.toHaveProperty("remoteStopRequestedAt");
		expect(data.bitmovinAccountId).toBe(ACCOUNT_ID);
		expect(data.doneSteps).toBe(0);
		expect(data.totalSteps).toBeGreaterThan(10);
		const stepLog = data.stepLog as { status: string }[];
		expect(stepLog.every((s) => s.status === "PENDING")).toBe(true);
		expect(data.totalSteps).toBe(stepLog.length);

		// Enqueued under the NEW id; the source row is never updated.
		expect(queueAdd).toHaveBeenCalledWith(
			"orchestrate",
			{ encodingJobId: NEW_ID },
			expect.objectContaining({ jobId: NEW_ID }),
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("400s when the source plan is invalid", async () => {
		findUnique.mockResolvedValueOnce({
			id: SOURCE_ID,
			plan: { planVersion: 1 },
		});
		const res = await POST(req(), params);
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("400s when the plan carries no account id", async () => {
		findUnique.mockResolvedValueOnce({ id: SOURCE_ID, plan: basePlan });
		const res = await POST(req(), params);
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("marks the new row ERROR when enqueue fails", async () => {
		findUnique.mockResolvedValueOnce({
			id: SOURCE_ID,
			plan: planWithAccount(),
		});
		queueAdd.mockRejectedValueOnce(new Error("redis down"));
		const res = await POST(req(), params);
		expect(res.status).toBe(500);
		// The NEW row is recovered to ERROR, not the source.
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: NEW_ID },
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
	});
});
