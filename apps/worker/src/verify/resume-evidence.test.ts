import { createHash } from "node:crypto";
import {
	LIVE_EVIDENCE_VERSION,
	verificationIntentClosureDigest,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it } from "vitest";
import { sealReport } from "./harness-rails";
import {
	buildEvidenceManifest,
	EVIDENCE_VERSION,
	evidenceSealPolicy,
	loadResumeEvidence,
	prismaResumeEvidenceStore,
	type ResumeEvidenceInput,
	type ResumeEvidenceManifest,
	type ResumeEvidenceResult,
	type ResumeEvidenceRow,
	sealKeyringFromEnv,
} from "./resume-evidence";
import type { RunReport } from "./runner";

const sha256 = (value: string): string =>
	createHash("sha256").update(value).digest("hex");

const RUN_ID = "release-run-a";
const REPORT_PATH = `/evidence/${RUN_ID}/report.json`;
const PLAN_PATH = `/evidence/${RUN_ID}/fixed.plan.json`;
const SCENARIO_PATH = `/evidence/${RUN_ID}/fixed.report.json`;
const KEY = "release-key-material";
const RETENTION = new Date("2027-01-01T00:00:00.000Z");

type EvidenceFixture = {
	files: Map<string, string>;
	manifest: ResumeEvidenceManifest;
	report: RunReport;
	reportJson: string;
	reportMarkdown: string;
	row: ResumeEvidenceRow;
	run: (
		overrides?: Partial<ResumeEvidenceInput>,
	) => Promise<ResumeEvidenceResult>;
	seal: string;
};

function fixture(
	options: { algorithm?: "HMAC_SHA256" | "SHA256"; commit?: string } = {},
): EvidenceFixture {
	const algorithm = options.algorithm ?? "HMAC_SHA256";
	const plan = '{"plan":"fixed"}\n';
	const scenario = '{"checks":{"PASS":12}}\n';
	const reportMarkdown = "# verify run release-run-a\n\nPASS 1\n";
	const manifest: ResumeEvidenceManifest = {
		version: EVIDENCE_VERSION,
		scenarios: [
			{
				scenario: "fixed",
				planFile: "fixed.plan.json",
				planSha256: sha256(plan),
				reportFile: "fixed.report.json",
				reportSha256: sha256(scenario),
			},
		],
	};
	const outcome = {
		scenario: "fixed",
		verdict: "PASS" as const,
		reason: "verified",
		planSha256: "d".repeat(64),
		sourceObject: "bbb.mp4",
		sourceIdentity: "etag=abc;size=123",
		bitmovinAccountId: "account-a",
	};
	const report: RunReport = {
		runId: RUN_ID,
		startedAt: "2026-08-31T00:00:00.000Z",
		finishedAt: "2026-08-31T00:01:00.000Z",
		fingerprint: {
			commit: options.commit ?? "a".repeat(40),
			checkoutLatestMigration: "20260830130000_verification_seal_authority",
			dbLatestMigration: "20260830130000_verification_seal_authority",
			drift: false,
		},
		preflight: [
			{
				capability: "S3",
				satisfied: true,
				evidence: "input and output buckets listed",
			},
		],
		outcomes: [outcome],
		counts: { PASS: 1, WARN: 0, FAIL: 0, SKIP: 0, INVALID: 0 },
		evidence: {
			version: EVIDENCE_VERSION,
			algorithm,
			keyId: algorithm === "HMAC_SHA256" ? "key-a" : null,
			retentionUntil: RETENTION.toISOString(),
			manifest,
			reportMarkdownSha256: sha256(reportMarkdown),
		},
		resourceIntents: [],
	};
	const reportJson = `${JSON.stringify(report, null, "\t")}\n`;
	const seal =
		algorithm === "HMAC_SHA256"
			? sealReport(reportJson, KEY)
			: sealReport(reportJson);
	const row: ResumeEvidenceRow = {
		id: "00000000-0000-4000-8000-000000000001",
		runId: RUN_ID,
		status: "SEALED",
		sealedAt: new Date("2026-08-31T00:00:00.000Z"),
		reportPath: REPORT_PATH,
		reportJson,
		reportMarkdown,
		reportSha256: sha256(reportJson),
		seal,
		sealAlgorithm: algorithm,
		sealKeyId: algorithm === "HMAC_SHA256" ? "key-a" : null,
		evidenceVersion: EVIDENCE_VERSION,
		retentionUntil: RETENTION,
		commit: report.fingerprint.commit,
		checkoutLatestMigration: report.fingerprint.checkoutLatestMigration,
		dbLatestMigration: report.fingerprint.dbLatestMigration,
		drift: false,
		bitmovinAccountId: "account-a",
		outcomes: report.outcomes,
		counts: report.counts,
		evidenceManifest: manifest,
		resumedFromId: null,
		recoveryOwner: null,
		recoveryLeaseUntil: null,
		recoveryGeneration: 0,
		liveEvidence: [],
		intents: [],
	};
	const files = new Map([
		[REPORT_PATH, reportJson],
		[`${REPORT_PATH.slice(0, -"report.json".length)}report.md`, reportMarkdown],
		[`${REPORT_PATH.slice(0, -"report.json".length)}report.seal`, `${seal}\n`],
		[PLAN_PATH, plan],
		[SCENARIO_PATH, scenario],
	]);
	const run = (overrides: Partial<ResumeEvidenceInput> = {}) =>
		loadResumeEvidence({
			runId: RUN_ID,
			reportPath: REPORT_PATH,
			releaseMode: true,
			keyring: { activeKeyId: "key-b", keys: { "key-a": KEY, "key-b": "new" } },
			now: () => new Date("2026-09-01T00:00:00.000Z"),
			store: { findByRunId: async () => row },
			readText: async (path) => {
				const value = files.get(path);
				if (value === undefined) throw new Error(`ENOENT ${path}`);
				return value;
			},
			...overrides,
		});
	return {
		files,
		manifest,
		report,
		reportJson,
		reportMarkdown,
		row,
		run,
		seal,
	};
}

