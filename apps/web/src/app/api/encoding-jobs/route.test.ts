import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verificationRequestSha256 } from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileFindMany = vi.fn(async (): Promise<unknown[]> => []);
const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const presetFindFirst = vi.fn();
const findUniqueOrThrow = vi.fn();
const findMany = vi.fn();
// EV-01: the verification-key pre-check. Default null — "no row carries the
// key" — so every pre-existing case keeps meaning what it meant.
const findUnique = vi.fn(async (_args: unknown): Promise<unknown> => null);
const queryRaw = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const getAccount = vi.fn();
const queueAdd = vi.fn();
const credentialFindMany = vi.fn(
	async () => [] as { id: string; provider: string }[],
);
const auditCreate = vi.fn(
	async (_args: { data: Record<string, unknown> }) => ({}),
);

let qcVmafEnabled = true;

const createRequests = new Map<
	string,
	{ requestSha256: string; resourceId: string }
>();
const createRequestFindFirst = vi.fn(
	async ({ where }: { where: { kind: string; requestKey: string } }) =>
		createRequests.get(`${where.kind}:${where.requestKey}`) ?? null,
);
const createRequestCreate = vi.fn(
	async ({
		data,
	}: {
		data: {
			kind: string;
			requestKey: string;
			requestSha256: string;
			resourceId: string;
		};
	}) => {
		const key = `${data.kind}:${data.requestKey}`;
		if (createRequests.has(key))
			throw {
				code: "P2002",
				meta: { target: null },
			};
		createRequests.set(key, {
			requestSha256: data.requestSha256,
			resourceId: data.resourceId,
		});
		return data;
	},
);
const prismaMock = {
	createRequest: {
		findFirst: createRequestFindFirst,
		create: createRequestCreate,
	},
	vmafExecutionProfile: { findMany: profileFindMany },
	credential: { findMany: credentialFindMany },
	appSetting: {
		findUnique: async () => ({ value: { qcVmaf: qcVmafEnabled } }),
	},
	encodingJob: {
		create,
		update,
		updateMany,
		findMany,
		findUniqueOrThrow,
		findUnique,
	},
	preset: { findFirst: presetFindFirst },
	auditLog: { create: auditCreate },
	$queryRaw: queryRaw,
	$transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
		fn(prismaMock),
	),
};

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: prismaMock,
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

import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
import { buildPlan, DEFAULT_WIZARD_STATE } from "../../vod/new/build-plan";
import { GET, POST } from "./route";

const fixturePath = join(
	__dirname,
	"../../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
);
/** The golden fixture with an account id — the shape POST cases submit. */
function planWithAccount() {
	return {
		...plan,
		bitmovin: { ...(plan.bitmovin as object), accountId: ACCOUNT_ID },
	};
}

const plan = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
	string,
	unknown
>;
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";
const PRESET_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

