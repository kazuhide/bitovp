import { createHash } from "node:crypto";
import {
	hashApiTokenSecret,
	LIVE_EVIDENCE_VERSION,
	type LiveEvidenceLeg,
	REDACTED,
	sealLiveEvidenceLeg,
	summarizeLiveEvidence,
	verificationRunKind,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { sealReport } from "./harness-rails";
import {
	createRunRecorder,
	type LiveEvidenceRow,
	originOf,
	prismaRunRecordStore,
	type RunRecordCreate,
	type RunRecordStore,
	type RunRecordUpdate,
	type RunSealInput,
	recordableError,
	SEAL_WRITE_ATTEMPTS,
} from "./run-record";

/**
 * The durable half of a run (re-audit HIGH-7 / GO 11), tested against a fake
 * store rather than Prisma: `runVerification` needs a database, credentials, a
 * product and a bucket, so the DECISIONS live here where they can be driven,
 * and the runner's call sites are pinned by shape in run-record-wiring.test.ts.
 */

type Recorded = { row: Record<string, unknown>; updates: RunRecordUpdate[] };

function fakeStore(
	options: {
		createError?: unknown;
		/**
		 * Milliseconds each successive update takes to LAND, so a lost update
		 * can be observed. A real database write is a network round trip whose
		 * completion order is not its issue order; an instantly-resolving fake
		 * cannot tell a serialized writer from an unserialized one.
		 */
		updateLatenciesMs?: number[];
		/** Reject this many update calls before the first one is allowed to land. */
		failFirstUpdates?: number;
		/** Simulate a restart-recovery generation claim before the final seal CAS. */
		loseSealCas?: boolean;
		/** The SEALED COMMIT lands, but the first response is lost in transit. */
		commitSealThenThrowOnce?: boolean;
	} = {},
) {
	const state: Recorded = { row: {}, updates: [] };
	const creates: RunRecordCreate[] = [];
	let updateCount = 0;
	let sealResponseLost = false;
	const store: RunRecordStore = {
		create: async (data) => {
			creates.push(data);
			if (options.createError) {
				throw options.createError;
			}
			state.row = { ...data, status: "RUNNING", recoveryGeneration: 0 };
			return { id: "row-1", recoveryGeneration: 0 };
		},
		update: async (id, data) => {
			expect(id).toBe("row-1");
			const delay = options.updateLatenciesMs?.[updateCount] ?? 0;
			updateCount += 1;
			if (updateCount <= (options.failFirstUpdates ?? 0)) {
				throw new Error(`write ${updateCount} rejected`);
			}
			if (delay > 0) {
				await new Promise((done) => setTimeout(done, delay));
			}
			state.updates.push(data);
			state.row = { ...state.row, ...data };
			return state.row;
		},
		seal: async (id, expectedRecoveryGeneration, data) => {
			expect(expectedRecoveryGeneration).toBe(0);
			if (options.loseSealCas) return false;
			if (state.row.status === "SEALED") {
				return (
					state.row.recoveryGeneration === expectedRecoveryGeneration &&
					state.row.reportSha256 === data.reportSha256 &&
					state.row.seal === data.seal
				);
			}
			await store.update(id, data);
			if (options.commitSealThenThrowOnce && !sealResponseLost) {
				sealResponseLost = true;
				throw new Error("connection lost after COMMIT");
			}
			return true;
		},
		fail: async (id, expectedRecoveryGeneration, data) => {
			expect(id).toBe("row-1");
			if (
				state.row.status !== "RUNNING" ||
				state.row.recoveryGeneration !== expectedRecoveryGeneration
			) {
				return false;
			}
			state.updates.push(data);
			state.row = { ...state.row, ...data };
			return true;
		},
		actorForToken: async (secret) =>
			secret === "bo_good" ? "token:tok-1" : null,
	};
	return { store, state, creates };
}

const FINGERPRINT = {
	commit: "abc123",
	checkoutLatestMigration: "20260829120000_verification_run",
	dbLatestMigration: "20260829120000_verification_run",
	drift: false,
};

const RESERVE = {
	runId: "2026-08-29T10-00-00-000-abcdef",
	startedAt: "2026-08-29T10:00:00.000Z",
	reportPath: "verify-runs/2026-08-29T10-00-00-000-abcdef/report.json",
	baseUrl: "https://ovp.example.com/api/../?x=1",
	sourceObject: "bbb-short.mov",
};

const REPORT_MARKDOWN = "# verification report\n";
const FINISHED_AT = "2026-08-29T10:30:00.000Z";
const RETENTION_UNTIL = "2026-11-29T10:30:00.000Z";
const VERDICTS = ["PASS", "WARN", "FAIL", "SKIP", "INVALID"] as const;

function makeSealInput(
	outcomes: RunSealInput["outcomes"] = [
		{ scenario: "a", verdict: "PASS", reason: "verified" },
	],
): RunSealInput {
	const counts = Object.fromEntries(
		VERDICTS.map((verdict) => [
			verdict,
			outcomes.filter((outcome) => outcome.verdict === verdict).length,
		]),
	);
	const evidenceManifest = {
		version: 1,
		scenarios: outcomes
			.filter((outcome) => outcome.verdict === "PASS")
			.map((outcome) => ({
				scenario: outcome.scenario,
				planFile: `${outcome.scenario}.plan.json`,
				planSha256: "a".repeat(64),
				reportFile: `${outcome.scenario}.report.json`,
				reportSha256: "b".repeat(64),
			})),
	};
	const reportJson = `${JSON.stringify({
		runId: RESERVE.runId,
		startedAt: RESERVE.startedAt,
		finishedAt: FINISHED_AT,
		fingerprint: FINGERPRINT,
		preflight: [],
		outcomes,
		counts,
		evidence: {
			version: 1,
			algorithm: "SHA256",
			keyId: null,
			retentionUntil: RETENTION_UNTIL,
			manifest: evidenceManifest,
			reportMarkdownSha256: createHash("sha256")
				.update(REPORT_MARKDOWN)
				.digest("hex"),
		},
		resourceIntents: [],
	})}\n`;
	return {
		reportJson,
		reportMarkdown: REPORT_MARKDOWN,
		seal: sealReport(reportJson),
		sealAlgorithm: "SHA256",
		sealKeyId: null,
		evidenceVersion: 1,
		evidenceManifest,
		retentionUntil: RETENTION_UNTIL,
		outcomes,
		counts,
		resourceIntents: [],
		finishedAt: FINISHED_AT,
	};
}

describe("the run reservation", () => {
	it("creates the row before anything is spent, with the origin and the resolved actor", async () => {
		const { store, creates } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve({ ...RESERVE, apiToken: "bo_good" });
		expect(recorder.rowId()).toBe("row-1");
		expect(recorder.producerFence()).toEqual({
			verificationRunId: "row-1",
			recoveryGeneration: 0,
		});
		expect(creates).toHaveLength(1);
		expect(creates[0]).toMatchObject({
			runId: RESERVE.runId,
			reportPath: RESERVE.reportPath,
			sourceObject: "bbb-short.mov",
			actor: "token:tok-1",
		});
		expect(creates[0]?.startedAt.toISOString()).toBe(RESERVE.startedAt);
	});

	it("stores the ORIGIN of the base URL, never its path, query or credential", async () => {
		const { store, creates } = fakeStore();
		await createRunRecorder(store).reserve({
			...RESERVE,
			baseUrl: "https://user:hunter2@ovp.example.com:8443/verify?token=abc",
		});
		expect(creates[0]?.baseUrlOrigin).toBe("https://ovp.example.com:8443");
	});

	it("never stores the API token, in any column", async () => {
		const { store, creates } = fakeStore();
		await createRunRecorder(store).reserve({
			...RESERVE,
			apiToken: "bo_good",
		});
		expect(JSON.stringify(creates[0])).not.toContain("bo_good");
	});

	it("leaves the actor unset when the token matches no row, and when the lookup throws", async () => {
		const { store, creates } = fakeStore();
		await createRunRecorder(store).reserve({ ...RESERVE, apiToken: "bo_bad" });
		expect(creates[0]).not.toHaveProperty("actor");

		const throwing = fakeStore();
		throwing.store.actorForToken = async () => {
			throw new Error("db down");
		};
		await createRunRecorder(throwing.store).reserve({
			...RESERVE,
			apiToken: "bo_good",
		});
		expect(throwing.creates[0]).not.toHaveProperty("actor");
	});

	/**
	 * The whole point of the unique column: `prepareRunDir` is one host's disk,
	 * and two hosts sharing a database do not share a filesystem.
	 */
	it("REFUSES a run id another run already reserved (P2002), and touches nothing after", async () => {
		const { store, state } = fakeStore({
			createError: Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		});
		const recorder = createRunRecorder(store);
		await expect(recorder.reserve(RESERVE)).rejects.toThrow(
			/already reserved in the database/,
		);
		expect(recorder.rowId()).toBeNull();
		// The refused row belongs to the OTHER run; marking it INCOMPLETE would
		// be this process vandalising someone else's evidence.
		await recorder.failed(new Error("boom"));
		await recorder.outcome({ scenario: "x", verdict: "FAIL" });
		expect(state.updates).toEqual([]);
	});

	it("rethrows a non-duplicate create failure unchanged — a run whose evidence cannot be reserved does not spend", async () => {
		const { store } = fakeStore({
			createError: new Error("connection refused"),
		});
		await expect(createRunRecorder(store).reserve(RESERVE)).rejects.toThrow(
			"connection refused",
		);
	});
});

describe("what the run turned out to be", () => {
	it("records the derived kind, fingerprint, billed account, and accepted resume relation", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.resumeDecision({
			decision: "ACCEPTED",
			reason: "prior evidence fully agreed",
			priorRowId: "00000000-0000-4000-8000-000000000001",
		});
		await recorder.context({
			scenarios: [
				{ name: "vod-a", kind: "VOD" },
				{ name: "vod-b", kind: "VOD" },
				{ name: "live-a", kind: "LIVE" },
			],
			fingerprint: { ...FINGERPRINT, drift: true },
			bitmovinAccountId: "acct-9",
		});
		expect(state.row).toMatchObject({
			kind: "MIXED",
			commit: "abc123",
			drift: true,
			bitmovinAccountId: "acct-9",
			resumedFromId: "00000000-0000-4000-8000-000000000001",
			resumeDecision: expect.objectContaining({ decision: "ACCEPTED" }),
		});
	});

	/**
	 * `context` is a FINGERPRINT write. Its payload must never mention the
	 * evidence columns, because a whole-column rewrite of `outcomes` is a
	 * DELETE of everything accumulated so far.
	 *
	 * Today it happens to run before the first scenario finishes, so a payload
	 * carrying `outcomes: []` would be harmless — and that is exactly why this
	 * needs asserting: the safety would rest on call ORDER in runner.ts, a file
	 * this suite cannot see, and a reordering (or a second `context` call for
	 * a late-resolved account) would silently wipe the run's evidence. A
	 * mutation adding `outcomes: []` / `counts: {}` here survived all 27 tests
	 * of this file before these two arms existed (review of PR #345).
	 */
	it.each([
		"outcomes",
		"counts",
		"cleanup",
		"providerReadback",
	])("context() never sends %s — a fingerprint write must not rewrite evidence columns", async (column) => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.context({
			scenarios: [{ name: "vod-a", kind: "VOD" }],
			fingerprint: FINGERPRINT,
			bitmovinAccountId: "acct-9",
		});
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0]).not.toHaveProperty(column);
	});

	it("context() sends exactly the fingerprint columns and nothing else", async () => {
		// The closed form of the rule above: a column that is neither one of
		// the four named there nor a fingerprint field still cannot ride along.
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.context({
			scenarios: [{ name: "vod-a", kind: "VOD" }],
			fingerprint: FINGERPRINT,
			bitmovinAccountId: "acct-9",
		});
		expect(Object.keys(state.updates[0] ?? {}).sort()).toEqual([
			"bitmovinAccountId",
			"checkoutLatestMigration",
			"commit",
			"dbLatestMigration",
			"drift",
			"kind",
		]);
	});

	it("writes a null account rather than omitting it — 'no account' is a fact about the run", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.context({
			scenarios: [{ name: "vod-a", kind: "VOD" }],
			fingerprint: FINGERPRINT,
		});
		expect(state.updates[0]).toMatchObject({
			kind: "VOD",
			bitmovinAccountId: null,
		});
	});
});

