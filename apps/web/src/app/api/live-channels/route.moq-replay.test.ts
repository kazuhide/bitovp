import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	MOQ_TASK_HISTORY_ERROR,
	verificationRequestSha256,
} from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestIdentity } from "@/lib/server/create-request";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	errorSnapshots: vi.fn(),
	create: vi.fn(),
	receiptFind: vi.fn(),
	receiptCreate: vi.fn(),
	schedules: vi.fn(),
	queue: vi.fn(),
	queryRaw: vi.fn(),
}));
const ORG = "00000000-0000-4000-8000-000000000001";
const CHANNEL = "00000000-0000-4000-8000-000000000002";
const ACCOUNT = "00000000-0000-4000-8000-000000000003";
const CREDENTIAL = "00000000-0000-4000-8000-000000000004";
const KEY = "moq-replay-privacy";
const DISPATCH = {
	verificationRunId: "00000000-0000-4000-8000-000000000011",
	runGeneration: 0,
	intentId: "00000000-0000-4000-8000-000000000012",
	intentGeneration: 1,
	token: "verify-dispatch:run:123:22222222-2222-4222-8222-222222222222",
};
const retainedError =
	"Provider task rejected authToken=synthetic-retained-token; private provider prose";
const schedules = [
	{
		id: "00000000-0000-4000-8000-000000000020",
		liveChannelId: CHANNEL,
		action: "STOP",
		fireAt: "2026-11-18T00:10:00.000Z",
	},
];
const retainedRow = {
	id: CHANNEL,
	origin: "MANUAL",
	name: "retained channel",
	status: "ERROR",
	error: retainedError,
	bitmovinEncodingId: "00000000-0000-4000-8000-000000000005",
	bitmovinAccountId: ACCOUNT,
	createdAt: "2026-11-18T00:00:00.000Z",
	updatedAt: "2026-11-18T00:01:00.000Z",
	programStartAt: null,
	programEndAt: null,
	maxRunMinutes: 10,
};
const prisma = {
	liveChannel: {
		findUnique: mocks.findUnique,
		create: mocks.create,
	},
	liveSchedule: { findMany: mocks.schedules },
	createRequest: {
		findFirst: mocks.receiptFind,
		create: mocks.receiptCreate,
	},
	credential: {
		findMany: async () => [{ id: CREDENTIAL, provider: "MOQ" }],
	},
	$queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
		strings.join("?").includes('FROM "LiveChannel" WHERE id = ANY(')
			? mocks.errorSnapshots(strings, ...values)
			: mocks.queryRaw(strings, ...values),
	$transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
};
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		tenant: {
			organizationId: ORG,
			actor: "user:operator",
			role: "OPERATOR",
			isImpersonating: false,
		},
		prisma,
		bitmovinAccounts: { get: async () => ({ id: ACCOUNT }) },
		credentials: { publishingAuthCredentialIds: async () => new Set() },
	}),
}));
vi.mock("@/lib/server/queue", () => ({
	getLiveChannelQueue: () => ({ add: mocks.queue }),
}));

import { POST } from "./route";