function postRequest(body: unknown, actor?: string): Request {
	return new Request("http://test/api/encoding-jobs", {
		method: "POST",
		headers: actor ? { [ACTOR_HEADER]: actor } : {},
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	qcVmafEnabled = true;
	vi.clearAllMocks();
	createRequests.clear();
	profileFindMany.mockResolvedValue([]);
	vi.stubEnv("VMAF_COMPUTE_PROFILES", "");
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	vi.stubEnv("DEPLOYMENT_PROFILE", "UNRESTRICTED");
	getAccount.mockResolvedValue({ id: ACCOUNT_ID });
	findUnique.mockImplementation(async () => null);
	queryRaw.mockImplementation(async () => []);
	update.mockImplementation(async () => ({}));
	updateMany.mockImplementation(async () => ({ count: 1 }));
	create.mockImplementation(async ({ data }) => ({
		id: "00000000-0000-4000-8000-0000000000aa",
		name: data.name,
		status: data.status,
	}));
	//  PR1: the route re-reads the created row through the list
	// projection after core's submitEncodingJob returns the id.
	findUniqueOrThrow.mockImplementation(async ({ where }) => ({
		id: where.id,
		name: "created",
		status: "QUEUED",
	}));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/encoding-jobs", () => {
	it.each([
		["unknown level", 0, { level: "INVALID_LEVEL" }, "level"],
		["inherited function", 0, { level: "toString" }, "level"],
		["inherited object", 0, { level: "__proto__" }, "level"],
		["empty trellis", 0, { trellis: "" }, "trellis"],
		[
			"unknown preset",
			0,
			{ presetConfiguration: "INVALID_PRESET" },
			"presetConfiguration",
		],
		[
			"unknown color space",
			0,
			{ colorConfig: { colorSpace: "INVALID_COLOR_SPACE" } },
			"colorSpace",
		],
		[
			"unknown audio layout",
			2,
			{ channelLayout: "INVALID_LAYOUT" },
			"channelLayout",
		],
	] as const)("rejects %s before persisting or enqueueing", async (_name, index, patch, _field) => {
		const candidate: Record<string, unknown> = structuredClone(
			planWithAccount(),
		);
		const renditions = candidate.renditions as Record<string, unknown>[];
		Object.assign(renditions[index] as Record<string, unknown>, patch);
		const response = await POST(postRequest({ plan: candidate }));
		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toContain("renditions");
		expect(create).not.toHaveBeenCalled();
		expect(createRequestCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it.each([
		"L4_1",
		"4.1",
	])("persists the recognized H264 level %s in canonical form", async (level) => {
		const candidate: Record<string, unknown> = structuredClone(
			planWithAccount(),
		);
		const renditions = candidate.renditions as Record<string, unknown>[];
		Object.assign(renditions[0] as Record<string, unknown>, { level });
		const response = await POST(postRequest({ plan: candidate }));
		expect(response.status).toBe(201);
		expect(create.mock.calls[0]?.[0].data.plan.renditions[0].level).toBe(
			"L4_1",
		);
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"missing",
			async () => [],
			400,
			/Unknown or disabled cloud compute profile/,
		],
		[
			"disabled",
			async () => [{ id: "gcp-auto", enabled: false, resetAt: null }],
			400,
			/Unknown or disabled cloud compute profile/,
		],
		[
			"lookup outage",
			async () => {
				throw new Error("internal cloud secret");
			},
			503,
			/Cloud compute profiles are unavailable/,
		],
	] as const)("refuses %s cloud profile before encoding create/enqueue", async (_name, readProfiles, status, message) => {
		profileFindMany.mockImplementation(readProfiles);
		const res = await POST(
			postRequest({
				plan: {
					...planWithAccount(),
					qc: {
						vmaf: true,
						execution: {
							backend: "CLOUD",
							profileId: "gcp-auto",
							budgetUsd: 5,
						},
					},
				},
			}),
		);
		expect(res.status).toBe(status);
		const response = await res.json();
		expect(response.error).toMatch(message);
		expect(JSON.stringify(response)).not.toContain("internal cloud secret");
		expect(profileFindMany).toHaveBeenCalledOnce();
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("preserves enabled cloud execution in the persisted plan", async () => {
		profileFindMany.mockResolvedValue([
			{
				id: "gcp-auto",
				label: "GCP automatic",
				enabled: true,
				resetAt: null,
				version: 2,
				config: {
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
				},
			},
		]);
		const execution = { backend: "CLOUD", profileId: "gcp-auto", budgetUsd: 5 };
		const res = await POST(
			postRequest({
				plan: { ...planWithAccount(), qc: { vmaf: true, execution } },
			}),
		);
		expect(res.status).toBe(201);
		expect(create.mock.calls[0]?.[0].data.plan.qc.execution).toEqual(execution);
		expect(profileFindMany).toHaveBeenCalledOnce();
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it("does not consult cloud profiles for local automatic measurement", async () => {
		profileFindMany.mockRejectedValue(new Error("cloud unavailable"));
		const res = await POST(
			postRequest({ plan: { ...planWithAccount(), qc: { vmaf: true } } }),
		);
		expect(res.status).toBe(201);
		expect(profileFindMany).not.toHaveBeenCalled();
	});

	it.each([
		["DRM_SPEKE", 201],
		["DRM_CENC", 400],
	] as const)("keeps SPEKE credential compatibility for %s", async (provider, status) => {
		const credentialId = "23456789-0123-4567-89ab-0123456789ab";
		const storageCredentialId = "12345678-0123-4567-89ab-0123456789ab";
		const candidate = buildPlan({
			...DEFAULT_WIZARD_STATE,
			name: "SPEKE compatibility",
			accountId: ACCOUNT_ID,
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: storageCredentialId,
					bucket: "input",
					path: "test.mp4",
				},
			],
			output: {
				...DEFAULT_WIZARD_STATE.output,
				credentialId: storageCredentialId,
				bucket: "output",
				basePath: "test/",
			},
			audios: [],
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: { drmKind: "SPEKE" },
				dashOptions: { drmKind: "SPEKE" },
			},
			drm: [
				{
					kind: "SPEKE",
					muxingKey: "v360",
					credentialId,
					contentId: "movie",
					systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
				},
			],
		});
		credentialFindMany.mockResolvedValue([
			{ id: storageCredentialId, provider: "AWS_S3" },
			{ id: credentialId, provider },
		]);
		const response = await POST(postRequest({ plan: candidate }));
		expect(response.status).toBe(status);
		if (status === 400) {
			expect((await response.json()).details.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "DRM_CREDENTIAL", level: "error" }),
				]),
			);
			expect(create).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		} else {
			expect(create).toHaveBeenCalledOnce();
			expect(queueAdd).toHaveBeenCalledOnce();
		}
	});

	for (const side of ["inputs", "outputs"] as const) {
		it.each([
			["GENERIC_S3", "GENERIC_S3"],
			["GENERIC_S3", "AKAMAI_OBJECT_STORAGE"],
			["AKAMAI_NETSTORAGE", "AKAMAI_NETSTORAGE"],
		] as const)(`unrestricted ${side}: %s / %s`, async (kind, provider) => {
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
			const res = await POST(postRequest({ plan: candidate }));
			expect(res.status).toBe(201);
			expect(credentialFindMany).toHaveBeenCalled();
			expect(create).toHaveBeenCalledOnce();
			expect(queueAdd).toHaveBeenCalledOnce();
		});
	}

	it("rejects malformed plans with field details", async () => {
		const res = await POST(postRequest({ plan: { planVersion: 1 } }));
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects plans without a bitmovin account id", async () => {
		const res = await POST(postRequest({ plan }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/accountId/);
	});

	it("rejects unknown unknown plan keys (strict schema)", async () => {
		const res = await POST(postRequest({ plan: { ...plan, surprise: true } }));
		expect(res.status).toBe(400);
	});

	it("persists parsed plan + initialized step log and enqueues", async () => {
		const withAccount = {
			...plan,
			bitmovin: { ...(plan.bitmovin as object), accountId: ACCOUNT_ID },
		};
		const res = await POST(postRequest({ plan: withAccount }));
		expect(res.status).toBe(201);

		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.status).toBe("QUEUED");
		expect(data.bitmovinAccountId).toBe(ACCOUNT_ID);
		const stepLog = data.stepLog as { step: string; status: string }[];
		expect(stepLog.length).toBeGreaterThan(10);
		expect(stepLog.every((s) => s.status === "PENDING")).toBe(true);
		expect(stepLog.at(0)?.step).toBe("input:main");
		// Denormalized list columns set at creation (region from the plan,
		// totalSteps = compiled length, doneSteps starts at 0).
		expect(data.totalSteps).toBe(stepLog.length);
		expect(data.doneSteps).toBe(0);
		expect(data).toHaveProperty("region");

		expect(queueAdd).toHaveBeenCalledWith(
			"orchestrate",
			{ encodingJobId: "00000000-0000-4000-8000-0000000000aa" },
			expect.objectContaining({
				jobId: "00000000-0000-4000-8000-0000000000aa",
			}),
		);
	});

	it("stamps template provenance when both fields arrive (ledger #109)", async () => {
		presetFindFirst.mockResolvedValueOnce({ id: PRESET_ID });
		const withAccount = {
			...plan,
			bitmovin: { ...(plan.bitmovin as object), accountId: ACCOUNT_ID },
		};
		const res = await POST(
			postRequest({
				plan: withAccount,
				presetId: PRESET_ID,
				presetRevision: 2,
			}),
		);
		expect(res.status).toBe(201);
		expect(presetFindFirst).toHaveBeenCalledWith({
			where: { id: PRESET_ID, kind: "FULL_PLAN" },
			select: { id: true },
		});
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.presetId).toBe(PRESET_ID);
		expect(data.presetRevision).toBe(2);
	});

	it("writes NULL provenance for ad-hoc submissions", async () => {
		const withAccount = {
			...plan,
			bitmovin: { ...(plan.bitmovin as object), accountId: ACCOUNT_ID },
		};
		const res = await POST(postRequest({ plan: withAccount }));
		expect(res.status).toBe(201);
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.presetId).toBeNull();
		expect(data.presetRevision).toBeNull();
		expect(presetFindFirst).not.toHaveBeenCalled();
	});

	it("400s presetId without presetRevision (both-or-neither)", async () => {
		const res = await POST(postRequest({ plan, presetId: PRESET_ID }));
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("400s an unknown template id before submitting", async () => {
		presetFindFirst.mockResolvedValueOnce(null);
		const withAccount = {
			...plan,
			bitmovin: { ...(plan.bitmovin as object), accountId: ACCOUNT_ID },
		};
		const res = await POST(
			postRequest({
				plan: withAccount,
				presetId: PRESET_ID,
				presetRevision: 1,
			}),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/template/i);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects when the bitmovin account does not exist", async () => {
		getAccount.mockResolvedValueOnce(null);
		const withAccount = {
			...plan,
			bitmovin: { ...(plan.bitmovin as object), accountId: ACCOUNT_ID },
		};
		const res = await POST(postRequest({ plan: withAccount }));
		expect(res.status).toBe(400);
		expect(queueAdd).not.toHaveBeenCalled();
	});
});