describe("resume authority", () => {
	it("durably writes an accepted decision and the formal prior-row relation", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.resumeDecision({
			decision: "ACCEPTED",
			reason: "DB, report, seal, fingerprint, and scenario evidence agree",
			priorRowId: "00000000-0000-4000-8000-000000000001",
			algorithm: "HMAC_SHA256",
			keyId: "release-2026-08",
		});
		expect(state.row).toMatchObject({
			resumedFromId: "00000000-0000-4000-8000-000000000001",
			resumeDecision: {
				decision: "ACCEPTED",
				algorithm: "HMAC_SHA256",
				keyId: "release-2026-08",
			},
		});
	});

	it("records a refusal without creating a prior-row relation", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.resumeDecision({
			decision: "REFUSED",
			reason: "report digest differs from the durable row",
			priorRowId: "00000000-0000-4000-8000-000000000001",
		});
		expect(state.row.resumeDecision).toMatchObject({ decision: "REFUSED" });
		expect(state.row).not.toHaveProperty("resumedFromId");
	});

	it("fails closed when the accepted decision cannot be persisted", async () => {
		const { store, state } = fakeStore({ failFirstUpdates: 1 });
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await expect(
			recorder.resumeDecision({
				decision: "ACCEPTED",
				reason: "evidence agreed",
				priorRowId: "00000000-0000-4000-8000-000000000001",
			}),
		).rejects.toThrow("write 1 rejected");
		expect(state.updates).toEqual([]);
		expect(state.row).not.toHaveProperty("resumedFromId");
	});

	it("refuses an accepted decision that cannot name a formal prior row", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await expect(
			recorder.resumeDecision({
				decision: "ACCEPTED",
				reason: "incomplete caller input",
			}),
		).rejects.toThrow(/formal prior VerificationRun relation/);
		expect(state.updates).toEqual([]);
	});
});

