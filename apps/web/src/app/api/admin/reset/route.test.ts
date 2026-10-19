import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	feederOccupancyWhere,
	verificationIntentClosureDigest,
} from "@bitovp/core";
import { fieldRef, fieldRefs } from "@bitovp/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
import {
	resetPostResponseSchema,
	resetPreviewResponseSchema,
} from "@/lib/reset-customer-contract";
import { RESET_CATEGORIES, RESET_GLOBAL_MODELS } from "@/lib/reset-selection";
import { AisaSnapshotRequired } from "@/lib/server/delete-jobs";
import {
	ENCODER_POINTER_RECORD_LIMIT,
	RESET_BLOCKING_CHANNEL_STATUSES,
	RESET_BLOCKING_JOB_STATUSES,
	RESET_STOPPED_CHANNEL_STATUSES,
	RESET_STOPPED_JOB_STATUSES,
} from "@/lib/server/reset";

/**
 * . Three properties, each of which the owner's decision makes
 * load-bearing rather than nice-to-have:
 *  1. refuses while anything runs, and SAYS what (the reset never touches
 *     Bitmovin, so deleting the rows would orphan a paying encoder — #48);
 *  2. deletes exactly the operational models and touches NO configuration one
 *     (asserted per model, not by a total);
 *  3. writes its audit row AFTER the delete, as the first row of the new
 *     history, carrying the counts.
 */
const deleted: string[] = [];
const updated: [string, unknown][] = [];
let txOptions: {
	timeout?: number;
	maxWait?: number;
	isolationLevel?: string;
} | null = null;
let transactionFailure: unknown = null;
let finishedAisaJobs: {
	id: string;
	bitmovinEncodingId: string;
	plan: unknown;
}[] = [];
let aisaCaptured = false;
const auditCreate = vi.fn(async (_args?: unknown) => ({ id: "audit-1" }));
type PointerRow = {
	id: string;
	name?: string | null;
	status: string;
	bitmovinEncodingId: string;
};
let active = {
	encodingJobs: [] as { id: string; name: string; status: string }[],
	liveChannels: [] as { id: string; name: string; status: string }[],
	feederSessions: [] as {
		id: string;
		status: string;
		sourceKey: string;
		createdAt: Date;
		liveChannel: { name: string };
	}[],
	vmafJobs: [] as {
		id: string;
		status: string;
		mode: "VOD" | "LIVE";
		createdAt: Date;
		encodingJob: { name: string } | null;
	}[],
	verificationIntents: [] as {
		id: string;
		verificationRunId: string;
		verificationKey: string;
		requestSha256: string;
		state: string;
		cleanupState: string;
		possiblyCreatedKeys: string[];
		cleanedResourceKeys: string[];
		providerIds: string[];
		candidates: unknown;
		readback: unknown;
		closureDigest: string | null;
	}[],
	/** 130-B2: rows naming an encoder from a not-known-stopped status. */
	pointerJobs: [] as PointerRow[],
	pointerChannels: [] as PointerRow[],
	pointerRuns: [] as PointerRow[],
	/** Every pointer, stopped or not — what the audit row records. */
	allPointers: [] as PointerRow[],
};
let pointerTotals = { jobs: 0, channels: 0, runs: 0 };
let pointerIdentityIds: {
	jobs?: string[];
	channels?: string[];
	runs?: string[];
} = {};
/** The WHERE clauses the pointer scans ran with — the predicate lives there,
 *  not in our code, so the tests assert the query rather than the mock's
 *  answer (a mock that returns what it was told proves nothing about SQL). */
const pointerQueries: Record<string, unknown[]> = {};
const feederQueries: unknown[] = [];

function model(name: string) {
	return {
		// : the pointer predicates compare the stamp against the
		// row's own pointer through a field reference.
		fields: fieldRefs(name.charAt(0).toUpperCase() + name.slice(1), [
			"bitmovinEncodingId",
		]),
		deleteMany: vi.fn(async () => {
			deleted.push(name);
			return { count: 1 };
		}),
		count: vi.fn(async () => 1),
		findMany: vi.fn(async () => []),
		// review-2 C1: watch rules are DISARMED, not deleted, so the harness
		// has to model an update as well as a delete.
		updateMany: vi.fn(async (args?: unknown) => {
			updated.push([name, args]);
			return { count: 1 };
		}),
	};
}

const MODELS = [
	"webhookEvent",
	"auditLog",
	"accessEvent",
	"storageInspection",
	"watchedObject",
	"alertEvent",
	"liveHeartbeat",
	"startupSample",
	"slateNormalization",
	"liveSchedule",
	"liveEffectClaim",
	"feederSession",
	"vmafResult",
	"vmafJob",
	"manifestJob",
	"liveChannelRun",
	"liveChannel",
	"encodingJob",
];
const PRESERVES = [
	"createRequest",
	// Internal ownership ledgers must survive reset until external cleanup completes.
	"resetCleanupTask",
	"vmafComputeTask",
	"librarySource",
	"sceneAnalysisRevision",
	"content",
	"contentRevision",
	// WP-G G-2: the provider-side cleanup index (see RESET_PRESERVES).
	"webhookRegistration",
	"feederPushAttempt",
	"verificationLiveEvidence",
	"verificationResourceIntentEvent",
	"verificationResourceIntent",
	"verificationRun",
];
const KEEPS = [
	"vmafComputeCredential",
	"vmafExecutionProfile",
	"credential",
	"bitmovinAccount",
	"storageLocationPreset",
	"alertRule",
	"preset",
	"watchRule",
	"notificationChannel",
	"notificationRule",
	"apiToken",
	"appSetting",
	// #32: identity is configuration — kept (reset.ts names the reasoning).
	"user",
	"setupCode",
	"organization",
	"membership",
	"platformSetting",
	// : provider billing history keyed to a kept account.
	"usageDailyStatistic",
	"usageSweepCursor",
];

const prisma: Record<string, unknown> = {
	$queryRaw: vi.fn(async () => []),
	librarySource: {
		...model("librarySource"),
		findUnique: vi.fn(async () => (aisaCaptured ? { id: "source-1" } : null)),
	},
	// : the options object is load-bearing — Prisma's default
	// interactive-transaction timeout is 5s, and the deployment where a reset
	// matters most is the one with enough history to exceed it. The harness
	// records what the route passed so the pin below can assert it.
	$transaction: async (
		fn: (tx: unknown) => Promise<unknown>,
		options?: { timeout?: number; maxWait?: number },
	) => {
		txOptions = options ?? null;
		if (transactionFailure) {
			throw transactionFailure;
		}
		return fn(prisma);
	},
	auditLog: { ...model("auditLog"), create: auditCreate },
};
for (const name of MODELS) {
	if (!prisma[name]) {
		prisma[name] = model(name);
	}
}
for (const name of [...KEEPS, ...PRESERVES]) {
	if (!prisma[name]) {
		prisma[name] = model(name);
	}
}
/**
 * The probes read through findMany, and after 130-B2 the same model is asked
 * TWO different questions — "what is running" (status) and "what still names an
 * encoder" (pointer) — plus a third for the audit row (every pointer,
 * regardless of status). Prisma would discriminate them by WHERE; the mock has
 * to do the same or the second query silently receives the first one's answer.
 */