describe("GET /api/encoding-jobs", () => {
	it("returns a lean paginated projection (incl. the new list columns)", async () => {
		findMany.mockResolvedValueOnce([{ id: "1", name: "x", status: "QUEUED" }]);
		const res = await GET(new Request("http://test/api/encoding-jobs"));
		expect(res.status).toBe(200);
		const args = findMany.mock.calls[0]?.[0] as {
			select: Record<string, boolean>;
			where: Record<string, unknown>;
		};
		// Still NEVER plan/stepLog/snapshots (perf contract).
		expect(args.select).not.toHaveProperty("plan");
		expect(args.select).not.toHaveProperty("stepLog");
		expect(args.select).not.toHaveProperty("snapshots");
		// New denormalized columns ARE projected.
		expect(args.select).toMatchObject({
			labels: true,
			region: true,
			doneSteps: true,
			totalSteps: true,
			// The QC verdict column  — a small Json, not a
			// heavyweight document; the perf contract above still holds.
			qcVerdict: true,
		});
		// No filter params ⇒ empty where (no status/label keys).
		expect(args.where).toEqual({});
	});

	it("filters by status and label and composes with the cursor", async () => {
		findMany.mockResolvedValueOnce([]);
		const cursor = "00000000-0000-4000-8000-0000000000ff";
		const res = await GET(
			new Request(
				`http://test/api/encoding-jobs?status=FINISHED&label=promo&cursor=${cursor}`,
			),
		);
		expect(res.status).toBe(200);
		const args = findMany.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			cursor?: { id: string };
			skip?: number;
		};
		expect(args.where).toEqual({
			status: "FINISHED",
			labels: { has: "promo" },
		});
		expect(args.cursor).toEqual({ id: cursor });
		expect(args.skip).toBe(1);
	});

	it("filters by QC outcome via the verdict's pass field (ledger #86 PR3)", async () => {
		findMany.mockResolvedValueOnce([]);
		const res = await GET(new Request("http://test/api/encoding-jobs?qc=fail"));
		expect(res.status).toBe(200);
		const args = findMany.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		// Json-path filter — verdict-less rows (null column) match neither
		// value: the filter answers "what did the gate say".
		expect(args.where).toEqual({
			qcVerdict: { path: ["pass"], equals: false },
		});
		const bad = await GET(
			new Request("http://test/api/encoding-jobs?qc=maybe"),
		);
		expect(bad.status).toBe(400);
	});

	it("rejects an invalid status value with 400", async () => {
		const res = await GET(
			new Request("http://test/api/encoding-jobs?status=BOGUS"),
		);
		expect(res.status).toBe(400);
		expect(findMany).not.toHaveBeenCalled();
	});
});