function resealFixture(f: EvidenceFixture): void {
	const reportJson = `${JSON.stringify(f.report, null, "\t")}\n`;
	const seal = sealReport(reportJson, KEY);
	f.reportJson = reportJson;
	f.seal = seal;
	f.row.reportJson = reportJson;
	f.row.reportSha256 = sha256(reportJson);
	f.row.seal = seal;
	f.row.outcomes = f.report.outcomes;
	f.row.counts = f.report.counts;
	f.row.evidenceManifest = f.report.evidence?.manifest ?? null;
	f.files.set(REPORT_PATH, reportJson);
	f.files.set(
		`${REPORT_PATH.slice(0, -"report.json".length)}report.seal`,
		`${seal}\n`,
	);
}

describe("loadResumeEvidence", () => {
	it("accepts only a full DB/file/scenario agreement and uses the old key while it remains in the rotation keyring", async () => {
		const f = fixture();
		await expect(f.run()).resolves.toMatchObject({
			ok: true,
			rowId: f.row.id,
			runId: RUN_ID,
			audit: {
				algorithm: "HMAC_SHA256",
				keyId: "key-a",
				retentionUntil: RETENTION.toISOString(),
			},
		});
	});

	it("refuses a forged report even when the attacker regenerates a plain SHA seal", async () => {
		const f = fixture();
		const forged = f.reportJson.replace('"PASS"', '"FAIL"');
		f.files.set(REPORT_PATH, forged);
		f.files.set(
			`${REPORT_PATH.slice(0, -"report.json".length)}report.seal`,
			`${sealReport(forged)}\n`,
		);
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "DB_FILE_REPORT_MISMATCH",
		});
	});

	it("refuses a file whose bytes differ from the complete report stored in the SEALED row", async () => {
		const f = fixture();
		f.files.set(REPORT_PATH, f.reportJson.replace('"PASS"', '"WARN"'));
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "DB_FILE_REPORT_MISMATCH",
		});
	});

	it("refuses a legacy SEALED row that has no self-contained report bytes", async () => {
		const f = fixture();
		f.row.reportJson = null;
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "DB_REPORT_MISSING",
		});
	});

	it("refuses a SEALED row whose stored report bytes do not match its DB digest", async () => {
		const f = fixture();
		f.row.reportJson = f.reportJson.replace('"PASS"', '"WARN"');
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "DB_REPORT_DIGEST_MISMATCH",
		});
	});

	it("refuses a one-byte Markdown mutation even when JSON and its HMAC are unchanged", async () => {
		const f = fixture();
		f.row.reportMarkdown = `${f.reportMarkdown}x`;
		f.files.set(
			`${REPORT_PATH.slice(0, -"report.json".length)}report.md`,
			`${f.reportMarkdown}x`,
		);
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "DB_REPORT_MARKDOWN_DIGEST_MISMATCH",
		});
	});

	it("refuses a plain SHA seal whose database metadata claims HMAC", async () => {
		const f = fixture();
		const weakSeal = sealReport(f.reportJson);
		f.row.seal = weakSeal;
		f.files.set(
			`${REPORT_PATH.slice(0, -"report.json".length)}report.seal`,
			`${weakSeal}\n`,
		);
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "SEAL_ALGORITHM_MISMATCH",
		});
	});

	it("refuses an HMAC-valid report that gives one scenario contradictory verdicts", async () => {
		const f = fixture();
		f.report.outcomes = [
			{ scenario: "fixed", verdict: "PASS", reason: "verified" },
			{ scenario: "fixed", verdict: "FAIL", reason: "contradiction" },
		];
		f.report.counts = { PASS: 1, WARN: 0, FAIL: 1, SKIP: 0, INVALID: 0 };
		resealFixture(f);
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "REPORT_INVALID",
		});
	});

	it("refuses an HMAC-valid outcome that omits its required reason", async () => {
		const f = fixture();
		f.report.outcomes = [
			{ scenario: "fixed", verdict: "PASS" } as RunReport["outcomes"][number],
		];
		resealFixture(f);
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "REPORT_INVALID",
		});
	});

	it("refuses a SEALED report whose own paid-resource intent remains open", async () => {
		const f = fixture();
		const openIntent = {
			id: "10000000-0000-4000-8000-000000000001",
			scenario: "fixed",
			kind: "VOD_JOB",
			verificationKey: "verify:release-run-a:fixed:VOD_JOB",
			requestSha256: "d".repeat(64),
			resourceName: "fixed",
			state: "PREPARED",
			localId: null,
			providerId: null,
			providerIds: [],
			candidates: null,
			cleanupState: "PENDING",
			readback: null,
			possiblyCreatedKeys: [],
			cleanedResourceKeys: [],
			closureDigest: null,
			error: null,
			recoveryOwner: null,
			recoveryLeaseUntil: null,
			recoveryGeneration: 0,
			events: [],
		};
		f.report.resourceIntents = [openIntent as never];
		f.row.intents = [openIntent as never];
		resealFixture(f);
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "RESOURCE_INTENTS_UNSEALED",
		});
	});

	it("refuses a report rebuilt after explicit restart recovery even if the run fence write was lost", async () => {
		const f = fixture();
		const closure = {
			verificationKey: "verify:release-run-a:fixed:VOD_JOB",
			requestSha256: "d".repeat(64),
			state: "TERMINAL" as const,
			cleanupState: "NEVER_CREATED" as const,
			providerIds: [],
			possiblyCreatedKeys: [],
			cleanedResourceKeys: [],
			candidates: null,
			readback: { neverSent: true },
		};
		const recoveredIntent = {
			id: "10000000-0000-4000-8000-000000000002",
			scenario: "fixed",
			kind: "VOD_JOB" as const,
			...closure,
			resourceName: "fixed",
			localId: null,
			providerId: null,
			closureDigest: verificationIntentClosureDigest(closure),
			error: null,
			recoveryOwner: null,
			recoveryLeaseUntil: null,
			recoveryGeneration: 1,
			events: [
				{
					sequence: 1,
					eventType: "RECOVERY_CLAIMED",
					fromState: "PREPARED",
					toState: "PREPARED",
					cleanupState: "PENDING",
					details: { owner: "verify-recover:release-run-a:operator" },
					createdAt: new Date("2026-09-01T00:00:00.000Z"),
				},
			],
		};
		f.report.resourceIntents = [recoveredIntent];
		f.row.intents = [recoveredIntent];
		resealFixture(f);
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "RESOURCE_INTENTS_RECOVERED",
		});
	});

	const refusalCases: readonly [
		name: string,
		mutate: (fixture: EvidenceFixture) => void,
		code: string,
	][] = [
		[
			"DB is not SEALED",
			(f) => {
				f.row.status = "RUNNING";
			},
			"DB_NOT_SEALED",
		],
		[
			"the report is absent",
			(f) => {
				f.files.delete(REPORT_PATH);
			},
			"REPORT_MISSING",
		],
		[
			"the path was swapped",
			(f) => {
				f.row.reportPath = "/other/report.json";
			},
			"REPORT_PATH_MISMATCH",
		],
		[
			"scenario evidence is absent",
			(f) => {
				f.files.delete(SCENARIO_PATH);
			},
			"SCENARIO_EVIDENCE_MISSING",
		],
		[
			"retention expired",
			(f) => {
				f.row.retentionUntil = new Date("2026-08-31T00:00:00.000Z");
			},
			"RETENTION_EXPIRED",
		],
		[
			"the report belongs to another commit",
			(f) => {
				f.row.commit = "b".repeat(40);
			},
			"FINGERPRINT_MISMATCH",
		],
	];

	it.each(refusalCases)("refuses when %s", async (_name, mutate, code) => {
		const f = fixture();
		mutate(f);
		await expect(f.run()).resolves.toMatchObject({ ok: false, code });
	});

	it("refuses key rotation after the historical key has been retired", async () => {
		const f = fixture();
		await expect(
			f.run({ keyring: { activeKeyId: "key-b", keys: { "key-b": "new" } } }),
		).resolves.toMatchObject({ ok: false, code: "SEAL_KEY_UNAVAILABLE" });
	});

	it("refuses a sealed historical live tuple whose attribution contract predates current-run URL binding", async () => {
		const f = fixture();
		const oldTuple = {
			version: LIVE_EVIDENCE_VERSION - 1,
			outputLeg: "hls@mirror-1",
			complete: true,
		};
		const scenario = `${JSON.stringify({ evidence: [oldTuple] }, null, "\t")}\n`;
		f.files.set(SCENARIO_PATH, scenario);
		const entry = f.manifest.scenarios[0];
		if (!entry) throw new Error("fixture scenario missing");
		entry.reportSha256 = sha256(scenario);
		f.row.liveEvidence = [
			{
				scenario: "fixed",
				outputLeg: "hls@mirror-1",
				tuple: oldTuple,
			},
		];
		const reportJson = `${JSON.stringify(f.report, null, "\t")}\n`;
		const seal = sealReport(reportJson, KEY);
		f.row.reportSha256 = sha256(reportJson);
		f.row.reportJson = reportJson;
		f.row.seal = seal;
		f.files.set(REPORT_PATH, reportJson);
		f.files.set(
			`${REPORT_PATH.slice(0, -"report.json".length)}report.seal`,
			`${seal}\n`,
		);
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "LIVE_EVIDENCE_MISMATCH",
		});
	});

	it("classifies a legacy SHA-only seal as local-only and never release-resumable", async () => {
		const f = fixture({ algorithm: "SHA256" });
		await expect(f.run()).resolves.toMatchObject({
			ok: false,
			code: "LEGACY_WEAK_SEAL",
		});
		await expect(f.run({ releaseMode: false })).resolves.toMatchObject({
			ok: true,
		});
	});
});