function findManyFor(
	name: string,
	byStatus: () => unknown[],
	byPointer: () => PointerRow[],
	allPointers: () => PointerRow[],
	identityIds: () => string[] | undefined,
) {
	return vi.fn(
		async (args?: {
			where?: { bitmovinEncodingId?: unknown; status?: unknown; NOT?: unknown };
			distinct?: string[];
			select?: { plan?: boolean };
		}) => {
			if (name === "encodingJob" && args?.select?.plan) return finishedAisaJobs;
			const where = args?.where ?? {};
			if (where.bitmovinEncodingId) {
				pointerQueries[name] ??= [];
				pointerQueries[name]?.push(where);
				// The not-known-stopped scan carries a status predicate (jobs) or
				// a NOT block (channels/runs, which require a CONFIRMED stop);
				// the audit-row collection carries neither and must not receive
				// the first one's answer.
				if (args?.distinct) {
					return (
						identityIds() ?? byPointer().map((row) => row.bitmovinEncodingId)
					).map((bitmovinEncodingId) => ({ bitmovinEncodingId }));
				}
				return where.status || where.NOT ? byPointer() : allPointers();
			}
			return byStatus();
		},
	);
}
const ofKind = (kind: string) => () =>
	active.allPointers.filter((p) => p.id.startsWith(kind));
/**
 * Re-wired per test, not once at module scope.
 *
 * The TOCTOU test REPLACES `encodingJob.findMany` with a call-counting stub and
 * cannot restore it (the stub is the point). At module scope that replacement
 * leaked into every test declared after it — which is how five tests in this
 * file failed on their first run for a reason that had nothing to do with what
 * they assert: they were reading "Snuck in, RUNNING" from a neighbour's mock.
 * The A1 test was simply the last one in the file when it was written.
 */
function wireFindMany() {
	(prisma.encodingJob as { findMany: unknown }).findMany = findManyFor(
		"encodingJob",
		() => active.encodingJobs,
		() => active.pointerJobs,
		ofKind("job-"),
		() => pointerIdentityIds.jobs,
	);
	(prisma.liveChannel as { findMany: unknown }).findMany = findManyFor(
		"liveChannel",
		() => active.liveChannels,
		() => active.pointerChannels,
		ofKind("chan-"),
		() => pointerIdentityIds.channels,
	);
	(prisma.liveChannelRun as { findMany: unknown }).findMany = findManyFor(
		"liveChannelRun",
		() => [],
		() => active.pointerRuns,
		ofKind("run-"),
		() => pointerIdentityIds.runs,
	);
	(prisma.watchRule as { findMany: unknown }).findMany = vi.fn(async () => [
		{ id: "wr-1", name: "masters" },
	]);
	(prisma.feederSession as { findMany: unknown }).findMany = vi.fn(
		async (args?: { where?: unknown }) => {
			feederQueries.push(args?.where);
			return active.feederSessions;
		},
	);
	(prisma.vmafJob as { findMany: unknown }).findMany = vi.fn(
		async () => active.vmafJobs,
	);
	(prisma.verificationResourceIntent as { findMany: unknown }).findMany = vi.fn(
		async () => active.verificationIntents,
	);
}

function wirePointerCounts() {
	const wire = (modelName: string, total: () => number) => {
		const current = prisma[modelName] as {
			count: ReturnType<typeof vi.fn>;
		};
		current.count = vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			args?.where?.bitmovinEncodingId ? total() : 1,
		);
	};
	wire("encodingJob", () => pointerTotals.jobs);
	wire("liveChannel", () => pointerTotals.channels);
	wire("liveChannelRun", () => pointerTotals.runs);
}

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma }),
}));
const obliterate = vi.fn(async () => {});
const forbiddenQueueOperation = vi.fn(async () => {
	throw new Error("global queue operation");
});
let pendingAfterDrain = false;
const queuePending = () => (pendingAfterDrain ? 1 : 3);
const removeJob = vi.fn(async () => {
	pendingAfterDrain = true;
});
const getJobs = vi.fn(async () => [
	{ id: "own-waiting", opts: {}, remove: removeJob },
	{ id: "own-delayed", opts: {}, remove: removeJob },
	{
		id: "repeat:sweep",
		opts: { repeat: { every: 30000 } },
		repeatJobKey: "scheduler-key",
		remove: forbiddenQueueOperation,
	},
]);
vi.mock("@/lib/server/queue", () => {
	const q = () => ({
		getJobCountByTypes: async () => queuePending(),
		getJobs,
		obliterate,
		drain: forbiddenQueueOperation,
		clean: forbiddenQueueOperation,
		pause: forbiddenQueueOperation,
		resume: forbiddenQueueOperation,
	});
	return {
		getOrchestratorQueue: q,
		getLiveChannelQueue: q,
		getVmafQueue: q,
		getFeederQueue: q,
		getStorageInspectQueue: q,
		getSlateNormalizeQueue: q,
		getNotifyQueue: q,
	};
});

import { GET, POST } from "./route";

function postRequest(body: unknown): Request {
	return new Request("http://test/api/admin/reset", {
		method: "POST",
		// The proxy stamps a verified actor on every continuing request; a
		// request WITHOUT one now refuses (#32 §4 allowlist — the missing
		// header used to fall through the startsWith denylist).
		headers: { "content-type": "application/json", [ACTOR_HEADER]: "session" },
		body: JSON.stringify(body),
	});
}

function getRequest(): Request {
	return new Request("http://test/api/admin/reset", {
		headers: { [ACTOR_HEADER]: "session" },
	});
}

const RESET_BLOCKED_ERROR = "Data reset is temporarily unavailable.";
const INTERNAL_RESET_LABELS = [
	...MODELS,
	...KEEPS,
	...PRESERVES,
	"alertRuleScoped",
	"watchRuleDisarmed",
	"encodingJobs",
	"feederSessions",
	"vmafJobs",
	"verificationIntents",
	"unstoppedEncoders",
	"channelAlertRulesToDelete",
	"disarmedWatchRules",
];

function expectNoInternalResetLabels(body: unknown) {
	const json = JSON.stringify(body);
	for (const label of INTERNAL_RESET_LABELS) {
		expect(json, `${label} must not cross the customer API`).not.toContain(
			`"${label}"`,
		);
	}
}

async function expectBoundedResetConflict(
	res: Response,
	code:
		| "RESET_ACTIVE_WORK"
		| "RESET_CLEANUP_UNCONFIRMED"
		| "RESET_LOCAL_WORK_ACTIVE"
		| "RESET_PROVIDER_RESOURCES_UNCONFIRMED"
		| "RESET_STATE_CHANGED",
) {
	expect(res.status).toBe(409);
	const body = await res.json();
	expect(body).toEqual({ error: RESET_BLOCKED_ERROR, details: { code } });
	expect(JSON.stringify(body)).not.toMatch(
		/VerificationRun|VerificationResourceIntent|verify recover|run-id|stranded|worker|\brows?\b|INSIDE|Snuck in|enc-abc|job-1/i,
	);
	return body;
}

beforeEach(() => {
	deleted.length = 0;
	updated.length = 0;
	auditCreate.mockClear();
	obliterate.mockClear();
	getJobs.mockClear();
	removeJob.mockClear();
	forbiddenQueueOperation.mockClear();
	pendingAfterDrain = false;
	transactionFailure = null;
	finishedAisaJobs = [];
	aisaCaptured = false;
	active = {
		encodingJobs: [],
		liveChannels: [],
		feederSessions: [],
		vmafJobs: [],
		verificationIntents: [],
		pointerJobs: [],
		pointerChannels: [],
		pointerRuns: [],
		allPointers: [],
	};
	pointerTotals = { jobs: 0, channels: 0, runs: 0 };
	pointerIdentityIds = {};
	for (const key of Object.keys(pointerQueries)) {
		delete pointerQueries[key];
	}
	feederQueries.length = 0;
	// Per-model mocks accumulate calls across tests otherwise, so "was this
	// kept table touched" reads a previous test's answer — the same
	// cross-test leak as the findMany replacement below.
	for (const name of [...MODELS, ...KEEPS, ...PRESERVES]) {
		const m = prisma[name] as {
			deleteMany?: { mockClear?: () => void };
			count?: { mockClear?: () => void };
		};
		m.deleteMany?.mockClear?.();
		m.count?.mockClear?.();
	}
	wireFindMany();
	wirePointerCounts();
});