describe("credential-egress host allowlist (C22, ledger #34)", () => {
	// The route is the ENFORCEMENT POINT: `validatePlan` only checks egress hosts
	// when the caller supplies the allowlist, so a route that forgets to pass it
	// validates clean no matter what host the plan names. These tests fail if the
	// options argument is dropped — the unit tests in packages/core would not.
	const kantarPlan = (serverUrl: string) => ({
		...plan,
		kantar: {
			credentialId: "00000000-0000-4000-8000-0000000000b1",
			licenseId: 4711,
			channelName: "Ch",
			contentReference: "ep01",
			serverUrl,
			reportDestination: { outputKey: "origin", path: "reports" },
		},
		bitmovin: { ...(plan.bitmovin as object), accountId: ACCOUNT_ID },
	});

	it("rejects a Kantar serverUrl whose host is not on the allowlist", async () => {
		vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "kantar.example.com");
		const res = await POST(
			postRequest({ plan: kantarPlan("https://attacker.example.net/wm") }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: string;
			details: { issues: { code: string; path: string }[] };
		};
		expect(body.error).toBe("Plan validation failed");
		expect(body.details.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED",
					path: "kantar.serverUrl",
				}),
			]),
		);
		// The job must not exist: a persisted QUEUED row would be picked up by the
		// worker, which decrypts the pair and POSTs it.
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("accepts the same plan when the host IS on the allowlist", async () => {
		vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "kantar.example.com");
		const res = await POST(
			postRequest({ plan: kantarPlan("https://kantar.example.com/wm") }),
		);
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("with no allowlist configured the job proceeds but files a POLICY audit row", async () => {
		// Fail-open is deliberate (blocking would break every install that has
		// not configured the list) — but it must be DURABLE, since the warning is
		// not an error and never reaches the response on success. The plan that
		// triggered it is persisted forever; the record has to outlive a restart
		// too (review catch: console was the wrong sink).
		const res = await POST(
			postRequest({ plan: kantarPlan("https://whoever.example.net/wm") }),
		);
		expect(res.status).toBe(201);
		const row = auditCreate.mock.calls[0]?.[0].data;
		expect(row?.method).toBe("POLICY");
		expect(JSON.stringify(row?.request)).toContain("whoever.example.net");
	});

	it("a plan with no egress field is unaffected by the allowlist", async () => {
		vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "kantar.example.com");
		const res = await POST(
			postRequest({
				plan: {
					...plan,
					bitmovin: { ...(plan.bitmovin as object), accountId: ACCOUNT_ID },
				},
			}),
		);
		expect(res.status).toBe(201);
		expect(auditCreate).not.toHaveBeenCalled();
	});
});