describe("prismaResumeEvidenceStore intent ordering", () => {
	it("uses id to break equal createdAt timestamps for the evidence consumer", async () => {
		let seen: unknown;
		const prisma = {
			verificationRun: {
				findUnique: async (args: {
					select: { intents: { orderBy: unknown } };
				}) => {
					seen = args.select.intents.orderBy;
					return null;
				},
			},
		} as unknown as AppPrismaClient;
		await prismaResumeEvidenceStore(prisma).findByRunId("run-a");
		expect(seen).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
	});
});

describe("evidence sealing inputs", () => {
	it("builds the manifest from the exact retained PASS plan and report bytes", async () => {
		const files = new Map([
			["/run/a.plan.json", "plan-a"],
			["/run/a.report.json", "report-a"],
		]);
		await expect(
			buildEvidenceManifest({
				runDir: "/run",
				outcomes: [
					{ scenario: "a", verdict: "PASS" },
					{ scenario: "skip", verdict: "SKIP" },
				],
				readText: async (path) => {
					const value = files.get(path);
					if (!value) throw new Error("missing");
					return value;
				},
			}),
		).resolves.toEqual({
			version: EVIDENCE_VERSION,
			scenarios: [
				{
					scenario: "a",
					planFile: "a.plan.json",
					planSha256: sha256("plan-a"),
					reportFile: "a.report.json",
					reportSha256: sha256("report-a"),
				},
			],
		});
	});

	it("refuses release mode before spend when no active HMAC key is configured", () => {
		expect(() =>
			evidenceSealPolicy({ releaseMode: true, keyring: { keys: {} } }),
		).toThrow(/release verification requires an active HMAC key/i);
	});

	it("parses a rotation keyring without exposing it in the returned policy metadata", () => {
		const keyring = sealKeyringFromEnv({
			VERIFY_SEAL_KEY_ID: "key-b",
			VERIFY_SEAL_KEYS: JSON.stringify({
				"key-a": KEY,
				"key-b": "new-key-material-123",
			}),
		});
		expect(
			evidenceSealPolicy({
				releaseMode: true,
				keyring,
				now: () => new Date("2026-09-01T00:00:00.000Z"),
			}),
		).toMatchObject({ algorithm: "HMAC_SHA256", keyId: "key-b" });
	});

	it("refuses a short compatibility HMAC key", () => {
		expect(() => sealKeyringFromEnv({ VERIFY_SEAL_KEY: "too-short" })).toThrow(
			/at least 16 characters/,
		);
	});
});