describe("verificationRunKind", () => {
	it.each([
		[["VOD", "VOD"], "VOD"],
		[["LIVE"], "LIVE"],
		[["LIVE", "VOD"], "MIXED"],
		[[], null],
	])("%s → %s", (kinds, expected) => {
		expect(verificationRunKind(kinds as string[])).toBe(expected);
	});
});

describe("per-scenario evidence", () => {
	it("writes each outcome as it finishes, with the running verdict counts", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.outcome({
			scenario: "h264-hls",
			verdict: "PASS",
			encodingId: "enc-1",
		});
		await recorder.outcome({ scenario: "vp9-dash", verdict: "FAIL" });
		expect(state.updates).toHaveLength(2);
		expect(state.updates[0]?.counts).toEqual({ PASS: 1 });
		expect(state.updates[1]?.counts).toEqual({ PASS: 1, FAIL: 1 });
		expect(state.updates[1]?.outcomes).toEqual([
			{ scenario: "h264-hls", verdict: "PASS", encodingId: "enc-1" },
			{ scenario: "vp9-dash", verdict: "FAIL" },
		]);
	});

	/**
	 * A NAME says nothing about bytes. The run-level identity is
	 * only learnable from a scenario that actually HEADed the run's own
	 * mezzanine — a scenario reading the LONG source must not be mistaken for
	 * it.
	 */
	it("takes the run's source identity from a scenario that read the run's source, not from one that read another", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.outcome({
			scenario: "needs-long",
			verdict: "PASS",
			sourceObject: "bbb-long.mov",
			sourceIdentity: "etag=LONG;size=99",
		});
		expect(state.row).not.toHaveProperty("sourceIdentity");
		await recorder.outcome({
			scenario: "h264-hls",
			verdict: "PASS",
			sourceObject: "bbb-short.mov",
			sourceIdentity: "etag=SHORT;size=42",
		});
		expect(state.row.sourceIdentity).toBe("etag=SHORT;size=42");
	});

	/**
	 * Scenarios finish CONCURRENTLY (`pooled(runnable, config.concurrency, …)`)
	 * and each write rewrites the whole column. Unserialized, the first write
	 * carries [a] and the second carries [a, b] — and if the first LANDS last,
	 * the row keeps [a] and b is gone. The latencies below make the first
	 * update land last, which is the only arrangement in which the defect is
	 * observable at all.
	 */
	it("does not lose an outcome when a slow write lands after a fast one", async () => {
		const { store, state } = fakeStore({ updateLatenciesMs: [30, 0] });
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		const first = recorder.outcome({ scenario: "a", verdict: "PASS" });
		// The second scenario finishes while the first row write is still in
		// flight — the arrangement the pool produces and the ONLY one in which
		// a lost update is observable. Without the delay the two calls happen
		// in one synchronous run and both writes carry both outcomes, which is
		// green whether or not anything is serialized (measured: the mutation
		// survived that version of this test).
		await new Promise((done) => setTimeout(done, 5));
		const second = recorder.outcome({ scenario: "b", verdict: "WARN" });
		await Promise.all([first, second]);
		expect(state.row.outcomes).toHaveLength(2);
		expect(state.row.counts).toEqual({ PASS: 1, WARN: 1 });
	});
});

describe("cleanup and the provider readback", () => {
	it("splits ensureTerminal's result into a per-scenario entry and an encodingId → status map", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.cleanup({
			scenario: "h264-hls",
			jobId: "job-1",
			status: "CANCELED",
			cancelHttp: 202,
			terminal: true,
			localTerminal: true,
			providerTerminal: true,
			provider: [
				{ encodingId: "enc-1", status: "CANCELED" },
				{ encodingId: "enc-2", status: "FINISHED" },
			],
		});
		expect(state.row.providerReadback).toEqual({
			"enc-1": "CANCELED",
			"enc-2": "FINISHED",
		});
		expect(state.row.cleanup).toEqual([
			{
				scenario: "h264-hls",
				jobId: "job-1",
				status: "CANCELED",
				cancelHttp: 202,
				terminal: true,
				localTerminal: true,
				providerTerminal: true,
				encodingIds: ["enc-1", "enc-2"],
			},
		]);
	});

	it("keeps 'unread' as itself — a provider nobody asked is not a provider that said terminal", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.cleanup({
			scenario: "s",
			jobId: "job-2",
			status: "UNKNOWN",
			cancelHttp: 0,
			terminal: false,
			localTerminal: false,
			providerTerminal: "unread",
		});
		const entries = state.row.cleanup as { providerTerminal: unknown }[];
		expect(entries[0]?.providerTerminal).toBe("unread");
		expect(state.row.providerReadback).toEqual({});
	});
});