describe("POST /api/encoding-jobs — the QC/VMAF flag (ledger #131)", () => {
	it("422s a plan carrying a qc block while QC/VMAF is off, naming the switch", async () => {
		qcVmafEnabled = false;
		const res = await POST(
			postRequest({ plan: { ...planWithAccount(), qc: { vmaf: true } } }),
		);
		expect(res.status).toBe(422);
		// The refusal must say WHERE to change it and what the alternative is —
		// a silent strip would encode something other than the plan the audit
		// trail keeps, which is why this is a refusal at all.
		const { error } = await res.json();
		expect(error).toMatch(/Settings/);
		expect(error).toMatch(/qc/);
	});

	it("accepts the same plan while ON, and accepts a qc-less plan while OFF", async () => {
		qcVmafEnabled = true;
		expect(
			(
				await POST(
					postRequest({ plan: { ...planWithAccount(), qc: { vmaf: true } } }),
				)
			).status,
		).not.toBe(422);
		qcVmafEnabled = false;
		expect(
			(await POST(postRequest({ plan: planWithAccount() }))).status,
		).not.toBe(422);
	});
});

describe("createdBy attribution (#32 §5)", () => {
	it("stamps the verified actor onto the created job", async () => {
		await POST(
			postRequest(
				{ plan: planWithAccount() },
				"user:11111111-2222-4333-8444-555555555555",
			),
		);
		expect(create).toHaveBeenCalled();
		expect(create.mock.calls[0]?.[0].data.createdBy).toBe(
			"user:11111111-2222-4333-8444-555555555555",
		);
	});

	it("a token actor is carried too", async () => {
		await POST(postRequest({ plan: planWithAccount() }, "token:tok-1"));
		expect(create.mock.calls[0]?.[0].data.createdBy).toBe("token:tok-1");
	});

	it("the DEFAULT password-mode actor 'session' is carried (review-286 M1)", async () => {
		// The proxy stamps the literal 'session' in shared-password mode — the
		// value the DEFAULT install writes, so a `createdBy LIKE 'user:%'`
		// report is not the only shape rows take.
		await POST(postRequest({ plan: planWithAccount() }, "session"));
		expect(create.mock.calls[0]?.[0].data.createdBy).toBe("session");
	});

	it("no verified actor ⇒ null, never a fabricated one", async () => {
		await POST(postRequest({ plan: planWithAccount() }));
		expect(create.mock.calls[0]?.[0].data.createdBy).toBeNull();
	});
});