describe("POST /api/admin/reset (ledger #130)", () => {
	it.each([
		"users",
		"setupCodes",
		"organizations",
		"memberships",
		"platformSettings",
	])("rejects global reset category %s before touching data", async (category) => {
		const res = await POST(
			postRequest({ confirm: "RESET", categories: [category] }),
		);
		expect(res.status).toBe(400);
		expect(deleted).toEqual([]);
		expect(auditCreate).not.toHaveBeenCalled();
	});
	it("selected history deletes only that category and leaves unrelated queues and watch folders alone", async () => {
		const res = await POST(
			postRequest({ confirm: "RESET", categories: ["auditHistory"] }),
		);
		expect(res.status).toBe(200);
		expect(deleted).toEqual(["auditLog", "accessEvent"]);
		expect(updated).toEqual([]);
		expect(getJobs).not.toHaveBeenCalled();
		expect(await res.json()).toMatchObject({
			deletedCounts: [{ category: "auditHistory", count: 2 }],
			requiresSetup: false,
			providerResources: { pointers: [], total: 0, truncated: false },
		});
	});
	it("selecting every organization category keeps all global identities and platform settings", async () => {
		const response = await POST(
			postRequest({ confirm: "RESET", categories: RESET_CATEGORIES }),
		);
		expect(response.status).toBe(200);
		for (const model of RESET_GLOBAL_MODELS) {
			expect(deleted).not.toContain(model);
			expect(
				(prisma[model] as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany,
			).not.toHaveBeenCalled();
		}
		expect(await response.json()).toMatchObject({ requiresSetup: false });
		expect(forbiddenQueueOperation).not.toHaveBeenCalled();
	});
	it("leaves Statistics jobs accepted after reset commit queued for their new generation", async () => {
		const original = prisma.$transaction as (
			fn: (tx: unknown) => Promise<unknown>,
			options?: unknown,
		) => Promise<unknown>;
		let newGenerationQueued = false;
		prisma.$transaction = async (
			fn: (tx: unknown) => Promise<unknown>,
			options?: unknown,
		) => {
			const result = await original(fn, options);
			// Model a new POST accepted between DB reset commit and post-commit cleanup.
			newGenerationQueued = true;
			return result;
		};
		try {
			const response = await POST(
				postRequest({ confirm: "RESET", categories: ["usageStatistics"] }),
			);
			expect(response.status).toBe(200);
			expect(newGenerationQueued).toBe(true);
			expect(getJobs).not.toHaveBeenCalled();
			expect(forbiddenQueueOperation).not.toHaveBeenCalled();
		} finally {
			prisma.$transaction = original;
		}
	});
	it("selected VOD deletion drains only its queue and does not report retained Live keys", async () => {
		active.allPointers = [
			{
				id: "chan-retained",
				name: "Retained",
				status: "STOPPED",
				bitmovinEncodingId: "enc-retained",
			},
		];
		const res = await POST(
			postRequest({ confirm: "RESET", categories: ["vodJobs"] }),
		);
		expect(res.status).toBe(200);
		expect(deleted).toEqual(["manifestJob", "encodingJob"]);
		expect(getJobs).toHaveBeenCalledTimes(1);
		expect(removeJob).toHaveBeenCalledTimes(2);
		expect(forbiddenQueueOperation).not.toHaveBeenCalled();
		expect(await res.json()).toMatchObject({
			providerResources: { pointers: [], total: 0 },
			temporaryStreamKeyCleanupUnconfirmed: false,
		});
	});
	it("rejects missing selection dependencies and an empty deletion request", async () => {
		for (const categories of [[], ["liveChannels"]]) {
			expect(
				(await POST(postRequest({ confirm: "RESET", categories }))).status,
			).toBe(400);
		}
		expect(deleted).toEqual([]);
	});
	it("does not mistake an older retained audit receipt for the current reset", async () => {
		const table = prisma.auditLog as { count: ReturnType<typeof vi.fn> };
		const original = table.count;
		table.count = vi.fn(async (args?: { where?: { at?: { gte?: Date } } }) =>
			args?.where?.at?.gte ? 0 : 10,
		);
		try {
			const res = await POST(
				postRequest({ confirm: "RESET", categories: ["webhookHistory"] }),
			);
			expect(res.status).toBe(200);
			expect((await res.json()).auditRecorded).toBe(false);
			expect(table.count).toHaveBeenCalledWith({
				where: {
					path: "/api/admin/reset",
					method: "POST",
					at: { gte: expect.any(Date) },
				},
			});
		} finally {
			table.count = original;
		}
	});
	it("returns the same actionable409 if a completed AISA job races the preflight", async () => {
		transactionFailure = new AisaSnapshotRequired("newly-finished-job");
		const res = await POST(postRequest({ confirm: "RESET" }));
		expect(res.status).toBe(409);
		expect((await res.json()).details.code).toBe(
			"RESET_AISA_SNAPSHOT_REQUIRED",
		);
		expect(deleted).toEqual([]);
		expect(getJobs).not.toHaveBeenCalled();
	});
	it("409s with capture guidance before any reset mutations, then accepts captured history", async () => {
		finishedAisaJobs = [
			{
				id: "job-aisa",
				bitmovinEncodingId: "encoding-aisa",
				plan: { aiSceneAnalysis: {} },
			},
		];
		const res = await POST(postRequest({ confirm: "RESET" }));
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(
			/Capture AI Scene Analysis.*Library/,
		);
		expect(deleted).toEqual([]);
		expect(updated).toEqual([]);
		expect(getJobs).not.toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
		aisaCaptured = true;
		expect((await POST(postRequest({ confirm: "RESET" }))).status).toBe(200);
		expect(deleted).toContain("encodingJob");
	});
	it("refuses without the typed confirmation", async () => {
		const res = await POST(postRequest({ confirm: "yes" }));
		expect(res.status).toBe(400);
		expect(deleted).toHaveLength(0);
	});

	it("409s with a bounded stable code when work is running", async () => {
		active.liveChannels = [
			{ id: "ch-1", name: "My Channel", status: "RUNNING" },
		];
		const res = await POST(postRequest({ confirm: "RESET" }));
		await expectBoundedResetConflict(res, "RESET_ACTIVE_WORK");
		// Nothing was deleted — the refusal is BEFORE the transaction.
		expect(deleted).toHaveLength(0);
		expect(obliterate).not.toHaveBeenCalled();
	});

	it("deletes exactly the operational models, children first, and NO configuration model", async () => {
		const res = await POST(postRequest({ confirm: "RESET" }));
		expect(res.status).toBe(200);
		// 130-B1: alertRule is KEPT, but its channel-scoped rows are deleted
		// explicitly, in dependency order like everything else — after its own
		// children, immediately before its parent. See the dedicated test
		// below for what each side of that position costs.
		const withScoped = [...MODELS];
		withScoped.splice(withScoped.indexOf("liveChannel"), 0, "alertRule");
		expect(deleted).toEqual(withScoped);
		for (const kept of KEEPS.filter((k) => k !== "alertRule")) {
			expect(
				(prisma[kept] as { deleteMany: { mock: { calls: unknown[] } } })
					.deleteMany.mock.calls,
				`${kept} must survive a reset`,
			).toHaveLength(0);
		}
		for (const evidence of PRESERVES) {
			expect(
				(prisma[evidence] as { deleteMany: { mock: { calls: unknown[] } } })
					.deleteMany.mock.calls,
				`${evidence} is recovery evidence and must survive a reset`,
			).toHaveLength(0);
		}
		// Children before parents: results before jobs, runs before channels.
		expect(deleted.indexOf("vmafResult")).toBeLessThan(
			deleted.indexOf("vmafJob"),
		);
		expect(deleted.indexOf("liveChannelRun")).toBeLessThan(
			deleted.indexOf("liveChannel"),
		);
		expect(deleted.indexOf("manifestJob")).toBeLessThan(
			deleted.indexOf("encodingJob"),
		);
	});

	it("drains the queues and writes the audit row AFTER the delete, carrying the counts", async () => {
		await POST(postRequest({ confirm: "RESET" }));
		expect(getJobs).toHaveBeenCalledTimes(7);
		expect(removeJob).toHaveBeenCalledTimes(14);
		expect(forbiddenQueueOperation).not.toHaveBeenCalled();
		// review-2 I1: NOT obliterate — it deletes the queue's repeat keys, and
		// the live-heartbeat scheduler is registered there once, at worker
		// startup. The web app cannot restore it, so it must not destroy it.
		expect(obliterate).not.toHaveBeenCalled();
		expect(auditCreate).toHaveBeenCalledTimes(1);
		const entry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: { response: { counts: { model: string; count: number }[] } };
		};
		expect(
			entry.data.response.counts.find((c) => c.model === "encodingJob")?.count,
		).toBe(1);
		// AFTER: the auditLog deleteMany ran in the transaction, and this row
		// is the first of the new history rather than a survivor of the old.
		expect(deleted).toContain("auditLog");
	});
});