describe("sealing", () => {
	const SEAL_INPUT = makeSealInput();

	it("preseal validates without writing SEALED or mutating the row", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		const before = state.updates.length;

		await recorder.preseal(SEAL_INPUT);

		expect(state.updates).toHaveLength(before);
		expect(state.row.status).not.toBe("SEALED");
	});

	it("refuses to seal when the HMAC-covered JSON does not bind the exact Markdown bytes", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await expect(
			recorder.sealed({
				...SEAL_INPUT,
				reportMarkdown: `${REPORT_MARKDOWN}tampered\n`,
			}),
		).rejects.toThrow(/Markdown.*digest|bind.*Markdown/i);
		expect(state.row.status).not.toBe("SEALED");
	});

	it("refuses a forged seal before writing SEALED", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await expect(
			recorder.sealed({ ...SEAL_INPUT, seal: "sha256:cafe" }),
		).rejects.toThrow(/seal/i);
		expect(state.row.status).not.toBe("SEALED");
	});

	it("verifies an HMAC before SEALED without persisting the key material", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		const key = "release-key-material";
		const report = JSON.parse(SEAL_INPUT.reportJson) as {
			evidence: { algorithm: string; keyId: string | null };
		};
		report.evidence.algorithm = "HMAC_SHA256";
		report.evidence.keyId = "key-a";
		const reportJson = `${JSON.stringify(report)}\n`;
		await recorder.sealed({
			...SEAL_INPUT,
			reportJson,
			seal: sealReport(reportJson, key),
			sealAlgorithm: "HMAC_SHA256",
			sealKeyId: "key-a",
			sealKey: key,
		});
		expect(state.row.status).toBe("SEALED");
		expect(JSON.stringify(state.row)).not.toContain(key);
		expect(JSON.stringify(state.updates)).not.toContain(key);
	});

	it("refuses when separately persisted outcomes differ from the sealed report", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await expect(
			recorder.sealed({
				...SEAL_INPUT,
				outcomes: [
					{ scenario: "different", verdict: "PASS", reason: "not the report" },
				],
			}),
		).rejects.toThrow(/outcome|report/i);
		expect(state.row.status).not.toBe("SEALED");
	});

	it("loses the final CAS after restart recovery advances the run generation", async () => {
		const { store, state } = fakeStore({ loseSealCas: true });
		const recorder = createRunRecorder(store, { sleep: async () => {} });
		await recorder.reserve(RESERVE);
		await expect(recorder.sealed(SEAL_INPUT)).rejects.toThrow(
			/recovery generation (?:changed|fence)|fenced this producer/i,
		);
		expect(state.row.status).not.toBe("SEALED");
		expect(state.updates.some((update) => update.status === "SEALED")).toBe(
			false,
		);
	});

	it("records the report's own SHA-256, the seal, the finish time and SEALED", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		const input = makeSealInput([
			{ scenario: "a", verdict: "PASS", reason: "verified" },
			{ scenario: "b", verdict: "SKIP", reason: "not selected" },
		]);
		await recorder.sealed(input);
		expect(state.row.status).toBe("SEALED");
		expect(state.row.seal).toBe(input.seal);
		expect(state.row.reportJson).toBe(input.reportJson);
		expect(state.row.reportMarkdown).toBe(REPORT_MARKDOWN);
		// Independent of the seal's kind: an HMAC seal still leaves the row
		// able to say which bytes it covered.
		expect(state.row.reportSha256).toBe(
			createHash("sha256").update(input.reportJson).digest("hex"),
		);
		expect((state.row.finishedAt as Date).toISOString()).toBe(
			"2026-08-29T10:30:00.000Z",
		);
		expect(state.row.counts).toEqual(input.counts);
	});

	/**
	 * The report's population is bigger than the runnable one — it also covers
	 * every scenario preflight blocked. The row must say what the SEALED BYTES
	 * say, or a reader joining the two would find a shorter list here than in
	 * the file this row claims to describe.
	 */
	it("replaces the incremental outcomes with the report's, including the skipped scenarios", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.outcome({ scenario: "a", verdict: "PASS" });
		await recorder.sealed(
			makeSealInput([
				{ scenario: "a", verdict: "PASS", reason: "verified" },
				{ scenario: "blocked", verdict: "SKIP", reason: "blocked" },
			]),
		);
		expect(state.row.outcomes).toHaveLength(2);
	});

	/**
	 * The seal is the ONE write that retries, because it atomically installs the
	 * self-contained DB authority before any canonical export is published. One
	 * transient failure there would leave the row RUNNING forever over a run
	 * that finished perfectly — HIGH-7 again, on the write that closes it.
	 */
	it("retries the seal write and lands SEALED after two rejections", async () => {
		const slept: number[] = [];
		const { store, state } = fakeStore({ failFirstUpdates: 2 });
		const recorder = createRunRecorder(store, {
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		await recorder.reserve(RESERVE);
		const input = makeSealInput();
		await recorder.sealed(input);
		expect(state.row.status).toBe("SEALED");
		expect(state.row.seal).toBe(input.seal);
		expect(state.row.reportSha256).toBe(
			createHash("sha256").update(input.reportJson).digest("hex"),
		);
		// It BACKED OFF rather than hammering: two failures, two waits.
		expect(slept).toHaveLength(2);
		expect(slept.every((ms) => ms > 0)).toBe(true);
	});

	/**
	 * The BLOCKER this write earns its retry for.
	 * When EVERY seal-write retry fails, only pending exports exist and no
	 * durable row says the run sealed. The run must not finish as if it did:
	 * `sealed` THROWS — so runVerification's catch runs and the CLI
	 * exits nonzero — the row is never a false SEALED, and the very next call
	 * that catch makes, `failed`, lands the row INCOMPLETE. Before the fix,
	 * `sealed` set `sealedAlready` before the write and swallowed the all-fail
	 * softly, so `failed` short-circuited and the row stayed a stale RUNNING
	 * while the CLI reported success — a release gate got two different answers.
	 */
	it("throws when every seal-write retry fails, never leaves a false SEALED, and the failure path then lands INCOMPLETE", async () => {
		const lines: string[] = [];
		const { store, state } = fakeStore({
			failFirstUpdates: SEAL_WRITE_ATTEMPTS,
		});
		const recorder = createRunRecorder(store, {
			log: (line) => lines.push(line),
			sleep: async () => {},
		});
		await recorder.reserve(RESERVE);
		let sealError: unknown;
		await recorder.sealed(makeSealInput()).catch((err) => {
			sealError = err;
		});
		// It threw rather than resolving as if the run had sealed…
		expect(sealError).toBeInstanceOf(Error);
		// …never wrote a false SEALED, and said so loudly.
		expect(state.row.status).not.toBe("SEALED");
		expect(lines.join("\n")).toContain("the sealed report");
		// The exact next call runVerification's catch makes. It lands INCOMPLETE
		// only because `sealedAlready` was NOT set on the swallowed failure —
		// set it early and this short-circuits and the row stays RUNNING.
		await recorder.failed(sealError);
		expect(state.row.status).toBe("INCOMPLETE");
		expect(state.row.finishedAt).toBeInstanceOf(Date);
	});

	it("does NOT retry an ordinary write — only the last one earns that", async () => {
		// A progress update is cheap to lose and the encoder is still
		// spending; retrying every write would stall the pool on a sick
		// database. One attempt, one log line.
		const { store, state } = fakeStore({ failFirstUpdates: 1 });
		const recorder = createRunRecorder(store, { sleep: async () => {} });
		await recorder.reserve(RESERVE);
		await recorder.outcome({ scenario: "a", verdict: "PASS" });
		expect(state.updates).toEqual([]);
	});

	it("leaves a SEALED row alone when something throws afterwards", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.sealed(makeSealInput());
		await recorder.failed(new Error("disconnect blew up"));
		expect(state.row.status).toBe("SEALED");
	});

	it("treats a committed-then-lost seal response as idempotent and never demotes it", async () => {
		const { store, state } = fakeStore({ commitSealThenThrowOnce: true });
		const recorder = createRunRecorder(store, { sleep: async () => {} });
		await recorder.reserve(RESERVE);
		await expect(recorder.sealed(makeSealInput())).resolves.toBeUndefined();
		expect(state.row.status).toBe("SEALED");
		await recorder.failed(new Error("outer publisher saw the lost response"));
		expect(state.row.status).toBe("SEALED");
	});

	/**
	 * Idempotency (fix part 3): once a run is DURABLY sealed, sealing it again is
	 * a no-op success — never a second write and never a hard failure. The guard
	 * is `sealedAlready`, and it is now set only AFTER the durable write, so this
	 * control also fixes the flag's meaning in place: a re-seal that wrote twice
	 * would prove the guard was gone.
	 */
	it("re-sealing an already-durably-sealed run is a no-op success", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		const input = makeSealInput();
		const seal = () => recorder.sealed(input);
		await seal();
		expect(state.updates).toHaveLength(1);
		expect(state.row.status).toBe("SEALED");
		// The second seal writes nothing more and does not throw.
		await expect(seal()).resolves.toBeUndefined();
		expect(state.updates).toHaveLength(1);
		expect(state.row.status).toBe("SEALED");
	});
});

