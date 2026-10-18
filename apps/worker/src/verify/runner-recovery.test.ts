import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { sealReport } from "./harness-rails";
import {
	EVIDENCE_VERSION,
	type ResumeEvidenceManifest,
} from "./resume-evidence";
import {
	formatRecoveryCommandResult,
	type RunReport,
	recoverVerificationRun,
} from "./runner";

const KEY_ID = "key-a";
const KEY = "release-key-material";
const sha256 = (value: string): string =>
	createHash("sha256").update(value).digest("hex");
const isRecordIncrement = (value: unknown): value is { increment: number } =>
	typeof value === "object" &&
	value !== null &&
	"increment" in value &&
	typeof (value as { increment?: unknown }).increment === "number";

function sealedAuthority(
	reportPath: string,
	overrides: Record<string, unknown> = {},
) {
	const reportMarkdown = "# sealed-run\n\nPASS: 1\n";
	const retentionUntil = new Date("2027-01-01T00:00:00.000Z");
	const fingerprint = {
		commit: "a".repeat(40),
		checkoutLatestMigration: "20260901030000_verification_report_authority",
		dbLatestMigration: "20260901030000_verification_report_authority",
		drift: false,
	};
	const outcomes: RunReport["outcomes"] = [
		{ scenario: "fixed", verdict: "PASS", reason: "verified" },
	];
	const counts = { PASS: 1, WARN: 0, FAIL: 0, SKIP: 0, INVALID: 0 };
	const evidenceManifest: ResumeEvidenceManifest = {
		version: EVIDENCE_VERSION,
		scenarios: [
			{
				scenario: "fixed",
				planFile: "fixed.plan.json",
				planSha256: "b".repeat(64),
				reportFile: "fixed.report.json",
				reportSha256: "c".repeat(64),
			},
		],
	};
	const report: RunReport = {
		runId: "sealed-run",
		startedAt: "2026-09-01T00:00:00.000Z",
		finishedAt: "2026-09-01T00:01:00.000Z",
		fingerprint,
		preflight: [
			{
				capability: "S3",
				satisfied: true,
				evidence: "input and output buckets listed",
			},
		],
		outcomes,
		counts,
		evidence: {
			version: EVIDENCE_VERSION,
			algorithm: "HMAC_SHA256",
			keyId: KEY_ID,
			retentionUntil: retentionUntil.toISOString(),
			manifest: evidenceManifest,
			reportMarkdownSha256: sha256(reportMarkdown),
		},
		resourceIntents: [],
	};
	const reportJson = `${JSON.stringify(report, null, "\t")}\n`;
	return {
		id: "33333333-3333-4333-8333-333333333333",
		runId: "sealed-run",
		status: "SEALED",
		sealedAt: new Date("2026-09-01T00:00:00.000Z"),
		reportPath,
		reportJson,
		reportMarkdown,
		reportSha256: sha256(reportJson),
		seal: sealReport(reportJson, KEY),
		sealAlgorithm: "HMAC_SHA256",
		sealKeyId: KEY_ID,
		evidenceVersion: EVIDENCE_VERSION,
		retentionUntil,
		...fingerprint,
		bitmovinAccountId: null,
		outcomes,
		counts,
		evidenceManifest,
		resumedFromId: null,
		recoveryOwner: null,
		recoveryLeaseUntil: null,
		recoveryGeneration: 0,
		intents: [],
		liveEvidence: [],
		...overrides,
	};
}

const releaseAuthorityConfig = (prisma: AppPrismaClient) => ({
	prisma,
	baseUrl: "http://127.0.0.1:3100",
	releaseMode: true,
	sealKeyring: { activeKeyId: KEY_ID, keys: { [KEY_ID]: KEY } },
});