describe("GET /api/admin/reset (the preview)", () => {
	it("allows an empty preview selection and counts every choice without the unrelated AISA guard", async () => {
		finishedAisaJobs = [
			{
				id: "uncaptured",
				bitmovinEncodingId: "encoder",
				plan: { aiSceneAnalysis: {} },
			},
		];
		const req = new Request("http://test/api/admin/reset?categories=", {
			headers: { [ACTOR_HEADER]: "session" },
		});
		const res = await GET(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.deleteCounts).toHaveLength(25);
		expect(body).toMatchObject({
			blocked: false,
			selectionBlocked: false,
			aisaSnapshotRequiredJobHref: null,
			watchFoldersToDisable: 0,
		});
		expect(body.deleteCounts).toContainEqual({
			category: "contentLibrary",
			count: 4,
		});
	});
	it("selected preview and deletion remain available with in-flight library work", async () => {
		const req = new Request(
			"http://test/api/admin/reset?categories=contentLibrary",
			{ headers: { [ACTOR_HEADER]: "session" } },
		);
		expect(await (await GET(req)).json()).toMatchObject({
			blocked: false,
			selectionBlocked: false,
		});
		expect(
			(
				await POST(
					postRequest({ confirm: "RESET", categories: ["contentLibrary"] }),
				)
			).status,
		).toBe(200);
		expect(deleted).toEqual([
			"contentRevision",
			"content",
			"sceneAnalysisRevision",
			"librarySource",
		]);
	});
	it("blocks on the same AISA snapshot guard as POST and links to the next job to capture", async () => {
		finishedAisaJobs = [
			{
				id: "job-aisa",
				bitmovinEncodingId: "encoding-aisa",
				plan: { aiSceneAnalysis: {} },
			},
		];
		const before = await (await GET(getRequest())).json();
		expect(before.blocked).toBe(true);
		expect(before.aisaSnapshotRequiredJobHref).toBe("/vod/jobs/job-aisa");
		expect(deleted).toEqual([]);
		expect(updated).toEqual([]);
		aisaCaptured = true;
		const after = await (await GET(getRequest())).json();
		expect(after.blocked).toBe(false);
		expect(after.aisaSnapshotRequiredJobHref).toBeNull();
	});
	it("reports only the cleanup blocker count, never release-harness details", async () => {
		active.verificationIntents = [
			{
				id: "intent-private",
				verificationRunId: "run-private",
				verificationKey: "verify:run-private:vod:VOD_JOB",
				requestSha256: "a".repeat(64),
				state: "AMBIGUOUS",
				cleanupState: "UNRESOLVED",
				possiblyCreatedKeys: ["local:job-1"],
				cleanedResourceKeys: [],
				providerIds: [],
				candidates: [],
				readback: null,
				closureDigest: null,
			},
		];
		const body = await (await GET(getRequest())).json();
		expect(body.blocked).toBe(true);
		expect(body.cleanupUnconfirmed).toBe(true);
		expect(body).not.toHaveProperty("preserves");
		expectNoInternalResetLabels(body);
		expect(JSON.stringify(body)).not.toMatch(
			/intent-private|run-private|AMBIGUOUS|UNRESOLVED|verificationResourceIntent/i,
		);
	});

	it("reports measured customer categories without Prisma model labels or local ids", async () => {
		active.encodingJobs = [{ id: "j1", name: "Nightly", status: "RUNNING" }];
		const body = await (await GET(getRequest())).json();
		expect(body.blocked).toBe(true);
		expect(body.deleteCounts).toContainEqual({ category: "vodJobs", count: 2 });
		expect(body.channelAlertsToDelete).toBe(1);
		expect(body.watchFoldersToDisable).toBe(1);
		expect(body.active.vodJobs).toEqual([
			{ name: "Nightly", status: "RUNNING", href: "/vod/jobs/j1" },
		]);
		expect(body).not.toHaveProperty("counts");
		expect(body).not.toHaveProperty("keeps");
		expect(body).not.toHaveProperty("scopedDeletes");
		expect(body).not.toHaveProperty("disarms");
		expect(JSON.stringify(body)).not.toContain('"id":"j1"');
		expectNoInternalResetLabels(body);
		expect(body.confirmation).toBe("RESET");
		expect(resetPreviewResponseSchema.safeParse(body).success).toBe(true);
	});

	it("projects an encoder pointer as a product resource without local model or row ids", async () => {
		active.pointerJobs = [
			{
				id: "private-job-row",
				name: "Nightly",
				status: "ERROR",
				bitmovinEncodingId: "provider-encoding-id",
			},
		];
		const body = await (await GET(getRequest())).json();
		expect(body.active.providerResourcesToCheck).toEqual([
			{
				resourceType: "vodJob",
				name: "Nightly",
				status: "ERROR",
				bitmovinEncodingId: "provider-encoding-id",
			},
		]);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toMatch(/private-job-row|bitmovinAccountId/);
		expect(serialized).not.toContain('"kind":"encodingJob"');
		expectNoInternalResetLabels(body);
	});

	it("reports the exact provider-resource total when the displayed list is capped at 50", async () => {
		active.pointerJobs = Array.from({ length: 50 }, (_, index) => ({
			id: `private-job-${index}`,
			name: `Nightly ${index + 1}`,
			status: "ERROR",
			bitmovinEncodingId: `enc-${index + 1}`,
		}));
		pointerTotals.jobs = 54;
		pointerTotals.channels = 2;
		pointerTotals.runs = 1;
		pointerIdentityIds.jobs = Array.from(
			{ length: 54 },
			(_, index) => `enc-${index + 1}`,
		);
		pointerIdentityIds.channels = ["live-enc-1", "live-enc-2"];
		pointerIdentityIds.runs = ["live-run-enc-1"];

		const body = await (await GET(getRequest())).json();

		expect(body.active.providerResourcesToCheck).toHaveLength(50);
		expect(body.active.totals.providerResourcesToCheck).toBe(57);
		expect(
			(prisma.encodingJob as { count: ReturnType<typeof vi.fn> }).count,
		).toHaveBeenCalledWith({
			where: {
				bitmovinEncodingId: { not: null },
				status: { notIn: [...RESET_STOPPED_JOB_STATUSES] },
				OR: [
					{ encoderStoppedConfirmedFor: null },
					{
						encoderStoppedConfirmedFor: {
							not: { equals: fieldRef("EncodingJob", "bitmovinEncodingId") },
						},
					},
				],
			},
		});
		expect(
			(prisma.liveChannel as { count: ReturnType<typeof vi.fn> }).count,
		).toHaveBeenCalledWith({
			where: {
				bitmovinEncodingId: { not: null },
				NOT: {
					status: { in: [...RESET_STOPPED_CHANNEL_STATUSES] },
					error: null,
				},
				OR: [
					{ encoderStoppedConfirmedFor: null },
					{
						encoderStoppedConfirmedFor: {
							not: { equals: fieldRef("LiveChannel", "bitmovinEncodingId") },
						},
					},
				],
			},
		});
	});

	it("counts a channel and its mirrored run as one provider resource while retaining both source pointers", async () => {
		const mirroredEncodingId = "live-encoding-mirrored";
		active.pointerChannels = [
			{
				id: "chan-current",
				name: "Morning News",
				status: "ERROR",
				bitmovinEncodingId: mirroredEncodingId,
			},
		];
		active.pointerRuns = [
			{
				id: "run-current",
				name: "Morning News run",
				status: "ERROR",
				bitmovinEncodingId: mirroredEncodingId,
			},
		];
		pointerTotals.channels = 1;
		pointerTotals.runs = 1;
		pointerIdentityIds.channels = [mirroredEncodingId];
		pointerIdentityIds.runs = [mirroredEncodingId];

		const body = await (await GET(getRequest())).json();

		expect(body.active.providerResourcesToCheck).toEqual([
			{
				resourceType: "liveChannel",
				name: "Morning News",
				status: "ERROR",
				bitmovinEncodingId: mirroredEncodingId,
			},
		]);
		expect(body.active.totals.providerResourcesToCheck).toBe(1);
		// The route projection is deduplicated, but both DB references still
		// participate in the refusal queries and remain available internally.
		expect(pointerQueries.liveChannel).toHaveLength(2);
		expect(pointerQueries.liveChannelRun).toHaveLength(2);
	});

	it("returns customer identities and links for same-status local work", async () => {
		active.feederSessions = [
			{
				id: "00000000-0000-4000-8000-0000000000f1",
				status: "PUSHING",
				sourceKey: "programs/morning.mp4",
				createdAt: new Date("2026-09-01T00:00:00.000Z"),
				liveChannel: { name: "Morning News" },
			},
			{
				id: "00000000-0000-4000-8000-0000000000f2",
				status: "PUSHING",
				sourceKey: "programs/evening.mp4",
				createdAt: new Date("2026-09-01T01:00:00.000Z"),
				liveChannel: { name: "Evening News" },
			},
		];
		active.vmafJobs = [
			{
				id: "00000000-0000-4000-8000-0000000000a1",
				status: "RUNNING",
				mode: "VOD",
				createdAt: new Date("2026-09-01T02:00:00.000Z"),
				encodingJob: { name: "September master" },
			},
			{
				id: "00000000-0000-4000-8000-0000000000a2",
				status: "RUNNING",
				mode: "LIVE",
				createdAt: new Date("2026-09-01T03:00:00.000Z"),
				encodingJob: null,
			},
		];

		const body = await (await GET(getRequest())).json();

		expect(body.active.pseudoLiveFeeds).toEqual([
			{
				channelName: "Morning News",
				sourceName: "morning.mp4",
				status: "PUSHING",
				createdAt: "2026-09-01T00:00:00.000Z",
				href: "/live/feeders/00000000-0000-4000-8000-0000000000f1",
			},
			{
				channelName: "Evening News",
				sourceName: "evening.mp4",
				status: "PUSHING",
				createdAt: "2026-09-01T01:00:00.000Z",
				href: "/live/feeders/00000000-0000-4000-8000-0000000000f2",
			},
		]);
		expect(body.active.vmafMeasurements).toEqual([
			{
				encodingName: "September master",
				mode: "VOD",
				status: "RUNNING",
				createdAt: "2026-09-01T02:00:00.000Z",
				href: "/qc/00000000-0000-4000-8000-0000000000a1",
			},
			{
				encodingName: null,
				mode: "LIVE",
				status: "RUNNING",
				createdAt: "2026-09-01T03:00:00.000Z",
				href: "/qc/00000000-0000-4000-8000-0000000000a2",
			},
		]);
		expect(JSON.stringify(body.active)).not.toContain('"id"');
	});

	it("blocks on shared feeder occupancy, including a terminal held claim, while retaining staged active holds", async () => {
		await GET(getRequest());
		expect(feederQueries).toContainEqual({
			OR: [
				{ status: { in: ["CREATED", "DOWNLOADING", "PUSHING"] } },
				feederOccupancyWhere(),
			],
		});
	});
	it("raises the transaction timeout well above Prisma's 5s default (ledger #130)", async () => {
		await POST(postRequest({ confirm: "RESET" }));
		// Fourteen tables including EncodingJob's plan/stepLog/snapshot JSON:
		// on the default the whole reset would roll back with nothing deleted,
		// on precisely the install that has enough history to need one.
		expect(txOptions?.timeout ?? 5_000).toBeGreaterThanOrEqual(60_000);
	});

	it("runs SERIALIZABLE — the third and oldest unpinned isolation line (review-32 m8)", async () => {
		// reset.ts:686 is the idiom users/[id] and setup were modelled on;
		// its own isolation option was never pinned either. All three now
		// have a from-mock discriminator; the two-connection race proof stays
		// a PROBE_DATABASE_URL integration deferral.
		await POST(postRequest({ confirm: "RESET" }));
		expect(txOptions?.isolationLevel).toBe("Serializable");
	});
});