describe("a run that never seals", () => {
	it("marks INCOMPLETE with a redacted, bounded reason", async () => {
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.failed(
			new Error("POST https://user:hunter2@ovp.example.com/api/x failed"),
		);
		expect(state.row.status).toBe("INCOMPLETE");
		expect(state.row.error).toBe(
			"POST https://user:[REDACTED]@ovp.example.com/api/x failed",
		);
		expect(state.row.finishedAt).toBeInstanceOf(Date);
	});

	/**
	 * A row left RUNNING is the evidence that the run never sealed. So a
	 * failure to WRITE evidence must not become a failure of the run itself —
	 * past the reservation the encoder is already spending, and throwing here
	 * would abandon paid encodings to report a database problem.
	 */
	it("survives an ORDINARY write failure loudly, and leaves the row where it was", async () => {
		const lines: string[] = [];
		const { store, state } = fakeStore();
		const recorder = createRunRecorder(store, { log: (l) => lines.push(l) });
		await recorder.reserve(RESERVE);
		store.update = async () => {
			throw new Error("deadlock detected");
		};
		// A progress write past the reservation is SOFT: the encoder is
		// spending, so a lost update must never throw and abandon paid
		// encodings. (The seal is the one exception — see the sealing suite,
		// where an all-fail write is a HARD failure that marks INCOMPLETE.)
		await expect(
			recorder.outcome({ scenario: "a", verdict: "PASS" }),
		).resolves.toBeUndefined();
		expect(lines.join("\n")).toContain("deadlock detected");
		expect(lines.some((l) => l.includes("scenario a"))).toBe(true);
		// The row is untouched: still the reserved row, never a false SEALED.
		expect(state.row.status).toBe("RUNNING");
	});
});

describe("prismaRunRecordStore.actorForToken", () => {
	/**
	 * The lookup is by HASH, and the hash is now `@bitovp/core`'s — the same
	 * function the web auth layer stores with. The row below is built with
	 * that shared function on purpose: if the store hashed with anything else
	 * (as the first cut's inlined `createHash` would the day the web side
	 * moved) the WHERE would match nothing, `actor` would quietly become null
	 * on every run, and nothing else in this repo would notice.
	 */
	const SECRET = `bo_${"a".repeat(43)}`;

	function fakePrisma(rows: { id: string; tokenHash: string }[]) {
		const seen: unknown[] = [];
		const prisma = {
			apiToken: {
				findFirst: async (args: {
					where: { tokenHash: string };
				}): Promise<{ id: string } | null> => {
					seen.push(args);
					return rows.find((r) => r.tokenHash === args.where.tokenHash) ?? null;
				},
			},
		} as unknown as AppPrismaClient;
		return { prisma, seen };
	}

	it("resolves a known secret to `token:<id>`, matching on the SHARED hash", async () => {
		const { prisma, seen } = fakePrisma([
			{ id: "tok-1", tokenHash: hashApiTokenSecret(SECRET) },
		]);
		const store = prismaRunRecordStore(prisma);
		expect(await store.actorForToken?.(SECRET)).toBe("token:tok-1");
		expect(seen[0]).toEqual({
			where: { tokenHash: hashApiTokenSecret(SECRET) },
			select: { id: true },
		});
	});

	it("returns null for a secret no row carries, and never queries the secret itself", async () => {
		const { prisma, seen } = fakePrisma([
			{ id: "tok-1", tokenHash: hashApiTokenSecret(SECRET) },
		]);
		const store = prismaRunRecordStore(prisma);
		expect(await store.actorForToken?.(`bo_${"b".repeat(43)}`)).toBeNull();
		expect(JSON.stringify(seen)).not.toContain("bbbb");
	});
});