function moqPlan() {
	const fixture = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
	return {
		...fixture,
		bitmovin: { ...fixture.bitmovin, accountId: ACCOUNT },
		outputs: [
			{
				key: "relay",
				kind: "MOQ",
				credentialId: CREDENTIAL,
				name: "MoQ relay",
				trackNamespace: ["replay-privacy"],
				draftVersion: "DRAFT_16",
			},
		],
		liveManifests: [],
		start: { ...fixture.start, encodingOption: "CUSTOM" },
		muxings: fixture.muxings.map((muxing: { destination: object }) => ({
			...muxing,
			segmentLength: 1,
			destination: { ...muxing.destination, outputKey: "relay" },
		})),
	};
}
function request(body: unknown, ordinary: boolean) {
	return new Request("http://test/api/live-channels", {
		method: "POST",
		headers: ordinary ? { "Idempotency-Key": KEY } : {},
		body: JSON.stringify(body),
	});
}
type Mode = "ordinary" | "verification";
function arrangeReplay(mode: Mode, race = false) {
	const plan = moqPlan();
	const sha = verificationRequestSha256({ plan, verificationKey: KEY });
	if (mode === "ordinary") {
		const body = { plan };
		const identity = createRequestIdentity(request(body, true), body);
		if (!identity) throw new Error("Missing test identity");
		const receipt = {
			requestSha256: identity.requestSha256,
			resourceId: CHANNEL,
		};
		mocks.receiptFind.mockResolvedValue(receipt);
		if (race) {
			mocks.receiptFind.mockResolvedValueOnce(null);
			mocks.receiptCreate.mockRejectedValueOnce({ code: "P2002" });
		}
		mocks.findUnique.mockResolvedValue(retainedRow);
		return request(body, true);
	}
	mocks.findUnique.mockResolvedValue({
		...retainedRow,
		verificationRequestSha256: sha,
	});
	if (race) {
		mocks.findUnique.mockResolvedValueOnce(null);
		mocks.create.mockRejectedValueOnce({
			code: "P2002",
			meta: { target: ["verificationKey"] },
		});
	}
	mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
		const sql = strings.join("?");
		return sql.includes('FROM "VerificationRun"')
			? [
					{
						id: DISPATCH.verificationRunId,
						status: "RUNNING",
						recoveryGeneration: DISPATCH.runGeneration,
						recoveryOwner: null,
					},
				]
			: [
					{
						id: DISPATCH.intentId,
						verificationRunId: DISPATCH.verificationRunId,
						kind: "LIVE_CHANNEL",
						verificationKey: KEY,
						requestSha256: sha,
						state: "SUBMITTED",
						cleanupState: "PENDING",
						recoveryOwner: DISPATCH.token,
						recoveryGeneration: DISPATCH.intentGeneration,
					},
				];
	});
	return request(
		{
			plan,
			verificationKey: KEY,
			requestSha256: sha,
			...(race ? { verificationDispatch: DISPATCH } : {}),
		},
		false,
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	mocks.schedules.mockResolvedValue(
		schedules.map((row) => ({
			...row,
			outcomeNote: "Source unavailable at scene.mxf?auth=PRIVATE_FIXTURE",
			note: "Registration failed at old.mxf?sig=PRIVATE_FIXTURE",
			error: "Loading old.mxf?token=PRIVATE_FIXTURE",
		})),
	);
	mocks.errorSnapshots.mockResolvedValue([
		{ id: CHANNEL, error: MOQ_TASK_HISTORY_ERROR },
	]);
	mocks.create.mockResolvedValue({ ...retainedRow, status: "CREATED" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST live channel retained MoQ error privacy", () => {
	it.each([
		["ordinary", false],
		["verification", false],
		["ordinary", true],
		["verification", true],
	] as const)("filters %s replay errors, including unique-conflict recovery: %s", async (mode, race) => {
		const response = await POST(arrangeReplay(mode, race));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			...retainedRow,
			error: MOQ_TASK_HISTORY_ERROR,
			issues: [],
			schedules: schedules.map((row) => ({
				...row,
				outcomeNote: "[withheld]",
				note: "[withheld]",
				error: "[withheld]",
			})),
			replayed: true,
		});
		expect(JSON.stringify(body)).not.toContain("synthetic-retained-token");
		expect(body).not.toHaveProperty("verificationRequestSha256");
		expect(body).not.toHaveProperty("stepLog");
		expect(body).not.toHaveProperty("plan");
		expect(mocks.errorSnapshots).toHaveBeenCalledExactlyOnceWith(
			expect.any(Array),
			MOQ_TASK_HISTORY_ERROR,
			[CHANNEL],
		);
		for (const [query] of mocks.findUnique.mock.calls) {
			expect(query.select).not.toHaveProperty("stepLog");
			expect(query.select).not.toHaveProperty("plan");
		}
		expect(mocks.create).toHaveBeenCalledTimes(race ? 1 : 0);
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it.each([
		"ordinary",
		"verification",
	] as const)("preserves normal Live prose in %s replay", async (mode) => {
		mocks.errorSnapshots.mockResolvedValue([
			{ id: CHANNEL, error: retainedError },
		]);
		const response = await POST(arrangeReplay(mode));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: CHANNEL,
			error: retainedError,
			replayed: true,
			schedules,
		});
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it.each([
		"ordinary",
		"verification",
	] as const)("withholds a captured error when the %s replay row disappears", async (mode) => {
		mocks.errorSnapshots.mockResolvedValue([]);
		const response = await POST(arrangeReplay(mode));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.error).toBe("Live encoding error details unavailable");
		expect(JSON.stringify(body)).not.toContain("synthetic-retained-token");
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it.each([
		"ordinary",
		"verification",
	] as const)("does not expose an unclassified error if %s replay classification fails", async (mode) => {
		mocks.errorSnapshots.mockRejectedValue(
			new Error("Metadata lookup unavailable"),
		);
		const response = await POST(arrangeReplay(mode));
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("synthetic-retained-token");
		expect(mocks.queue).not.toHaveBeenCalled();
	});
});