describe("the reset's guards (review-265 130-A1/A3/A4)", () => {
	it("refuses API-TOKEN auth outright — a token must not be able to wipe the deployment", async () => {
		const tokenReq = new Request("http://test/api/admin/reset", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				// The header the proxy stamps for bearer auth.
				[ACTOR_HEADER]: "token:00000000-0000-4000-8000-0000000000t1",
			},
			body: JSON.stringify({ confirm: "RESET" }),
		});
		const res = await POST(tokenReq);
		expect(res.status).toBe(403);
		expect(deleted).toHaveLength(0);
		// And the preview is refused too — the same token must not enumerate
		// what a reset would destroy.
		expect(
			(
				await GET(
					new Request("http://test/api/admin/reset", {
						headers: {
							[ACTOR_HEADER]: "token:00000000-0000-4000-8000-0000000000t1",
						},
					}),
				)
			).status,
		).toBe(403);
	});

	it("a MISSING actor header refuses — the allowlist closed the denylist's fall-through (#32 §4)", async () => {
		const bare = new Request("http://test/api/admin/reset", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirm: "RESET" }),
		});
		expect((await POST(bare)).status).toBe(403);
		expect(deleted).toHaveLength(0);
	});

	it("users-mode and none-mode actors pass the kind allowlist — only tokens and the void are refused", async () => {
		for (const actor of ["user:00000000-0000-4000-8000-0000000000u1", "none"]) {
			const res = await GET(
				new Request("http://test/api/admin/reset", {
					headers: { [ACTOR_HEADER]: actor },
				}),
			);
			expect(res.status).toBe(200);
		}
	});

	it("409s with a bounded state-change code when work starts inside the transaction", async () => {
		// The TOCTOU window: idle at the pre-check, busy by the time the
		// deletes run (the watch sweep is a 30s timer).
		let call = 0;
		(prisma.encodingJob as { findMany: unknown }).findMany = vi.fn(
			async (args?: { where?: { status?: { in?: string[] } } }) => {
				if (!args?.where?.status?.in) return [];
				call += 1;
				return call === 1
					? []
					: [{ id: "j9", name: "Snuck in", status: "RUNNING" }];
			},
		);
		const res = await POST(postRequest({ confirm: "RESET" }));
		await expectBoundedResetConflict(res, "RESET_STATE_CHANGED");
		// Rolled back: the transaction threw, so nothing counts as deleted.
		expect(auditCreate).not.toHaveBeenCalled();
	});

	it("409s with the same bounded state-change code after a serializable retry conflict", async () => {
		transactionFailure = Object.assign(new Error("database internals"), {
			code: "P2034",
		});
		const res = await POST(postRequest({ confirm: "RESET" }));
		await expectBoundedResetConflict(res, "RESET_STATE_CHANGED");
		expect(auditCreate).not.toHaveBeenCalled();
	});
	it("reports a retryable server conflict only after selected-reset automatic retries exhaust", async () => {
		transactionFailure = Object.assign(
			new Error("could not serialize access due to concurrent update"),
			{
				code: "P2010",
				meta: { code: "40001" },
			},
		);
		const res = await POST(
			postRequest({ confirm: "RESET", categories: ["contentLibrary"] }),
		);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			error:
				"Reset could not finish because data kept changing. Retry the reset.",
		});
		expect(deleted).toEqual([]);
		expect(updated).toEqual([]);
		expect(auditCreate).not.toHaveBeenCalled();
	});

	it("classifies EVERY schema model — the next model added cannot be silently neither deleted nor kept", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const schema = readFileSync(
			join(__dirname, "../../../../../../../packages/db/prisma/schema.prisma"),
			"utf8",
		);
		const models = [...schema.matchAll(/^model (\w+) \{/gm)]
			.map((m) => m[1] ?? "")
			.map((name) => name.charAt(0).toLowerCase() + name.slice(1));
		const classified = new Set([...MODELS, ...KEEPS, ...PRESERVES]);
		expect(models.filter((m) => !classified.has(m))).toEqual([]);
		expect([...classified].filter((m) => !models.includes(m))).toEqual([]);
	});

	it("refuses reset while cleanup is unresolved without exposing the recovery dossier", async () => {
		active.verificationIntents = [
			{
				id: "intent-1",
				verificationRunId: "run-1",
				verificationKey: "verify:run-1:vod:VOD_JOB",
				requestSha256: "a".repeat(64),
				state: "TERMINAL",
				cleanupState: "CLEANED",
				possiblyCreatedKeys: ["local:job-1", "provider:enc-1"],
				cleanedResourceKeys: ["local:job-1"],
				providerIds: ["enc-1"],
				candidates: [],
				readback: { localStatus: "FINISHED", providerStatuses: ["FINISHED"] },
				closureDigest: "0".repeat(64),
			},
		];
		const res = await POST(postRequest({ confirm: "RESET" }));
		await expectBoundedResetConflict(res, "RESET_CLEANUP_UNCONFIRMED");
		expect(deleted).toHaveLength(0);
	});

	it("does not block on an intent whose terminal evidence passes the exact closure gate", async () => {
		const base = {
			id: "intent-2",
			verificationRunId: "run-2",
			verificationKey: "verify:run-2:vod:VOD_JOB",
			requestSha256: "b".repeat(64),
			state: "TERMINAL",
			cleanupState: "CLEANED",
			possiblyCreatedKeys: ["local:job-2", "provider:enc-2"],
			cleanedResourceKeys: ["local:job-2", "provider:enc-2"],
			providerIds: ["enc-2"],
			candidates: [],
			readback: { localStatus: "FINISHED", providerStatuses: ["FINISHED"] },
		};
		active.verificationIntents = [
			{ ...base, closureDigest: verificationIntentClosureDigest(base) },
		];
		const res = await POST(postRequest({ confirm: "RESET" }));
		expect(res.status).toBe(200);
	});
});