/**
 * EV-01: the verification harness's idempotency
 * key. A create response lost after the server created the job used to leave
 * the harness with no id at all; now the same key answers with the row it
 * already paid for, and a different request under the same key is refused.
 */
describe("POST /api/encoding-jobs — the verification key (EV-01)", () => {
	const KEY = "verify:2026-08-31T00-00-00-000-abc123:h264-hls:VOD_JOB";
	const DISPATCH = {
		verificationRunId: "00000000-0000-4000-8000-000000000001",
		runGeneration: 0,
		intentId: "00000000-0000-4000-8000-000000000002",
		intentGeneration: 1,
		token: "verify-dispatch:run:123:11111111-1111-4111-8111-111111111111",
	};
	const SHA = verificationRequestSha256({
		plan: planWithAccount(),
		verificationKey: KEY,
	});
	const existingRow = (sha: string | null) => ({
		id: "00000000-0000-4000-8000-00000000ee11",
		name: "uc01-h264-hls [verify 2026-08-31T00-00-00-000-abc123]",
		status: "RUNNING",
		verificationRequestSha256: sha,
	});
	const dispatchAuthority = (recovered = false) => {
		queryRaw.mockImplementation(async (strings: unknown) => {
			const sql = Array.from(strings as readonly string[]).join("?");
			if (sql.includes('FROM "VerificationRun"')) {
				return [
					{
						id: DISPATCH.verificationRunId,
						status: recovered ? "INCOMPLETE" : "RUNNING",
						recoveryGeneration: recovered ? 1 : DISPATCH.runGeneration,
						recoveryOwner: null,
					},
				];
			}
			if (sql.includes('FROM "VerificationResourceIntent"')) {
				return [
					{
						id: DISPATCH.intentId,
						verificationRunId: DISPATCH.verificationRunId,
						kind: "VOD_JOB",
						verificationKey: KEY,
						requestSha256: SHA,
						state: recovered ? "TERMINAL" : "SUBMITTED",
						cleanupState: recovered ? "NEVER_CREATED" : "PENDING",
						recoveryOwner: recovered ? null : DISPATCH.token,
						recoveryGeneration: recovered ? 2 : DISPATCH.intentGeneration,
					},
				];
			}
			return [];
		});
	};

	it("stamps the key and its request SHA in the SAME insert as the row, after looking the key up", async () => {
		dispatchAuthority();
		const res = await POST(
			postRequest({
				plan: planWithAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);
		expect(res.status).toBe(201);
		expect(findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { verificationKey: KEY } }),
		);
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.verificationKey).toBe(KEY);
		expect(data.verificationRequestSha256).toBe(SHA);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});

	it("preserves CANCELED when recovery wins after the fenced create and the delayed enqueue rejects", async () => {
		let status = "QUEUED";
		update.mockImplementationOnce(async ({ data }) => {
			status = data.status;
			return { id: "00000000-0000-4000-8000-0000000000aa", status };
		});
		updateMany.mockImplementationOnce(async ({ where, data }) => {
			if (status !== where.status) return { count: 0 };
			status = data.status;
			return { count: 1 };
		});
		queueAdd.mockImplementationOnce(async () => {
			status = "CANCELED";
			throw new Error("redis response lost after recovery canceled the row");
		});
		dispatchAuthority();

		const res = await POST(
			postRequest({
				plan: planWithAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);

		expect(res.status).toBe(500);
		expect(status).toBe("CANCELED");
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "00000000-0000-4000-8000-0000000000aa",
				status: "QUEUED",
			},
			data: { status: "ERROR", error: "Enqueue failed — retry the job" },
		});
	});

	it("refuses the stale producer after recovery changed the parent/intent generations — no job and no enqueue", async () => {
		dispatchAuthority(true);
		const res = await POST(
			postRequest({
				plan: planWithAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);
		expect(res.status).toBe(409);
		const response = await res.json();
		expect(response).toMatchObject({
			details: { code: "VERIFICATION_DISPATCH_FENCE_REJECTED" },
		});
		expect(JSON.stringify(response)).not.toContain(DISPATCH.token);
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("requires a dispatch fence only when a new verification-key resource would be created", async () => {
		const res = await POST(
			postRequest({
				plan: planWithAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
			}),
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "VERIFICATION_DISPATCH_FENCE_REQUIRED" },
		});
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("rejects a stale client SHA before lookup/create — the server recomputes the canonical request", async () => {
		const res = await POST(
			postRequest({
				plan: { ...planWithAccount(), name: "changed-after-hash" },
				verificationKey: KEY,
				requestSha256: SHA,
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			details: { code: "VERIFICATION_REQUEST_SHA_MISMATCH" },
		});
		expect(findUnique).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("an ordinary submit carries neither column and never looks a key up", async () => {
		const res = await POST(postRequest({ plan: planWithAccount() }));
		expect(res.status).toBe(201);
		expect(findUnique).not.toHaveBeenCalled();
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data).not.toHaveProperty("verificationKey");
		expect(data).not.toHaveProperty("verificationRequestSha256");
	});

	it("a repeat with the same key and SHA answers the EXISTING job — 200, replayed, no create, no enqueue", async () => {
		findUnique.mockResolvedValueOnce(existingRow(SHA));
		const res = await POST(
			postRequest({
				plan: planWithAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe("00000000-0000-4000-8000-00000000ee11");
		expect(body.replayed).toBe(true);
		expect(body).not.toHaveProperty("verificationRequestSha256");
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("a repeat with the same key and a DIFFERENT SHA is 409 and creates nothing", async () => {
		findUnique.mockResolvedValueOnce(existingRow("b".repeat(64)));
		const res = await POST(
			postRequest({
				plan: planWithAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
			}),
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/different request/),
			details: {
				code: "VERIFICATION_KEY_SHA_CONFLICT",
				verificationKey: KEY,
			},
		});
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("refuses a key without its SHA, and a digest that is not hex-64 — 400, nothing created", async () => {
		for (const body of [
			{ plan: planWithAccount(), verificationKey: KEY },
			{ plan: planWithAccount(), requestSha256: SHA },
			{ plan: planWithAccount(), verificationKey: KEY, requestSha256: "nope" },
		]) {
			const res = await POST(postRequest(body));
			expect(res.status, JSON.stringify(Object.keys(body))).toBe(400);
		}
		expect(create).not.toHaveBeenCalled();
		expect(findUnique).not.toHaveBeenCalled();
	});

	it("a send that LOSES the unique-insert race re-reads the winner and replays it — never a 500, never a twin", async () => {
		// Pre-check: nothing yet. Then the concurrent winner lands and this
		// insert hits the unique key; the second lookup finds the winner.
		findUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(existingRow(SHA));
		create.mockRejectedValueOnce(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
				meta: { target: ["verificationKey"] },
			}),
		);
		dispatchAuthority();
		const res = await POST(
			postRequest({
				plan: planWithAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).replayed).toBe(true);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("a P2002 on ANOTHER unique column is still an error, not a replay", async () => {
		create.mockRejectedValueOnce(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
				meta: { target: ["bitmovinEncodingId"] },
			}),
		);
		dispatchAuthority();
		const res = await POST(
			postRequest({
				plan: planWithAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);
		expect(res.status).toBe(500);
		expect(findUnique).toHaveBeenCalledTimes(1);
	});
});

describe("ordinary GUI create retries", () => {
	function keyedRequest(body: unknown, key = "gui-request-1") {
		return new Request("http://test/api/encoding-jobs", {
			method: "POST",
			headers: { "Idempotency-Key": key },
			body: JSON.stringify(body),
		});
	}
	it("recovers a lost create response without creating or enqueuing a second resource", async () => {
		const body = { plan: planWithAccount() };
		await POST(keyedRequest(body));
		findUnique.mockResolvedValue({
			id: "00000000-0000-4000-8000-0000000000aa",
			name: "created",
			status: "QUEUED",
		});
		getAccount.mockResolvedValue(null);
		const retry = await POST(keyedRequest(body));
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({
			id: "00000000-0000-4000-8000-0000000000aa",
			replayed: true,
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});
	it("rejects changed content under an already accepted key", async () => {
		await POST(keyedRequest({ plan: planWithAccount() }));
		const retry = await POST(
			keyedRequest({ plan: { ...planWithAccount(), name: "different" } }),
		);
		expect(retry.status).toBe(409);
		expect(await retry.json()).toMatchObject({
			details: { code: "CREATE_REQUEST_CONFLICT" },
		});
		expect(create).toHaveBeenCalledTimes(1);
	});
	it("keeps the receipt after deletion and refuses to recreate the paid resource", async () => {
		const body = { plan: planWithAccount() };
		await POST(keyedRequest(body));
		findUnique.mockResolvedValue(null);
		const retry = await POST(keyedRequest(body));
		expect(retry.status).toBe(410);
		expect(await retry.json()).toMatchObject({
			details: { code: "CREATE_REQUEST_GONE" },
		});
		expect(create).toHaveBeenCalledTimes(1);
	});
	it("leaves existing unkeyed API callers unchanged", async () => {
		const response = await POST(postRequest({ plan: planWithAccount() }));
		expect(response.status).toBe(201);
		expect(createRequestCreate).not.toHaveBeenCalled();
	});
	it.each([
		false,
		true,
	])("resolves a racing receipt insert; changed content: %s", async (changed) => {
		createRequestCreate.mockImplementationOnce(async ({ data }) => {
			createRequests.set(`VOD_JOB:${data.requestKey}`, {
				requestSha256: changed ? "a".repeat(64) : data.requestSha256,
				resourceId: "00000000-0000-4000-8000-0000000000cc",
			});
			throw {
				code: "P2002",
				meta: { target: null },
			};
		});
		findUnique.mockResolvedValue({
			id: "00000000-0000-4000-8000-0000000000cc",
			name: "winner",
			status: "QUEUED",
		});
		const response = await POST(keyedRequest({ plan: planWithAccount() }));
		expect(response.status).toBe(changed ? 409 : 200);
		expect(await response.json()).toMatchObject(
			changed
				? { details: { code: "CREATE_REQUEST_CONFLICT" } }
				: { id: "00000000-0000-4000-8000-0000000000cc", replayed: true },
		);
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("returns the accepted ERROR resource after an enqueue failure without enqueueing again", async () => {
		queueAdd.mockRejectedValueOnce(new Error("queue unavailable"));
		const body = { plan: planWithAccount() };
		const first = await POST(keyedRequest(body));
		expect(first.status).toBe(500);
		findUnique.mockResolvedValue({
			id: "00000000-0000-4000-8000-0000000000aa",
			name: "created",
			status: "ERROR",
		});
		const retry = await POST(keyedRequest(body));
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({
			id: "00000000-0000-4000-8000-0000000000aa",
			status: "ERROR",
			replayed: true,
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});
	it.each([
		["bitmovinEncodingId"],
		null,
	])("does not treat a resource unique constraint as a successful replay: %s", async (target) => {
		create.mockRejectedValueOnce({
			code: "P2002",
			meta: { target },
		});
		const response = await POST(keyedRequest({ plan: planWithAccount() }));
		expect(response.status).toBe(500);
		expect(createRequestCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it.each([
		"",
		"has spaces",
		"a".repeat(201),
	])("refuses an invalid key before creating: %s", async (key) => {
		const response = await POST(keyedRequest({ plan: planWithAccount() }, key));
		expect(response.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});
	it.each([
		"verificationKey",
		"requestSha256",
		"verificationDispatch",
	])("does not combine an ordinary key with %s", async (field) => {
		const response = await POST(
			keyedRequest({ plan: planWithAccount(), [field]: null }),
		);
		expect(response.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});
});