describe("prismaRunRecordStore SEALED generation CAS", () => {
	const runningParentLock = {
		$queryRaw: async () => [{ id: "row-1" }],
	};

	it("locks the parent before reading child intents so a paid PREPARED row cannot slip past the seal", async () => {
		const order: string[] = [];
		const tx = {
			$queryRaw: async () => {
				order.push("parent-lock");
				return [
					{
						id: "row-1",
						status: "RUNNING",
						recoveryGeneration: 0,
						recoveryOwner: null,
						recoveryLeaseUntil: null,
						reportSha256: null,
						seal: null,
					},
				];
			},
			verificationResourceIntent: {
				findMany: async () => {
					order.push("children");
					return [];
				},
			},
			verificationRun: {
				updateMany: async () => {
					order.push("seal");
					return { count: 1 };
				},
			},
		};
		const prisma = {
			$transaction: async (callback: (client: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;

		await expect(
			prismaRunRecordStore(prisma).seal("row-1", 0, { status: "SEALED" }, []),
		).resolves.toBe(true);
		expect(order).toEqual(["parent-lock", "children", "seal"]);
	});

	it("writes SEALED only from the reserved RUNNING generation with no recovery lease", async () => {
		const calls: unknown[] = [];
		const tx = {
			...runningParentLock,
			verificationResourceIntent: { findMany: async () => [] },
			verificationRun: {
				updateMany: async (args: unknown) => {
					calls.push(args);
					return { count: 1 };
				},
			},
		};
		const prisma = {
			$transaction: async (callback: (client: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;
		const landed = await prismaRunRecordStore(prisma).seal(
			"row-1",
			7,
			{
				status: "SEALED",
				outcomes: [{ scenario: "fixed", verdict: "PASS", reason: "verified" }],
				counts: { PASS: 1 },
				evidenceManifest: { version: 1, scenarios: [] },
			},
			[],
		);
		expect(landed).toBe(true);
		expect(calls[0]).toMatchObject({
			where: {
				id: "row-1",
				status: "RUNNING",
				recoveryGeneration: 7,
				recoveryOwner: null,
				recoveryLeaseUntil: null,
			},
			data: { status: "SEALED" },
		});
	});

	it("reports a lost CAS rather than upgrading another generation", async () => {
		const tx = {
			...runningParentLock,
			verificationResourceIntent: { findMany: async () => [] },
			verificationRun: {
				updateMany: async () => ({ count: 0 }),
				findFirst: async () => null,
			},
		};
		const prisma = {
			$transaction: async (callback: (client: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;
		await expect(
			prismaRunRecordStore(prisma).seal("row-1", 0, { status: "SEALED" }, []),
		).resolves.toBe(false);
	});

	it("reads no child dossier when the exact RUNNING generation cannot be locked", async () => {
		const findMany = vi.fn(async () => []);
		const updateMany = vi.fn(async () => ({ count: 1 }));
		const tx = {
			$queryRaw: async () => [],
			verificationResourceIntent: { findMany },
			verificationRun: { updateMany },
		};
		const prisma = {
			$transaction: async (callback: (client: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;

		await expect(
			prismaRunRecordStore(prisma).seal("row-1", 7, { status: "SEALED" }, []),
		).resolves.toBe(false);
		expect(findMany).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("recognizes an already-SEALED response-loss retry only for the exact digest, seal, and generation", async () => {
		const findFirst = vi.fn(async () => ({ id: "row-1" }));
		const findMany = vi.fn(async () => []);
		const updateMany = vi.fn(async () => ({ count: 0 }));
		const tx = {
			$queryRaw: async () => [],
			verificationResourceIntent: { findMany },
			verificationRun: {
				updateMany,
				findFirst,
			},
		};
		const prisma = {
			$transaction: async (callback: (client: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;
		const landed = await prismaRunRecordStore(prisma).seal(
			"row-1",
			7,
			{
				status: "SEALED",
				reportSha256: "a".repeat(64),
				seal: `hmac-sha256:${"b".repeat(64)}`,
			},
			[],
		);
		expect(landed).toBe(true);
		// A committed prior seal no longer holds the RUNNING lock. Recognize its
		// exact digest without reading a mutable child population or writing again.
		expect(findMany).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
		expect(findFirst).toHaveBeenCalledWith({
			where: {
				id: "row-1",
				status: "SEALED",
				recoveryGeneration: 7,
				recoveryOwner: null,
				recoveryLeaseUntil: null,
				reportSha256: "a".repeat(64),
				seal: `hmac-sha256:${"b".repeat(64)}`,
			},
			select: { id: true },
		});
	});

	it("uses id as the total-order tiebreaker when equal-createdAt rows arrive reversed", async () => {
		const expected = [
			{ id: "intent-a", recoveryOwner: null },
			{ id: "intent-b", recoveryOwner: null },
		];
		let seenOrder: unknown;
		const tx = {
			...runningParentLock,
			verificationResourceIntent: {
				findMany: async (args: { orderBy: unknown }) => {
					seenOrder = args.orderBy;
					const sameTimestampReverse = [...expected].reverse();
					return JSON.stringify(args.orderBy).includes('"id":"asc"')
						? expected
						: sameTimestampReverse;
				},
			},
			verificationRun: { updateMany: async () => ({ count: 1 }) },
		};
		const prisma = {
			$transaction: async (callback: (client: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;
		await expect(
			prismaRunRecordStore(prisma).seal(
				"row-1",
				0,
				{ status: "SEALED" },
				expected,
			),
		).resolves.toBe(true);
		expect(seenOrder).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
	});

	it("compares the database intent through the same owner-redacted projection as the sealed dossier", async () => {
		const owner = "verify:secret-recovery-owner";
		const current = [
			{
				id: "intent-1",
				recoveryOwner: owner,
				events: [
					{
						sequence: 1,
						eventType: "RECOVERY_CLAIMED",
						fromState: "AMBIGUOUS",
						toState: "AMBIGUOUS",
						cleanupState: "UNRESOLVED",
						details: { owner },
						createdAt: new Date("2026-09-01T00:00:00.000Z"),
					},
				],
			},
		];
		const expected = [
			{
				...current[0],
				recoveryOwner: REDACTED,
				events: [
					{
						...current[0]?.events[0],
						details: { owner: REDACTED },
					},
				],
			},
		];
		const updateMany = vi.fn(async () => ({ count: 1 }));
		const tx = {
			...runningParentLock,
			verificationResourceIntent: { findMany: async () => current },
			verificationRun: { updateMany },
		};
		const prisma = {
			$transaction: async (callback: (client: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;

		await expect(
			prismaRunRecordStore(prisma).seal(
				"row-1",
				0,
				{ status: "SEALED" },
				expected,
			),
		).resolves.toBe(true);
		expect(updateMany).toHaveBeenCalledOnce();
	});

	it("failed() is a RUNNING+generation CAS and cannot demote SEALED", async () => {
		const updateMany = vi.fn(async () => ({ count: 0 }));
		const prisma = {
			verificationRun: { updateMany },
		} as unknown as AppPrismaClient;
		await expect(
			prismaRunRecordStore(prisma).fail("row-1", 4, {
				status: "INCOMPLETE",
				error: "late failure",
			}),
		).resolves.toBe(false);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "row-1",
					status: "RUNNING",
					recoveryGeneration: 4,
					recoveryOwner: null,
					recoveryLeaseUntil: null,
				},
			}),
		);
	});

	it("refuses the DB transition when current intent rows differ from the sealed dossier", async () => {
		const updateMany = vi.fn(async () => ({ count: 1 }));
		const tx = {
			...runningParentLock,
			verificationResourceIntent: {
				findMany: async () => [{ id: "unexpected-intent" }],
			},
			verificationRun: { updateMany },
		};
		const prisma = {
			$transaction: async (callback: (client: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;
		await expect(
			prismaRunRecordStore(prisma).seal("row-1", 0, { status: "SEALED" }, []),
		).rejects.toThrow(/paid-resource intents changed/);
		expect(updateMany).not.toHaveBeenCalled();
	});
});

describe("prismaRunRecordStore.upsertLiveEvidence", () => {
	it("commits every output leg in one transaction — never a partially persisted tuple", async () => {
		const writes: Promise<unknown>[] = [];
		const batches: Array<readonly Promise<unknown>[]> = [];
		const prisma = {
			verificationLiveEvidence: {
				upsert: (args: unknown) => {
					const write = Promise.resolve(args);
					writes.push(write);
					return write;
				},
			},
			$transaction: async (batch: readonly Promise<unknown>[]) => {
				batches.push(batch);
				return Promise.all(batch);
			},
		} as unknown as AppPrismaClient;
		const tuple = { complete: true } as unknown as LiveEvidenceLeg;
		const rows: LiveEvidenceRow[] = ["hls@origin", "hls@edge"].map(
			(outputLeg) => ({
				verificationRunId: "run-row-1",
				scenario: "live-msl",
				liveChannelRunId: "airing-1",
				outputLeg,
				version: LIVE_EVIDENCE_VERSION,
				complete: true,
				missing: [],
				tuple,
			}),
		);

		await prismaRunRecordStore(prisma).upsertLiveEvidence?.(rows);

		expect(writes).toHaveLength(2);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toEqual(writes);
	});
});

describe("the small rules", () => {
	it.each([
		["https://a.example.com/x?y=1", "https://a.example.com"],
		["http://127.0.0.1:3100", "http://127.0.0.1:3100"],
		["not a url", undefined],
		[undefined, undefined],
	])("originOf(%s) = %s", (input, expected) => {
		expect(originOf(input)).toBe(expected);
	});

	it("bounds and redacts what an INCOMPLETE row may carry", () => {
		expect(recordableError(new Error("x".repeat(900)))).toHaveLength(500);
		expect(recordableError("scp://root:pw@host/f")).toBe(
			"scp://root:[REDACTED]@host/f",
		);
	});

	/**
	 * `redactSecrets` walks KEYS; over a bare string it can only strip URL
	 * userinfo. The runner authenticates with `Authorization: Bearer <secret>`
	 * and its errors are strings, so without this an INCOMPLETE row is one
	 * unlucky fetch failure away from storing a live credential.
	 */
	/**
	 * The bearer credential deliberately is NOT `bo_`-shaped. The first version
	 * of this arm used the harness's own token for both halves, so the bare-
	 * token rule scrubbed it and deleting the Bearer rule left the test GREEN
	 * (measured: that mutation survived). A negative assertion needs a fixture
	 * only the rule under test can satisfy — and the case is real, because the
	 * password flow's session cookie and any non-token Bearer ride the same
	 * header.
	 */
	it("scrubs a presented Bearer credential whatever its shape", () => {
		const credential = "eyJhbGciOiJIUzI1NiJ9.e30.Zm9vYmFy";
		const scrubbed = recordableError(
			new Error(`POST /api/x failed: Authorization: Bearer ${credential}`),
		);
		expect(scrubbed).not.toContain(credential);
		expect(scrubbed).toBe(
			`POST /api/x failed: Authorization: Bearer ${REDACTED}`,
		);
	});

	it("scrubs a bare bo_ token, with no scheme in front of it", () => {
		const secret = `bo_${"Z".repeat(43)}`;
		const bare = recordableError(`token ${secret} was rejected`);
		expect(bare).not.toContain(secret);
		expect(bare).toBe(`token ${REDACTED} was rejected`);
	});

	it("leaves ordinary prose alone — over-matching would redact scenario names", () => {
		expect(recordableError("scenario bo_short failed")).toBe(
			"scenario bo_short failed",
		);
		expect(recordableError("h264-hls: 17 checks passed")).toBe(
			"h264-hls: 17 checks passed",
		);
	});
});

describe("the live evidence tuple and the seal gate", () => {
	/** A COMPLETE leg; `incomplete` drops the progression (two identical snapshots). */
	function leg(
		options: {
			incomplete?: boolean;
			airing?: string | null;
			outputLeg?: string;
		} = {},
	): LiveEvidenceLeg {
		return sealLiveEvidenceLeg({
			version: LIVE_EVIDENCE_VERSION,
			scenario: "live-rtmp-simple",
			outputLeg: options.outputLeg ?? "hls@origin",
			manifestKey: "hls",
			outputKey: "origin",
			kind: "HLS",
			role: "ORIGIN",
			build: {
				commit: "b8c63e35",
				image: `worker@sha256:${"c".repeat(64)}`,
				planSha256: "a".repeat(64),
			},
			source: {
				location: "verify-in/bbb.mov",
				etag: '"1"',
				size: 2,
				sha256: "b".repeat(64),
			},
			channel: {
				channelId: "chan-1",
				...(options.airing === null
					? {}
					: { liveChannelRunId: options.airing ?? "run-1" }),
				providerEncodingId: "enc-1",
				providerStreamIds: { video: "stream-1" },
				providerOutputIds: { origin: "output-1" },
				requiredProviderStreamKeys: ["video"],
				requiredProviderOutputKeys: ["origin"],
			},
			output: { prefix: "verify/RUN1/live-rtmp-simple/" },
			topology: { expectedChildCount: 1, expectedChildIds: ["v1080"] },
			master: { key: "stream.m3u8", bytes: 100 },
			children: [
				{
					id: "v1080",
					requiresInit: false,
					listed: 3,
					media: [{ key: "seg-1.m4s", bytes: 500 }],
					missing: [],
				},
			],
			probes: [
				{ at: "t0", children: [{ id: "v1080", served: ["seg-1.m4s"] }] },
				{ at: "t1", children: [{ id: "v1080", served: ["seg-2.m4s"] }] },
			],
			progression: options.incomplete
				? { observed: false, detail: "identical media served at both probes" }
				: { observed: true, detail: "v1080: served seg-2.m4s at t1" },
			providerTerminal: {
				confirmed: true,
				encodingId: "enc-1",
				status: "CANCELED",
				observedAt: "2026-08-30T10:01:00.000Z",
				detail: "EV-01 exact provider readback",
			},
			cleanup: {
				clean: true,
				queueDrained: true,
				processGone: true,
				storageRetained: true,
				tokenCleanup: {
					required: false,
					confirmed: true,
					detail: "not required",
				},
			},
		});
	}
	const cleanSeal = { channelId: "chan-1", clean: true };

	function evidenceStore() {
		const { store, state } = fakeStore();
		const rows: LiveEvidenceRow[] = [];
		const withUpsert: RunRecordStore = {
			...store,
			upsertLiveEvidence: async (batch) => {
				rows.push(...batch);
			},
		};
		return { store: withUpsert, state, rows };
	}

	it("writes one child row per leg — keyed by (run, scenario, airing, leg) — carrying the whole tuple and its verdict", async () => {
		const { store, rows } = evidenceStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.liveEvidence({
			scenario: "live-rtmp-simple",
			legs: [leg(), leg({ incomplete: true, outputLeg: "dash@origin" })],
		});
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			verificationRunId: "row-1",
			scenario: "live-rtmp-simple",
			liveChannelRunId: "run-1",
			outputLeg: "hls@origin",
			version: LIVE_EVIDENCE_VERSION,
			complete: true,
			missing: [],
		});
		expect(rows[0]?.tuple.children[0]?.media[0]?.bytes).toBe(500);
		expect(rows[1]).toMatchObject({
			outputLeg: "dash@origin",
			complete: false,
			missing: ["progression: identical media served at both probes"],
		});
	});

	it("names an unidentified airing 'unknown' in the key — the tuple itself says the airing is missing", async () => {
		const { store, rows } = evidenceStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.liveEvidence({
			scenario: "s",
			legs: [leg({ airing: null })],
		});
		expect(rows[0]?.liveChannelRunId).toBe("unknown");
		expect(rows[0]?.complete).toBe(false);
		expect(rows[0]?.missing.join("\n")).toMatch(/liveChannelRunId/);
	});

	it("REFUSES to seal a PASS live outcome without a complete tuple: throws, writes no SEALED, and failed() lands INCOMPLETE naming the scenario", async () => {
		const { store, state } = evidenceStore();
		const recorder = createRunRecorder(store, { sleep: async () => {} });
		await recorder.reserve(RESERVE);
		let refused: unknown;
		await recorder
			.sealed(
				makeSealInput([
					// A live outcome — it carries the cleanup seal — but NO tuple: the audited shape.
					{
						scenario: "live-rtmp-simple",
						verdict: "PASS",
						reason: "verified",
						liveCleanup: cleanSeal,
					},
				]),
			)
			.catch((err) => {
				refused = err;
			});
		expect(refused).toBeInstanceOf(Error);
		expect(String((refused as Error).message)).toContain("live-rtmp-simple");
		expect(String((refused as Error).message)).toContain(
			"no durably persisted live evidence tuple",
		);
		expect(state.row.status).not.toBe("SEALED");
		expect(state.updates.some((u) => u.status === "SEALED")).toBe(false);
		await recorder.failed(refused);
		expect(state.row.status).toBe("INCOMPLETE");
		expect(String(state.row.error)).toContain("live-rtmp-simple");
	});

	it("REFUSES a selected LIVE scenario with no tuple even when the outcome lost every live-only field", async () => {
		const { store, state } = evidenceStore();
		const recorder = createRunRecorder(store, { sleep: async () => {} });
		await recorder.reserve(RESERVE);
		await recorder.context({
			scenarios: [{ name: "live-rtmp-simple", kind: "LIVE" }],
			fingerprint: FINGERPRINT,
		});
		const input = makeSealInput([
			{ scenario: "live-rtmp-simple", verdict: "PASS", reason: "verified" },
		]);
		await expect(recorder.preseal(input)).rejects.toThrow(
			/live-rtmp-simple.*no durably persisted live evidence tuple/,
		);
		expect(state.updates.some((update) => update.status === "SEALED")).toBe(
			false,
		);
		await expect(recorder.sealed(input)).rejects.toThrow(
			/live-rtmp-simple.*no durably persisted live evidence tuple/,
		);
		expect(state.row.status).not.toBe("SEALED");
	});

	it("REFUSES a WARN whose own summary has an incomplete leg, naming the element", async () => {
		const { store, state } = evidenceStore();
		const recorder = createRunRecorder(store, { sleep: async () => {} });
		await recorder.reserve(RESERVE);
		await recorder.liveEvidence({
			scenario: "live-rtmp-simple",
			legs: [leg(), leg({ incomplete: true, outputLeg: "dash@origin" })],
		});
		await expect(
			recorder.sealed(
				makeSealInput([
					{
						scenario: "live-rtmp-simple",
						verdict: "WARN",
						reason: "delivery warning",
						liveEvidence: summarizeLiveEvidence([
							leg(),
							leg({ incomplete: true, outputLeg: "dash@origin" }),
						]),
					},
				]),
			),
		).rejects.toThrow(/dash@origin: progression: identical media served/);
		expect(state.row.status).not.toBe("SEALED");
	});

	it("seals when every green live outcome is backed by a complete tuple — from the outcome's summary, or from the legs the recorder itself wrote", async () => {
		const { store, state } = evidenceStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.liveEvidence({
			scenario: "live-rtmp-simple",
			legs: [leg()],
		});
		// Scenario B's outcome carries no summary of its own; the recorder wrote its legs.
		await recorder.liveEvidence({ scenario: "live-b", legs: [leg()] });
		await recorder.sealed(
			makeSealInput([
				{
					scenario: "live-rtmp-simple",
					verdict: "PASS",
					reason: "verified",
					liveEvidence: summarizeLiveEvidence([leg()]),
				},
				{
					scenario: "live-b",
					verdict: "PASS",
					reason: "verified",
					liveCleanup: cleanSeal,
				},
			]),
		);
		expect(state.row.status).toBe("SEALED");
	});

	it("leaves VOD outcomes alone but REFUSES any persisted incomplete live tuple even when the delivery verdict is FAIL", async () => {
		const { store, state } = evidenceStore();
		const recorder = createRunRecorder(store);
		await recorder.reserve(RESERVE);
		await recorder.liveEvidence({
			scenario: "live-rtmp-simple",
			legs: [leg({ incomplete: true })],
		});
		await expect(
			recorder.sealed(
				makeSealInput([
					// A VOD PASS: no cleanup seal, no tuple, no legs recorded — not live.
					{
						scenario: "h264-hls",
						verdict: "PASS",
						reason: "verified",
					},
					// A live FAIL over an incomplete tuple is consistent evidence.
					{
						scenario: "live-rtmp-simple",
						verdict: "FAIL",
						reason: "delivery failed",
						liveCleanup: cleanSeal,
						liveEvidence: summarizeLiveEvidence([leg({ incomplete: true })]),
					},
					// A live INVALID with no tuple at all — the gate refused it upstream already.
					{
						scenario: "live-srt-listener",
						verdict: "INVALID",
						reason: "harness incomplete",
						liveCleanup: cleanSeal,
					},
				]),
			),
		).rejects.toThrow(/live-rtmp-simple.*incomplete evidence tuple/);
		expect(state.row.status).not.toBe("SEALED");
	});

	it("REFUSES immediately when the store cannot persist child rows — memory is never a durable seal", async () => {
		const { store, state } = fakeStore();
		expect(store.upsertLiveEvidence).toBeUndefined();
		const recorder = createRunRecorder(store, { sleep: async () => {} });
		await recorder.reserve(RESERVE);
		await expect(
			recorder.liveEvidence({ scenario: "live-a", legs: [leg()] }),
		).rejects.toThrow(/durable live evidence store/);
		expect(state.row.status).not.toBe("SEALED");
	});

	it("REFUSES a child-row write failure and cannot later seal from the in-memory tuple", async () => {
		const { store, state } = evidenceStore();
		store.upsertLiveEvidence = async () => {
			throw new Error("database unavailable");
		};
		const recorder = createRunRecorder(store, { sleep: async () => {} });
		await recorder.reserve(RESERVE);
		await expect(
			recorder.liveEvidence({ scenario: "live-a", legs: [leg()] }),
		).rejects.toThrow(/database unavailable/);
		await expect(
			recorder.sealed(
				makeSealInput([
					{
						scenario: "live-a",
						verdict: "PASS",
						reason: "verified",
						liveCleanup: cleanSeal,
					},
				]),
			),
		).rejects.toThrow(/no durably persisted live evidence tuple/);
		expect(state.row.status).not.toBe("SEALED");
	});
});