describe("configuration scoped to deleted state (review-265 130-B1)", () => {
	it("deletes channel-scoped alert rules EXPLICITLY and BEFORE their channel", async () => {
		await POST(postRequest({ confirm: "RESET" }));
		const calls = (
			prisma.alertRule as { deleteMany: { mock: { calls: unknown[][] } } }
		).deleteMany.mock.calls;
		expect(calls).toHaveLength(1);
		// Global rules (liveChannelId null) are NOT in the where clause, so they
		// survive — the promise "AlertRule is kept" holds for the rules whose
		// subject still exists.
		expect(calls[0]?.[0]).toEqual({ where: { liveChannelId: { not: null } } });
		// ORDER is the whole point, and it is bounded on BOTH sides.
		//
		// Too late (after liveChannel): the cascade from the channel has
		// already taken the rules, so this counts zero for rows that died —
		// the silent loss 130-B1 was about.
		expect(deleted.indexOf("alertRule")).toBeLessThan(
			deleted.indexOf("liveChannel"),
		);
		// Too early (before alertEvent): AlertEvent.rule is ITSELF ON DELETE
		// CASCADE, so deleting the rules first takes their events, and
		// alertEvent.deleteMany then counts zero for a table that just lost
		// rows. The first version of this fix did exactly that, and only a run
		// against a real database showed it — this mock cannot, because it
		// answers a fixed count per model regardless of what the FKs did.
		expect(deleted.indexOf("alertEvent")).toBeLessThan(
			deleted.indexOf("alertRule"),
		);
	});

	it("reports the scoped count — the operator is told what a KEPT table lost", async () => {
		await POST(postRequest({ confirm: "RESET" }));
		const entry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: { response: { counts: { model: string; count: number }[] } };
		};
		expect(
			entry.data.response.counts.find((c) => c.model === "alertRuleScoped")
				?.count,
		).toBe(1);
	});

	it("EVERY declared scoped delete has a preview count — a declaration is not an implementation", async () => {
		// The customer contract no longer returns the internal declaration, but
		// its measured count must still cross the boundary under a domain name.
		const body = await (await GET(getRequest())).json();
		expect(body.channelAlertsToDelete).toBeTypeOf("number");
	});

	it("the preview measures it too — a kept table cannot show a count it is about to lose", async () => {
		const body = await (await GET(getRequest())).json();
		expect(body.channelAlertsToDelete).toBe(1);
		expectNoInternalResetLabels(body);
	});
});