describe("recoverVerificationRun — restart entrypoint", () => {
	it("reopens the existing DB run, performs no create, and leaves recovery evidence INCOMPLETE", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-recover-run-"));
		const reportPath = join(dir, "report.json");
		const events: Record<string, unknown>[] = [];
		const intent = {
			id: "11111111-1111-4111-8111-111111111111",
			scenario: "never-sent-before-kill",
			kind: "VOD_JOB",
			verificationKey: "verify:old-run:never-sent-before-kill:VOD_JOB",
			requestSha256: "a".repeat(64),
			resourceName: "never-sent-before-kill [verify old-run]",
			state: "PREPARED",
			localId: null,
			providerId: null,
			providerIds: [] as string[],
			candidates: null as unknown,
			cleanupState: "PENDING",
			readback: null as unknown,
			possiblyCreatedKeys: [] as string[],
			cleanedResourceKeys: [] as string[],
			closureDigest: null as string | null,
			recoveryOwner: null as string | null,
			recoveryLeaseUntil: null as Date | null,
			recoveryGeneration: 0,
			eventSeq: 0,
		};
		const runState = {
			id: "22222222-2222-4222-8222-222222222222",
			status: "INCOMPLETE",
			reportPath,
			recoveryOwner: null as string | null,
			recoveryLeaseUntil: null as Date | null,
			recoveryGeneration: 0,
			intents: [],
			liveEvidence: [],
		};
		let runUpdateCalls = 0;
		let failAllRunUpdates = false;
		const runUpdate = vi.fn(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				runUpdateCalls += 1;
				if (failAllRunUpdates || runUpdateCalls === 1) {
					throw new Error("transient run demotion write failed");
				}
				if (
					(where.status !== undefined && where.status !== runState.status) ||
					(where.recoveryGeneration !== undefined &&
						where.recoveryGeneration !== runState.recoveryGeneration) ||
					(typeof where.recoveryOwner === "string" &&
						where.recoveryOwner !== runState.recoveryOwner)
				) {
					return { count: 0 };
				}
				if (typeof data.status === "string") runState.status = data.status;
				if ("recoveryOwner" in data) {
					runState.recoveryOwner = data.recoveryOwner as string | null;
				}
				if ("recoveryLeaseUntil" in data) {
					runState.recoveryLeaseUntil = data.recoveryLeaseUntil as Date | null;
				}
				if (isRecordIncrement(data.recoveryGeneration)) {
					runState.recoveryGeneration += Number(
						data.recoveryGeneration.increment,
					);
				}
				return { count: 1 };
			},
		);
		const paidCreate = vi.fn(async () => {
			throw new Error("recovery must not create an intent or paid resource");
		});
		const loadSealKeyring = vi.fn(() => {
			throw new Error("malformed seal configuration must not block teardown");
		});
		const tx = {
			verificationRun: { updateMany: runUpdate },
			verificationResourceIntent: {
				create: paidCreate,
				findMany: async () =>
					intent.state === "SUBMITTED" &&
					intent.recoveryOwner?.startsWith("verify-dispatch:")
						? [{ verificationKey: intent.verificationKey }]
						: [],
				findUniqueOrThrow: async () => ({
					eventSeq: intent.eventSeq,
					state: intent.state,
					recoveryOwner: intent.recoveryOwner,
					recoveryLeaseUntil: intent.recoveryLeaseUntil,
					recoveryGeneration: intent.recoveryGeneration,
				}),
				updateMany: async ({ data }: { data: Record<string, unknown> }) => {
					intent.eventSeq += 1;
					if (data.recoveryGeneration) {
						intent.recoveryGeneration += 1;
						intent.recoveryOwner = data.recoveryOwner as string;
						intent.recoveryLeaseUntil = data.recoveryLeaseUntil as Date;
					} else {
						for (const [key, value] of Object.entries(data)) {
							if (key !== "eventSeq") {
								(intent as unknown as Record<string, unknown>)[key] = value;
							}
						}
					}
					return { count: 1 };
				},
			},
			verificationResourceIntentEvent: {
				create: async ({ data }: { data: Record<string, unknown> }) => {
					events.push({
						...data,
						createdAt: new Date("2026-08-31T01:00:00Z"),
					});
					return { id: `event-${events.length}` };
				},
			},
		};
		const prisma = {
			$transaction: async (callback: (transaction: typeof tx) => unknown) =>
				callback(tx),
			verificationRun: {
				findUnique: async () => ({ ...runState }),
				updateMany: runUpdate,
			},
			verificationResourceIntent: {
				findMany: async () => [{ ...intent, events: [...events] }],
			},
			encodingJob: {
				findUnique: async () => null,
				findMany: async () => [],
			},
			liveChannel: {
				findUnique: async () => null,
				findMany: async () => [],
			},
		} as unknown as AppPrismaClient;
		try {
			const result = await recoverVerificationRun(
				{
					prisma,
					baseUrl: "http://127.0.0.1:3100",
					loadSealKeyring,
				},
				"old-run",
				{
					owner: "restart-process",
					now: () => new Date("2026-08-31T01:00:00Z").getTime(),
					resolvers: {
						VOD_JOB: async () => {
							throw new Error("PREPARED/never-sent must not resolve");
						},
						LIVE_CHANNEL: async () => {
							throw new Error("wrong resolver");
						},
					},
				},
			);
			expect(result.sealable).toBe(true);
			expect(
				(result as typeof result & { authorityFenced: boolean })
					.authorityFenced,
			).toBe(true);
			expect(result.dossier[0]).toMatchObject({
				state: "TERMINAL",
				cleanupState: "NEVER_CREATED",
				possiblyCreatedKeys: [],
				cleanedResourceKeys: [],
			});
			expect(paidCreate).not.toHaveBeenCalled();
			expect(loadSealKeyring).not.toHaveBeenCalled();
			expect(events.map((event) => event.eventType)).toEqual([
				"RECOVERY_CLAIMED",
				"NEVER_SENT_RECOVERY",
			]);
			expect(runUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						id: "22222222-2222-4222-8222-222222222222",
						status: "INCOMPLETE",
					}),
					data: expect.objectContaining({ status: "INCOMPLETE" }),
				}),
			);
			expect(runUpdate).toHaveBeenCalledTimes(3);
			const evidence = JSON.parse(
				await readFile(join(dir, "resource-intent-recovery.json"), "utf8"),
			) as { sealable: boolean; resourceIntents: unknown[] };
			expect(evidence.sealable).toBe(true);
			expect(evidence.resourceIntents).toHaveLength(1);

			// If neither the pre-teardown nor post-teardown run fence can land,
			// cleanup still completes, but the command must be non-zero/no-authority.
			failAllRunUpdates = true;
			runUpdateCalls = 0;
			runUpdate.mockClear();
			runState.status = "INCOMPLETE";
			runState.recoveryOwner = null;
			runState.recoveryLeaseUntil = null;
			runState.recoveryGeneration = 0;
			intent.state = "PREPARED";
			intent.localId = null;
			intent.providerId = null;
			intent.providerIds = [];
			intent.candidates = null;
			intent.cleanupState = "PENDING";
			intent.readback = null;
			intent.possiblyCreatedKeys = [];
			intent.cleanedResourceKeys = [];
			intent.closureDigest = null;
			intent.recoveryOwner = null;
			intent.recoveryLeaseUntil = null;
			intent.recoveryGeneration = 0;
			intent.eventSeq = 0;
			events.splice(0);
			const unfenced = await recoverVerificationRun(
				{
					prisma,
					baseUrl: "http://127.0.0.1:3100",
					loadSealKeyring,
				},
				"old-run",
				{
					owner: "restart-process-2",
					now: () => new Date("2026-08-31T01:05:00Z").getTime(),
					resolvers: {
						VOD_JOB: async () => {
							throw new Error("PREPARED/never-sent must not resolve");
						},
						LIVE_CHANNEL: async () => {
							throw new Error("wrong resolver");
						},
					},
				},
			);
			expect(unfenced.sealable).toBe(true);
			expect(unfenced.authorityFenced).toBe(false);
			expect(unfenced.dossier[0]).toMatchObject({
				state: "TERMINAL",
				cleanupState: "NEVER_CREATED",
			});
			expect(formatRecoveryCommandResult(unfenced).code).toBe(1);
			expect(formatRecoveryCommandResult(unfenced).message).toContain(
				"could not durably fence",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("restores all canonical exports from an already-SEALED self-contained DB row", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-recover-sealed-"));
		const reportPath = join(dir, "report.json");
		const row = sealedAuthority(reportPath);
		const runUpdate = vi.fn(async () => ({}));
		const prisma = {
			verificationRun: {
				findUnique: async () => row,
				update: runUpdate,
			},
			verificationResourceIntent: {
				findMany: async () => [],
			},
		} as unknown as AppPrismaClient;
		try {
			const result = await recoverVerificationRun(
				releaseAuthorityConfig(prisma),
				"sealed-run",
				{
					owner: "restart-process",
					now: () => new Date("2026-09-01T01:00:00Z").getTime(),
					resolvers: {
						VOD_JOB: async () => {
							throw new Error("no intent should resolve");
						},
						LIVE_CHANNEL: async () => {
							throw new Error("no intent should resolve");
						},
					},
				},
			);
			expect(result.lines).toContain(
				"self-contained SEALED report exports restored from DB authority",
			);
			expect(runUpdate).not.toHaveBeenCalled();
			expect(result.reportExports).toBe("RESTORED");
			expect(await readFile(reportPath, "utf8")).toBe(row.reportJson);
			expect(await readFile(join(dir, "report.md"), "utf8")).toBe(
				row.reportMarkdown,
			);
			expect(await readFile(join(dir, "report.seal"), "utf8")).toBe(
				`${row.seal}\n`,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("defers atomically when SUBMITTED leases after the child pre-read but before the parent recovery claim", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-recover-dispatch-race-"));
		const reportPath = join(dir, "report.json");
		const now = new Date("2026-09-01T01:00:00.000Z");
		const runState = {
			id: "66666666-6666-4666-8666-666666666666",
			runId: "dispatch-race",
			status: "RUNNING",
			reportPath,
			recoveryOwner: null as string | null,
			recoveryLeaseUntil: null as Date | null,
			recoveryGeneration: 0,
			intents: [],
			liveEvidence: [],
		};
		const dispatchBearer =
			"verify-dispatch:TOKEN-CANARY-MUST-NEVER-LEAVE-THE-DATABASE";
		const intent = {
			id: "77777777-7777-4777-8777-777777777777",
			scenario: "vod-dispatch-race",
			kind: "VOD_JOB",
			verificationKey: "verify:dispatch-race:vod-dispatch-race:VOD_JOB",
			requestSha256: "a".repeat(64),
			resourceName: "vod-dispatch-race [verify dispatch-race]",
			state: "PREPARED",
			localId: null,
			providerId: null,
			providerIds: [] as string[],
			candidates: null,
			cleanupState: "PENDING",
			readback: null,
			possiblyCreatedKeys: [] as string[],
			cleanedResourceKeys: [] as string[],
			closureDigest: null,
			error: null,
			recoveryOwner: null as string | null,
			recoveryLeaseUntil: null as Date | null,
			recoveryGeneration: 0,
			events: [
				{
					sequence: 1,
					eventType: "RECOVERY_CLAIMED",
					fromState: "SUBMITTED",
					toState: "SUBMITTED",
					cleanupState: "PENDING",
					details: {
						owner: dispatchBearer,
						generation: 1,
						leaseUntil: new Date(now.getTime() + 60_000).toISOString(),
					},
					createdAt: now,
				},
			],
		};
		let outerListCalls = 0;
		let transactionStarted = false;
		const parentUpdates: Record<string, unknown>[] = [];
		const runUpdate = async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			parentUpdates.push({ where, data });
			if (
				where.status !== runState.status ||
				where.recoveryGeneration !== runState.recoveryGeneration
			) {
				return { count: 0 };
			}
			runState.status = data.status as string;
			runState.recoveryOwner = data.recoveryOwner as string | null;
			runState.recoveryLeaseUntil = data.recoveryLeaseUntil as Date | null;
			runState.recoveryGeneration += 1;
			return { count: 1 };
		};
		const tx = {
			verificationRun: { updateMany: runUpdate },
			verificationResourceIntent: {
				findMany: async () =>
					intent.state === "SUBMITTED" &&
					intent.recoveryOwner?.startsWith("verify-dispatch:") &&
					intent.recoveryLeaseUntil &&
					intent.recoveryLeaseUntil > now
						? [{ verificationKey: intent.verificationKey }]
						: [],
			},
		};
		const prisma = {
			$transaction: async (
				callback: (transaction: typeof tx) => Promise<unknown>,
			) => {
				transactionStarted = true;
				// Exact adversarial order: recovery already consumed its first child
				// snapshot; the producer now commits SUBMITTED + its dispatch lease.
				intent.state = "SUBMITTED";
				intent.recoveryOwner = dispatchBearer;
				intent.recoveryLeaseUntil = new Date(now.getTime() + 60_000);
				intent.recoveryGeneration = 1;
				const savedRun = { ...runState };
				try {
					return await callback(tx);
				} catch (err) {
					Object.assign(runState, savedRun);
					throw err;
				}
			},
			verificationRun: {
				findUnique: async () => ({ ...runState }),
				updateMany: runUpdate,
			},
			verificationResourceIntent: {
				findMany: async () => {
					outerListCalls += 1;
					return [{ ...intent }];
				},
			},
		} as unknown as AppPrismaClient;
		try {
			const resolver = vi.fn(async () => {
				throw new Error("recovery must not touch an in-flight dispatch");
			});
			const result = await recoverVerificationRun(
				{
					prisma,
					baseUrl: "http://127.0.0.1:3100",
				},
				"dispatch-race",
				{
					now: () => now.getTime(),
					resolvers: { VOD_JOB: resolver, LIVE_CHANNEL: resolver },
				},
			);

			expect(transactionStarted).toBe(true);
			expect(outerListCalls).toBeGreaterThanOrEqual(2);
			expect(parentUpdates[0]?.where).toMatchObject({ status: "RUNNING" });
			expect(runState).toMatchObject({
				status: "RUNNING",
				recoveryGeneration: 0,
				recoveryOwner: null,
			});
			expect(intent.state).toBe("SUBMITTED");
			expect(resolver).not.toHaveBeenCalled();
			expect(result.authorityFenced).toBe(false);
			expect(result.lines.join(" ")).toMatch(/recovery deferred/);
			expect(result.dossier[0]).toMatchObject({
				state: "SUBMITTED",
				recoveryOwner: REDACTED,
				events: [{ details: { owner: REDACTED } }],
			});
			expect(JSON.stringify(result.dossier)).not.toContain(dispatchBearer);
			const recoveryExport = await readFile(
				join(dir, "resource-intent-recovery.json"),
				"utf8",
			);
			expect(recoveryExport).not.toContain(dispatchBearer);
			expect(JSON.parse(recoveryExport)).toMatchObject({
				resourceIntents: [
					{
						recoveryOwner: REDACTED,
						events: [{ details: { owner: REDACTED } }],
					},
				],
			});
			// Export redaction must not mutate the database-authoritative fence.
			expect(intent.recoveryOwner).toBe(dispatchBearer);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("loses the RUNNING recovery CAS to a concurrent exact SEALED producer and preserves that authority", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-recover-seal-race-"));
		const reportPath = join(dir, "report.json");
		const sealed = sealedAuthority(reportPath);
		const openIntent = {
			id: "55555555-5555-4555-8555-555555555555",
			scenario: "dispatch-finishing",
			kind: "VOD_JOB",
			verificationKey: "verify:sealed-run:dispatch-finishing:VOD_JOB",
			requestSha256: "a".repeat(64),
			resourceName: "dispatch-finishing [verify sealed-run]",
			state: "SUBMITTED",
			localId: null,
			providerId: null,
			providerIds: [] as string[],
			candidates: null,
			cleanupState: "PENDING",
			readback: null,
			possiblyCreatedKeys: [] as string[],
			cleanedResourceKeys: [] as string[],
			closureDigest: null,
			error: null,
			recoveryOwner: null,
			recoveryLeaseUntil: null,
			recoveryGeneration: 0,
			events: [],
		};
		let status = "RUNNING";
		let recoveryGeneration = 0;
		let recoveryOwner: string | null = null;
		let producerSealed = false;
		let listCalls = 0;
		const updates: Array<{
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}> = [];
		const runUpdate = async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			updates.push({ where, data });
			if (!producerSealed) {
				// The producer closes its last intent and commits exact SEALED after
				// recovery's reads but before recovery's claim linearizes.
				producerSealed = true;
				status = "SEALED";
			}
			if (
				(where.status !== undefined && where.status !== status) ||
				(where.recoveryGeneration !== undefined &&
					where.recoveryGeneration !== recoveryGeneration) ||
				(typeof where.recoveryOwner === "string" &&
					where.recoveryOwner !== recoveryOwner)
			) {
				return { count: 0 };
			}
			if (typeof data.status === "string") status = data.status;
			if ("recoveryOwner" in data) {
				recoveryOwner = data.recoveryOwner as string | null;
			}
			if (isRecordIncrement(data.recoveryGeneration)) {
				recoveryGeneration += data.recoveryGeneration.increment;
			}
			return { count: 1 };
		};
		const findIntents = async () => {
			listCalls += 1;
			return listCalls === 1 ? [openIntent] : [];
		};
		const tx = {
			verificationRun: { updateMany: runUpdate },
			verificationResourceIntent: { findMany: findIntents },
		};
		const prisma = {
			$transaction: async (callback: (transaction: typeof tx) => unknown) =>
				callback(tx),
			verificationRun: {
				findUnique: async () => ({ ...sealed, status }),
				updateMany: runUpdate,
			},
			verificationResourceIntent: {
				findMany: findIntents,
			},
		} as unknown as AppPrismaClient;
		try {
			const result = await recoverVerificationRun(
				releaseAuthorityConfig(prisma),
				"sealed-run",
				{
					now: () => new Date("2026-09-01T01:00:00Z").getTime(),
					resolvers: {
						VOD_JOB: async () => {
							throw new Error("the concurrently sealed population is closed");
						},
						LIVE_CHANNEL: async () => {
							throw new Error("wrong resolver");
						},
					},
				},
			);

			expect(updates[0]?.where).toMatchObject({ status: "RUNNING" });
			expect(status).toBe("SEALED");
			expect(result.authorityFenced).toBe(true);
			expect(result.reportExports).toBe("RESTORED");
			expect(await readFile(reportPath, "utf8")).toBe(sealed.reportJson);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("never republishes green exports after an open intent demotes a SEALED row", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-recover-demoted-"));
		const reportPath = join(dir, "report.json");
		const row = sealedAuthority(reportPath);
		const intent = {
			id: "44444444-4444-4444-8444-444444444444",
			scenario: "never-sent-before-kill",
			kind: "VOD_JOB",
			verificationKey: "verify:sealed-run:never-sent-before-kill:VOD_JOB",
			requestSha256: "a".repeat(64),
			resourceName: "never-sent-before-kill [verify sealed-run]",
			state: "PREPARED",
			localId: null,
			providerId: null,
			providerIds: [] as string[],
			candidates: null as unknown,
			cleanupState: "PENDING",
			readback: null as unknown,
			possiblyCreatedKeys: [] as string[],
			cleanedResourceKeys: [] as string[],
			closureDigest: null as string | null,
			recoveryOwner: null as string | null,
			recoveryLeaseUntil: null as Date | null,
			recoveryGeneration: 0,
			eventSeq: 0,
		};
		const updates: Record<string, unknown>[] = [];
		const mutations: string[] = [];
		let finalStatus = "SEALED";
		let runRecoveryGeneration = 0;
		let runRecoveryOwner: string | null = null;
		let runRecoveryLeaseUntil: Date | null = null;
		const runUpdate = async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			mutations.push("run-demotion");
			updates.push(data);
			if (
				(where.status !== undefined && where.status !== finalStatus) ||
				(where.recoveryGeneration !== undefined &&
					where.recoveryGeneration !== runRecoveryGeneration) ||
				(typeof where.recoveryOwner === "string" &&
					where.recoveryOwner !== runRecoveryOwner)
			) {
				return { count: 0 };
			}
			if (typeof data.status === "string") finalStatus = data.status;
			if ("recoveryOwner" in data) {
				runRecoveryOwner = data.recoveryOwner as string | null;
			}
			if ("recoveryLeaseUntil" in data) {
				runRecoveryLeaseUntil = data.recoveryLeaseUntil as Date | null;
			}
			if (isRecordIncrement(data.recoveryGeneration)) {
				runRecoveryGeneration += data.recoveryGeneration.increment;
			}
			return { count: 1 };
		};
		const tx = {
			verificationRun: { updateMany: runUpdate },
			verificationResourceIntent: {
				findMany: async () => [],
				findUniqueOrThrow: async () => ({
					eventSeq: intent.eventSeq,
					state: intent.state,
					recoveryOwner: intent.recoveryOwner,
					recoveryLeaseUntil: intent.recoveryLeaseUntil,
					recoveryGeneration: intent.recoveryGeneration,
				}),
				updateMany: async ({ data }: { data: Record<string, unknown> }) => {
					mutations.push("intent");
					intent.eventSeq += 1;
					for (const [key, value] of Object.entries(data)) {
						if (key !== "eventSeq") {
							(intent as unknown as Record<string, unknown>)[key] = value;
						}
					}
					return { count: 1 };
				},
			},
			verificationResourceIntentEvent: { create: async () => ({ id: "e" }) },
		};
		const prisma = {
			$transaction: async (callback: (transaction: typeof tx) => unknown) =>
				callback(tx),
			verificationRun: {
				findUnique: async () => ({
					...row,
					status: finalStatus,
					recoveryGeneration: runRecoveryGeneration,
					recoveryOwner: runRecoveryOwner,
					recoveryLeaseUntil: runRecoveryLeaseUntil,
				}),
				updateMany: runUpdate,
			},
			verificationResourceIntent: {
				findMany: async () => [{ ...intent, events: [] }],
			},
		} as unknown as AppPrismaClient;
		try {
			const result = await recoverVerificationRun(
				releaseAuthorityConfig(prisma),
				"sealed-run",
				{
					now: () => new Date("2026-09-01T01:00:00Z").getTime(),
					resolvers: {
						VOD_JOB: async () => {
							throw new Error("PREPARED intent must not call a resolver");
						},
						LIVE_CHANNEL: async () => {
							throw new Error("wrong resolver");
						},
					},
				},
			);
			expect(updates).toContainEqual(
				expect.objectContaining({ status: "INCOMPLETE" }),
			);
			// A second recovery can observe a closed intent immediately. The authority
			// row must therefore be demoted before the first recovery mutates any intent.
			expect(mutations[0]).toBe("run-demotion");
			expect(result.reportExports).toBe("NOT_APPLICABLE");
			await expect(readFile(reportPath, "utf8")).rejects.toThrow();
			await expect(
				readFile(join(dir, "report.seal"), "utf8"),
			).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses malformed or tampered DB authority before writing any export", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-recover-invalid-"));
		const reportPath = join(dir, "report.json");
		const valid = sealedAuthority(reportPath);
		const row = {
			...valid,
			reportMarkdown: `${valid.reportMarkdown}tampered\n`,
		};
		const prisma = {
			verificationRun: {
				findUnique: async () => row,
				update: async () => ({}),
			},
			verificationResourceIntent: { findMany: async () => [] },
		} as unknown as AppPrismaClient;
		try {
			await expect(
				recoverVerificationRun(releaseAuthorityConfig(prisma), "sealed-run", {
					resolvers: {
						VOD_JOB: async () => {
							throw new Error("no intent");
						},
						LIVE_CHANNEL: async () => {
							throw new Error("no intent");
						},
					},
				}),
			).rejects.toThrow(/Markdown|authority|digest|seal/i);
			await expect(readFile(reportPath, "utf8")).rejects.toThrow();
			await expect(
				readFile(join(dir, "report.seal"), "utf8"),
			).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an HMAC-valid but structurally incomplete DB report", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-recover-incomplete-"));
		const reportPath = join(dir, "report.json");
		const incomplete = '{"runId":"sealed-run"}\n';
		const row = sealedAuthority(reportPath, {
			reportJson: incomplete,
			reportSha256: sha256(incomplete),
			seal: sealReport(incomplete, KEY),
		});
		const prisma = {
			verificationRun: {
				findUnique: async () => row,
				update: async () => ({}),
			},
			verificationResourceIntent: { findMany: async () => [] },
		} as unknown as AppPrismaClient;
		try {
			await expect(
				recoverVerificationRun(releaseAuthorityConfig(prisma), "sealed-run", {
					resolvers: {
						VOD_JOB: async () => {
							throw new Error("no intent");
						},
						LIVE_CHANNEL: async () => {
							throw new Error("no intent");
						},
					},
				}),
			).rejects.toThrow(/REPORT_INVALID|complete verification report/);
			await expect(readFile(reportPath, "utf8")).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("surfaces export repair failure so the command outcome is nonzero and printable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-recover-export-fail-"));
		const reportPath = join(dir, "report.json");
		const row = sealedAuthority(reportPath);
		const prisma = {
			verificationRun: {
				findUnique: async () => row,
				update: async () => ({}),
			},
			verificationResourceIntent: { findMany: async () => [] },
		} as unknown as AppPrismaClient;
		try {
			const result = await recoverVerificationRun(
				releaseAuthorityConfig(prisma),
				"sealed-run",
				{
					resolvers: {
						VOD_JOB: async () => {
							throw new Error("no intent");
						},
						LIVE_CHANNEL: async () => {
							throw new Error("no intent");
						},
					},
					publishFile: async () => {
						throw new Error("filesystem rename refused");
					},
				},
			);
			expect(result.reportExports).toBe("FAILED");
			const runner = (await import("./runner")) as unknown as {
				formatRecoveryCommandResult: (value: typeof result) => {
					code: number;
					message: string;
				};
			};
			expect(runner.formatRecoveryCommandResult).toBeTypeOf("function");
			const command = runner.formatRecoveryCommandResult(result);
			expect(command.code).toBe(1);
			expect(command.message).toContain("filesystem rename refused");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not describe SHA256-only restored exports as authenticated", async () => {
		const runner = (await import("./runner")) as unknown as {
			formatRecoveryCommandResult: (
				value: import("./runner").VerificationRecoveryResult,
			) => { code: number; message: string };
		};
		const command = runner.formatRecoveryCommandResult({
			runId: "sealed-run",
			sealable: true,
			authorityFenced: true,
			reportExports: "RESTORED",
			unresolvedKeys: [],
			lines: [],
			dossier: [],
		});
		expect(command.code).toBe(0);
		expect(command.message).not.toContain("authenticated");
	});
});