describe("rows that still name a cloud encoder (review-265 130-B2)", () => {
	const errored = {
		id: "job-1",
		name: "Failed nightly",
		status: "ERROR",
		bitmovinEncodingId: "enc-abc",
	};

	it("refuses when a row names an encoder nothing proves stopped — status says idle", async () => {
		active.pointerJobs = [errored];
		const res = await POST(postRequest({ confirm: "RESET" }));
		await expectBoundedResetConflict(
			res,
			"RESET_PROVIDER_RESOURCES_UNCONFIRMED",
		);
		expect(deleted).toHaveLength(0);
	});

	it("asks the DATABASE the right question — the predicate is the WHERE clause", async () => {
		await POST(postRequest({ confirm: "RESET" }));
		// The mock can only return what it is handed, so asserting its answer
		// would prove nothing. The filter runs in SQL; this pins the SQL.
		expect(pointerQueries.encodingJob?.[0]).toEqual({
			bitmovinEncodingId: { not: null },
			status: { notIn: [...RESET_STOPPED_JOB_STATUSES] },
			OR: [
				{ encoderStoppedConfirmedFor: null },
				{
					encoderStoppedConfirmedFor: {
						not: { equals: fieldRef("EncodingJob", "bitmovinEncodingId") },
					},
				},
			],
		});
		// The channel side asks for a CONFIRMED stop, not merely a STOPPED
		// status: the stop path used to write STOPPED with error nulled even
		// when Bitmovin never confirmed, so the status alone classified a
		// possibly-billing channel as safe to delete.
		expect(pointerQueries.liveChannel?.[0]).toEqual({
			bitmovinEncodingId: { not: null },
			NOT: {
				status: { in: [...RESET_STOPPED_CHANNEL_STATUSES] },
				error: null,
			},
			OR: [
				{ encoderStoppedConfirmedFor: null },
				{
					encoderStoppedConfirmedFor: {
						not: { equals: fieldRef("LiveChannel", "bitmovinEncodingId") },
					},
				},
			],
		});
		// Runs carry their own pointer across re-airs — a record the channel
		// scan cannot see.
		expect(pointerQueries.liveChannelRun?.[0]).toEqual({
			bitmovinEncodingId: { not: null },
			NOT: {
				status: { in: [...RESET_STOPPED_CHANNEL_STATUSES] },
				error: null,
			},
			OR: [
				{ encoderStoppedConfirmedFor: null },
				{
					encoderStoppedConfirmedFor: {
						not: { equals: fieldRef("LiveChannelRun", "bitmovinEncodingId") },
					},
				},
			],
		});
	});

	it("classifies EVERY status in both enums — a new one blocks by default", () => {
		const schema = readFileSync(
			join(__dirname, "../../../../../../../packages/db/prisma/schema.prisma"),
			"utf8",
		);
		const enumValues = (name: string) => {
			const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema);
			return (block?.[1] ?? "")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
		};
		// Three-way split, stated as the reviewer's table: blocked outright by
		// status, known-stopped, or gated on the encoder pointer.
		// CANCELED sits here, not in the stopped set: the cancel path stops the
		// encoding best-effort and persists CANCELED even when the stop call
		// failed, so the row proves intent, not outcome.
		const jobPointerGated = ["DRAFT", "ERROR", "CANCELED"];
		expect(new Set(enumValues("EncodingJobStatus"))).toEqual(
			new Set([
				...RESET_BLOCKING_JOB_STATUSES,
				...RESET_STOPPED_JOB_STATUSES,
				...jobPointerGated,
			]),
		);
		const channelPointerGated = ["CREATED", "ERROR"];
		expect(new Set(enumValues("LiveChannelStatus"))).toEqual(
			new Set([
				...RESET_BLOCKING_CHANNEL_STATUSES,
				...RESET_STOPPED_CHANNEL_STATUSES,
				...channelPointerGated,
			]),
		);
		// The pointer-gated set is the one that must not silently grow: every
		// member of it is a status where the row may or may not name a live
		// encoder, and the pointer is what decides.
		expect(jobPointerGated).not.toContain("FINISHED");
		expect(RESET_STOPPED_JOB_STATUSES).not.toContain("CANCELED");
		expect(channelPointerGated).not.toContain("STOPPED");
	});

	it("records every encoder in the audit row — stepLog, the orphan finder's source, is deleted", async () => {
		active.allPointers = [
			{
				id: "job-2",
				name: "Done",
				status: "FINISHED",
				bitmovinEncodingId: "enc-1",
			},
			{
				id: "chan-2",
				name: "Ch",
				status: "STOPPED",
				bitmovinEncodingId: "enc-2",
			},
			{
				id: "run-2",
				name: null,
				status: "STOPPED",
				bitmovinEncodingId: "enc-3",
			},
		];
		const res = await POST(postRequest({ confirm: "RESET" }));
		expect(res.status).toBe(200);
		const entry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: {
				response: {
					encoders: {
						pointers: { kind: string; bitmovinEncodingId: string }[];
						total: number;
						truncated: boolean;
					};
				};
			};
		};
		// KNOWN-STOPPED rows too: those are exactly the ones whose judgement
		// could be wrong, and after the reset nothing else can attribute them.
		// RISK-FIRST (review-265 130-C3): channels and runs ahead of jobs. Every
		// pointer that reaches this list is from a status the refusal called
		// stopped, and the channel side is where the residual risk lives — a
		// stop is only as good as its confirmation, while a FINISHED job is
		// provider-confirmed. Slicing in query order at the cap could drop
		// every channel pointer and keep 2000 job ones.
		expect(
			entry.data.response.encoders.pointers.map((p) => p.bitmovinEncodingId),
		).toEqual(["enc-2", "enc-3", "enc-1"]);
		expect(entry.data.response.encoders.pointers.map((p) => p.kind)).toEqual([
			"liveChannel",
			"liveChannelRun",
			"encodingJob",
		]);
		// The list is capped, so it carries what it would have held — a
		// truncated list that does not say so reads as complete.
		expect(entry.data.response.encoders.total).toBe(3);
		expect(entry.data.response.encoders.truncated).toBe(false);
	});
});

describe("kept configuration that would act on the wiped world (review-2 C1)", () => {
	it("disarms every enabled watch rule, in the same transaction as the deletes", async () => {
		await POST(postRequest({ confirm: "RESET" }));
		// WatchedObject is the at-most-once record. Deleting it while the rules
		// stay enabled makes the 30s sweep re-detect every object under every
		// watched prefix and submit a PAID encoding for each — the effect the
		// re-arm route refuses to cause for a single object.
		expect(updated).toEqual([
			[
				"watchRule",
				{
					where: { enabled: true },
					data: {
						enabled: false,
						scanCursor: null,
						// : the stamp that makes re-enabling ask first.
						disarmedByResetAt: expect.any(Date),
					},
				},
			],
		]);
		// The scan cursor goes too: a kept cursor would resume a re-scan from
		// an arbitrary page rather than from the top.
		const entry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: { response: { counts: { model: string; count: number }[] } };
		};
		expect(
			entry.data.response.counts.find((c) => c.model === "watchRuleDisarmed")
				?.count,
		).toBe(1);
	});

	it("the preview says how many rules will be switched off", async () => {
		const body = await (await GET(getRequest())).json();
		expect(body.watchFoldersToDisable).toBe(1);
		expectNoInternalResetLabels(body);
	});
});

describe("the audit row's numbers survive redaction (review-2 I2)", () => {
	it("every count reaches the audit row as a NUMBER — model names are values, not keys", async () => {
		const { redactSecrets } = await import("@bitovp/core");
		await POST(postRequest({ confirm: "RESET" }));
		const entry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: { response: unknown };
		};
		// The real redactor, over the real payload shape. As an OBJECT keyed by
		// model, `feederSession` matched SENSITIVE_SUFFIX's `session$` and was
		// persisted as "[REDACTED]" — one of fifteen numbers, in the one record
		// that survives a reset, in a design whose stated property is that the
		// audit row cannot disagree with what happened.
		const redacted = redactSecrets(entry.data.response) as {
			counts: { model: string; count: unknown }[];
		};
		const notNumbers = redacted.counts.filter(
			(c) => typeof c.count !== "number",
		);
		expect(notNumbers).toEqual([]);
		expect(redacted.counts.map((c) => c.model)).toContain("feederSession");
	});
});

describe("the report of what happened (review-2 N1/N2/N4)", () => {
	it("deduplicates a mirrored live provider identity without dropping its audit source pointers", async () => {
		active.allPointers = [
			{
				id: "chan-mirror",
				name: "Morning News",
				status: "STOPPED",
				bitmovinEncodingId: "enc-live-one",
			},
			{
				id: "run-mirror",
				name: null,
				status: "STOPPED",
				bitmovinEncodingId: "enc-live-one",
			},
		];

		const body = await (await POST(postRequest({ confirm: "RESET" }))).json();

		expect(body.providerResources).toEqual({
			pointers: [
				{
					resourceType: "liveChannel",
					name: "Morning News",
					status: "STOPPED",
					bitmovinEncodingId: "enc-live-one",
				},
			],
			total: 1,
			truncated: false,
		});
		const auditEntry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: { response: { encoders: { pointers: { kind: string }[] } } };
		};
		expect(
			auditEntry.data.response.encoders.pointers.map((row) => row.kind),
		).toEqual(["liveChannel", "liveChannelRun"]);
	});

	it("returns a bounded customer contract while the audit keeps the exact internal dossier", async () => {
		active.allPointers = [
			{
				id: "job-private-row",
				name: "Nightly",
				status: "FINISHED",
				bitmovinEncodingId: "provider-encoding-id",
			},
		];
		const res = await POST(postRequest({ confirm: "RESET" }));
		const body = await res.json();

		expect(body).not.toHaveProperty("counts");
		expect(body).not.toHaveProperty("drained");
		expect(body).not.toHaveProperty("streamKeys");
		expect(body.queueCleanupIncomplete).toBe(false);
		expect(body.providerResources).toEqual({
			pointers: [
				{
					resourceType: "vodJob",
					name: "Nightly",
					status: "FINISHED",
					bitmovinEncodingId: "provider-encoding-id",
				},
			],
			total: 1,
			truncated: false,
		});
		expect(body.disabledWatchFolders).toEqual([{ name: "masters" }]);
		expect(JSON.stringify(body)).not.toContain("job-private-row");
		expectNoInternalResetLabels(body);
		expect(resetPostResponseSchema.safeParse(body).success).toBe(true);

		const auditEntry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: {
				response: {
					counts: { model: string; count: number }[];
					drained: Record<string, number | null>;
					encoders: { pointers: { id: string; kind: string }[] };
				};
			};
		};
		// Internal recovery evidence remains exact and is deliberately confined
		// to the administrator audit trail rather than crossing the customer API.
		expect(auditEntry.data.response.counts).toContainEqual({
			model: "encodingJob",
			count: 1,
		});
		expect(auditEntry.data.response.drained.orchestrator).toBe(2);
		expect(auditEntry.data.response.encoders.pointers[0]).toMatchObject({
			id: "job-private-row",
			kind: "encodingJob",
		});
	});

	it("keeps exact drain measurements in the audit and returns only cleanup certainty", async () => {
		const res = await POST(postRequest({ confirm: "RESET" }));
		const body = await res.json();
		// The harness models a queue holding 3 pending jobs, of which drain
		// removes 2 — it leaves ACTIVE jobs and the scheduler-owned delayed job
		// alone, which is exactly why I1's fix is safe. Reporting the
		// before-count would claim the live-heartbeat occurrence was dropped on
		// every deployment whose worker has ever booted: 130-A5, restored by
		// I1's fix. A delta cannot drift with the mechanism.
		expect(body.queueCleanupIncomplete).toBe(false);
		expect(body).not.toHaveProperty("drained");
		const entry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: { response: { drained: Record<string, number | null> } };
		};
		expect(entry.data.response.drained.orchestrator).toBe(2);
	});

	it("returns only a cleanup-certainty boolean for temporary stream keys", async () => {
		active.allPointers = [
			{
				id: "chan-without-account",
				name: "Historical live encode",
				status: "STOPPED",
				bitmovinEncodingId: "enc-stream-key-check",
			},
		];

		const body = await (await POST(postRequest({ confirm: "RESET" }))).json();

		expect(body.temporaryStreamKeyCleanupUnconfirmed).toBe(true);
		expect(body).not.toHaveProperty("temporaryStreamKeyCleanup");
		expect(JSON.stringify(body)).not.toMatch(
			/released|failed|skippedNoAccount|accountErrors/,
		);
	});

	it("does not claim temporary live-key uncertainty for a VOD-only pointer without an account", async () => {
		active.allPointers = [
			{
				id: "job-vod-only",
				name: "VOD only",
				status: "FINISHED",
				bitmovinEncodingId: "enc-vod-only",
			},
		];

		const body = await (await POST(postRequest({ confirm: "RESET" }))).json();

		expect(body.temporaryStreamKeyCleanupUnconfirmed).toBe(false);
	});

	it("does not turn a truncated VOD-only history into a live stream-key warning", async () => {
		active.allPointers = Array.from(
			{ length: ENCODER_POINTER_RECORD_LIMIT + 1 },
			(_, index) => ({
				id: `job-vod-${index}`,
				name: `VOD ${index}`,
				status: "FINISHED",
				bitmovinEncodingId: `enc-vod-${index}`,
			}),
		);

		const body = await (await POST(postRequest({ confirm: "RESET" }))).json();

		expect(body.providerResources.truncated).toBe(true);
		expect(body.temporaryStreamKeyCleanupUnconfirmed).toBe(false);
	});

	it("returns a stable unconfirmed report after commit when the constructed customer report is invalid", async () => {
		active.allPointers = [
			{
				id: "job-future-status",
				name: "Future status",
				status: "FUTURE_STATUS",
				bitmovinEncodingId: "enc-future-status",
			},
		];

		const res = await POST(postRequest({ confirm: "RESET" }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ reportStatus: "unconfirmed" });
		expect(deleted).toContain("encodingJob");
		expect(auditCreate).toHaveBeenCalledTimes(1);
	});

	it("names the watch rules it switched off — a count cannot be undone", async () => {
		const res = await POST(postRequest({ confirm: "RESET" }));
		const body = await res.json();
		expect(body.disabledWatchFolders).toEqual([{ name: "masters" }]);
		const entry = auditCreate.mock.calls[0]?.[0] as unknown as {
			data: {
				response: { disarmedWatchRules: { id: string; name: string }[] };
			};
		};
		expect(entry.data.response.disarmedWatchRules[0]).toEqual({
			id: "wr-1",
			name: "masters",
		});
	});

	it("a failed audit READ-BACK cannot fail a reset that already happened", async () => {
		const count = (prisma.auditLog as { count: unknown }).count;
		(prisma.auditLog as { count: unknown }).count = vi.fn(async () => {
			throw new Error("connection reset");
		});
		try {
			const res = await POST(postRequest({ confirm: "RESET" }));
			// The deletes committed and the queues drained; a blip on one
			// verification query must not turn that into a 500 and discard the
			// response body — which is the operator's only readable copy of the
			// encoder pointers, the very thing this read-back exists to protect.
			expect(res.status).toBe(200);
			// And a failed READ is not evidence of a failed WRITE: it must not
			// tell the operator the row is missing.
			expect((await res.json()).auditRecorded).toBe("unknown");
		} finally {
			(prisma.auditLog as { count: unknown }).count = count;
		}
	});
});

describe("the 409 gives the UI a stable remediation reason", () => {
	it("classifies VMAF-only work as local without returning its row", async () => {
		active.vmafJobs = [
			{
				id: "v1",
				status: "RUNNING",
				mode: "VOD",
				createdAt: new Date("2026-09-01T02:00:00.000Z"),
				encodingJob: { name: "VMAF source" },
			},
		];
		const res = await POST(postRequest({ confirm: "RESET" }));
		await expectBoundedResetConflict(res, "RESET_LOCAL_WORK_ACTIVE");
	});

	it("classifies mixed local and provider work as general active work", async () => {
		// The owner's measured deployment: 1 VMAF row, 54 pointer rows. The
		// first cut of #133's fix would have told them nothing runs on
		// Bitmovin while 54 rows needed checking there — #133's own defect
		// with the polarity flipped, in the reporter's own environment.
		active.vmafJobs = [
			{
				id: "v1",
				status: "RUNNING",
				mode: "VOD",
				createdAt: new Date("2026-09-01T02:00:00.000Z"),
				encodingJob: { name: "VMAF source" },
			},
		];
		active.pointerJobs = [
			{
				id: "job-1",
				name: "old",
				status: "ERROR",
				bitmovinEncodingId: "enc-1",
			},
		];
		await expectBoundedResetConflict(
			await POST(postRequest({ confirm: "RESET" })),
			"RESET_ACTIVE_WORK",
		);
	});
});
