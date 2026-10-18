import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
	isVerificationIntentKind,
	isVerificationIntentState,
	LIVE_EVIDENCE_VERSION,
	type VerificationIntentCleanupState,
	type VerificationIntentKind,
	type VerificationIntentState,
	verificationIntentsSealable,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { verifyReportSeal } from "./harness-rails";
import type { CapabilityState } from "./preflight";

export const EVIDENCE_VERSION = 1;

export type SealAlgorithm = "SHA256" | "HMAC_SHA256";

export type ResumeEvidenceManifest = {
	version: typeof EVIDENCE_VERSION;
	scenarios: {
		scenario: string;
		planFile: string;
		planSha256: string;
		reportFile: string;
		reportSha256: string;
	}[];
};

export type ResumeEvidenceRow = {
	id: string;
	runId: string;
	status: string;
	sealedAt: Date | null;
	reportPath: string;
	reportJson: string | null;
	reportMarkdown: string | null;
	reportSha256: string | null;
	seal: string | null;
	sealAlgorithm: string | null;
	sealKeyId: string | null;
	evidenceVersion: number | null;
	retentionUntil: Date | null;
	commit: string;
	checkoutLatestMigration: string;
	dbLatestMigration: string;
	drift: boolean;
	bitmovinAccountId: string | null;
	outcomes: unknown;
	counts: unknown;
	evidenceManifest: unknown;
	resumedFromId: string | null;
	recoveryOwner: string | null;
	recoveryLeaseUntil: Date | null;
	recoveryGeneration: number;
	intents: ResumeEvidenceIntentRow[];
	liveEvidence: readonly {
		scenario: string;
		outputLeg: string;
		tuple: unknown;
	}[];
};

export type ResumeEvidenceIntentEvent = {
	sequence: number;
	eventType: string;
	fromState: string | null;
	toState: string | null;
	cleanupState: string | null;
	details: unknown;
	createdAt: Date | string;
};

export type ResumeEvidenceIntentRow = {
	id: string;
	scenario: string;
	kind: VerificationIntentKind;
	verificationKey: string;
	requestSha256: string;
	resourceName: string | null;
	state: VerificationIntentState;
	localId: string | null;
	providerId: string | null;
	providerIds: string[];
	candidates: unknown[] | null;
	cleanupState: VerificationIntentCleanupState;
	readback: unknown;
	possiblyCreatedKeys: string[];
	cleanedResourceKeys: string[];
	closureDigest: string | null;
	error: string | null;
	recoveryOwner: string | null;
	recoveryLeaseUntil: Date | string | null;
	recoveryGeneration: number;
	events: ResumeEvidenceIntentEvent[];
};

export type ResumeEvidenceStore = {
	findByRunId: (runId: string) => Promise<ResumeEvidenceRow | null>;
};

export function prismaResumeEvidenceStore(
	prisma: AppPrismaClient,
): ResumeEvidenceStore {
	return {
		findByRunId: async (runId) => {
			const row = await prisma.verificationRun.findUnique({
				where: { runId },
				select: {
					id: true,
					runId: true,
					status: true,
					sealedAt: true,
					reportPath: true,
					reportJson: true,
					reportMarkdown: true,
					reportSha256: true,
					seal: true,
					sealAlgorithm: true,
					sealKeyId: true,
					evidenceVersion: true,
					retentionUntil: true,
					commit: true,
					checkoutLatestMigration: true,
					dbLatestMigration: true,
					drift: true,
					bitmovinAccountId: true,
					outcomes: true,
					counts: true,
					evidenceManifest: true,
					resumedFromId: true,
					recoveryOwner: true,
					recoveryLeaseUntil: true,
					recoveryGeneration: true,
					intents: {
						orderBy: [{ createdAt: "asc" }, { id: "asc" }],
						select: {
							id: true,
							scenario: true,
							kind: true,
							verificationKey: true,
							requestSha256: true,
							resourceName: true,
							state: true,
							localId: true,
							providerId: true,
							providerIds: true,
							candidates: true,
							cleanupState: true,
							readback: true,
							possiblyCreatedKeys: true,
							cleanedResourceKeys: true,
							closureDigest: true,
							error: true,
							recoveryOwner: true,
							recoveryLeaseUntil: true,
							recoveryGeneration: true,
							events: {
								orderBy: { sequence: "asc" },
								select: {
									sequence: true,
									eventType: true,
									fromState: true,
									toState: true,
									cleanupState: true,
									details: true,
									createdAt: true,
								},
							},
						},
					},
					liveEvidence: {
						select: { scenario: true, outputLeg: true, tuple: true },
					},
				},
			});
			return row
				? {
						...row,
						intents: row.intents.map((intent) => ({
							...intent,
							kind: intent.kind as VerificationIntentKind,
							state: intent.state as VerificationIntentState,
							cleanupState:
								intent.cleanupState as VerificationIntentCleanupState,
							candidates: Array.isArray(intent.candidates)
								? intent.candidates
								: null,
						})),
					}
				: null;
		},
	};
}

export type ResumeEvidenceAudit = {
	decision: "ACCEPTED" | "REFUSED";
	reason: string;
	reportSha256?: string;
	seal?: string;
	algorithm?: string;
	keyId?: string | null;
	retentionUntil?: string;
	resumedFromId?: string | null;
};

export type ResumeEvidenceResult =
	| {
			ok: true;
			rowId: string;
			runId: string;
			report: ResumeReport;
			audit: ResumeEvidenceAudit;
	  }
	| {
			ok: false;
			code: string;
			reason: string;
			audit: ResumeEvidenceAudit;
	  };

export type ResumeReport = {
	runId: string;
	startedAt: string;
	finishedAt: string;
	fingerprint: {
		commit: string;
		checkoutLatestMigration: string;
		dbLatestMigration: string;
		drift: boolean;
	};
	preflight: CapabilityState[];
	outcomes: {
		scenario: string;
		verdict: string;
		reason: string;
		bitmovinAccountId?: string | null;
		liveEvidence?: unknown;
		[key: string]: unknown;
	}[];
	counts: Record<string, number>;
	evidence: {
		version: number;
		algorithm: SealAlgorithm;
		keyId: string | null;
		retentionUntil: string;
		manifest: ResumeEvidenceManifest;
		/** SHA-256 of the exact report.md bytes; this field is inside report.json's seal. */
		reportMarkdownSha256: string;
	};
	resourceIntents: ResumeEvidenceIntentRow[];
	[key: string]: unknown;
};

export type ResumeEvidenceInput = {
	runId: string;
	reportPath: string;
	releaseMode: boolean;
	keyring: { activeKeyId?: string; keys: Readonly<Record<string, string>> };
	now?: () => Date;
	store: ResumeEvidenceStore;
	readText: (path: string) => Promise<string>;
};

export type EvidenceSealPolicy = {
	algorithm: SealAlgorithm;
	keyId: string | null;
	key?: string;
	retentionUntil: string;
};

export function sealKeyringFromEnv(env: NodeJS.ProcessEnv): {
	activeKeyId?: string;
	keys: Record<string, string>;
} {
	const keys: Record<string, string> = {};
	const encoded = env.VERIFY_SEAL_KEYS?.trim();
	if (encoded) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(encoded);
		} catch {
			throw new Error(
				"VERIFY_SEAL_KEYS must be a JSON object of key-id to key material",
			);
		}
		if (
			parsed === null ||
			Array.isArray(parsed) ||
			typeof parsed !== "object"
		) {
			throw new Error(
				"VERIFY_SEAL_KEYS must be a JSON object of key-id to key material",
			);
		}
		for (const [id, value] of Object.entries(
			parsed as Record<string, unknown>,
		)) {
			if (
				!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ||
				typeof value !== "string" ||
				value.length < 16
			) {
				throw new Error(
					"VERIFY_SEAL_KEYS contains an invalid key id or key shorter than 16 characters",
				);
			}
			keys[id] = value;
		}
	}
	const explicitId = env.VERIFY_SEAL_KEY_ID?.trim();
	const legacy = env.VERIFY_SEAL_KEY;
	if (legacy) {
		if (legacy.length < 16) {
			throw new Error("VERIFY_SEAL_KEY must contain at least 16 characters");
		}
		const id = explicitId || "legacy-env";
		keys[id] = legacy;
	}
	const activeKeyId = explicitId || (legacy ? "legacy-env" : undefined);
	return { ...(activeKeyId ? { activeKeyId } : {}), keys };
}

export function evidenceSealPolicy(input: {
	releaseMode: boolean;
	keyring: { activeKeyId?: string; keys: Readonly<Record<string, string>> };
	retentionDays?: number;
	now?: () => Date;
}): EvidenceSealPolicy {
	const retentionDays = input.retentionDays ?? 90;
	if (
		!Number.isSafeInteger(retentionDays) ||
		retentionDays < 1 ||
		retentionDays > 3650
	) {
		throw new Error(
			"verification evidence retention must be 1..3650 whole days",
		);
	}
	const active = input.keyring.activeKeyId;
	const key = active ? input.keyring.keys[active] : undefined;
	if (input.releaseMode && (!active || !key)) {
		throw new Error(
			"release verification requires an active HMAC key id and key material (VERIFY_SEAL_KEY_ID plus VERIFY_SEAL_KEYS/VERIFY_SEAL_KEY)",
		);
	}
	if (active && !key) {
		throw new Error(
			`active verification seal key ${active} is absent from the keyring`,
		);
	}
	const now = (input.now ?? (() => new Date()))();
	const retentionUntil = new Date(
		now.getTime() + retentionDays * 24 * 60 * 60 * 1000,
	).toISOString();
	return active && key
		? { algorithm: "HMAC_SHA256", keyId: active, key, retentionUntil }
		: { algorithm: "SHA256", keyId: null, retentionUntil };
}

export async function buildEvidenceManifest(input: {
	runDir: string;
	outcomes: readonly { scenario: string; verdict: string }[];
	readText: (path: string) => Promise<string>;
	/** Dry runs are diagnostic and deliberately not release-resumable. */
	allowMissing?: boolean;
}): Promise<ResumeEvidenceManifest> {
	const scenarios: ResumeEvidenceManifest["scenarios"] = [];
	for (const outcome of input.outcomes) {
		if (outcome.verdict !== "PASS") continue;
		if (!isSafeScenario(outcome.scenario)) {
			throw new Error(
				`scenario ${outcome.scenario} cannot name an evidence file safely`,
			);
		}
		const planFile = `${outcome.scenario}.plan.json`;
		const reportFile = `${outcome.scenario}.report.json`;
		let plan: string;
		let report: string;
		try {
			[plan, report] = await Promise.all([
				input.readText(join(input.runDir, planFile)),
				input.readText(join(input.runDir, reportFile)),
			]);
		} catch (err) {
			if (input.allowMissing) continue;
			throw new Error(
				`PASS scenario ${outcome.scenario} has no retained plan/report evidence: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		scenarios.push({
			scenario: outcome.scenario,
			planFile,
			planSha256: sha256(plan),
			reportFile,
			reportSha256: sha256(report),
		});
	}
	return { version: EVIDENCE_VERSION, scenarios };
}

const sha256 = (value: string): string =>
	createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): string {
	if (value instanceof Date) {
		return JSON.stringify(value.toISOString());
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Date-normalized structural equality for DB JSON/Date rows and report JSON. */
export function evidenceValuesEqual(left: unknown, right: unknown): boolean {
	return canonical(left) === canonical(right);
}

function fail(
	code: string,
	reason: string,
	partial: Omit<ResumeEvidenceAudit, "decision" | "reason"> = {},
): ResumeEvidenceResult {
	return {
		ok: false,
		code,
		reason,
		audit: { decision: "REFUSED", reason, ...partial },
	};
}

function isSafeScenario(value: string): boolean {
	return (
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..")
	);
}

function isEvidenceManifest(value: unknown): value is ResumeEvidenceManifest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ResumeEvidenceManifest>;
	return (
		candidate.version === EVIDENCE_VERSION &&
		Array.isArray(candidate.scenarios) &&
		candidate.scenarios.every(
			(entry) =>
				typeof entry?.scenario === "string" &&
				typeof entry.planFile === "string" &&
				/^[a-f0-9]{64}$/.test(entry.planSha256) &&
				typeof entry.reportFile === "string" &&
				/^[a-f0-9]{64}$/.test(entry.reportSha256),
		)
	);
}

const REPORT_VERDICTS = ["PASS", "WARN", "FAIL", "SKIP", "INVALID"] as const;
const INTENT_CLEANUP_STATES = [
	"PENDING",
	"CLEANED",
	"NEVER_CREATED",
	"UNRESOLVED",
] as const satisfies readonly VerificationIntentCleanupState[];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
	return (
		value === undefined ||
		(typeof value === "number" && Number.isFinite(value) && value >= 0)
	);
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isIntentEvent(value: unknown): value is ResumeEvidenceIntentEvent {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.sequence) &&
		Number(value.sequence) >= 0 &&
		typeof value.eventType === "string" &&
		value.eventType.length > 0 &&
		isNullableString(value.fromState) &&
		isNullableString(value.toState) &&
		isNullableString(value.cleanupState) &&
		isIsoDate(value.createdAt)
	);
}

function isIntentEventSequence(
	value: unknown,
): value is ResumeEvidenceIntentEvent[] {
	if (!Array.isArray(value) || !value.every(isIntentEvent)) return false;
	return value.every((event, index) => {
		const previous = value[index - 1];
		return (
			index === 0 ||
			(previous !== undefined && event.sequence > previous.sequence)
		);
	});
}

function isReportIntent(value: unknown): value is ResumeEvidenceIntentRow {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.scenario === "string" &&
		isSafeScenario(value.scenario) &&
		isVerificationIntentKind(value.kind) &&
		typeof value.verificationKey === "string" &&
		value.verificationKey.length > 0 &&
		typeof value.requestSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.requestSha256) &&
		isNullableString(value.resourceName) &&
		isVerificationIntentState(value.state) &&
		isNullableString(value.localId) &&
		isNullableString(value.providerId) &&
		isStringArray(value.providerIds) &&
		(value.candidates === null || Array.isArray(value.candidates)) &&
		INTENT_CLEANUP_STATES.includes(
			value.cleanupState as VerificationIntentCleanupState,
		) &&
		isStringArray(value.possiblyCreatedKeys) &&
		isStringArray(value.cleanedResourceKeys) &&
		isNullableString(value.closureDigest) &&
		(value.closureDigest === null ||
			/^[a-f0-9]{64}$/.test(value.closureDigest)) &&
		isNullableString(value.error) &&
		isNullableString(value.recoveryOwner) &&
		(value.recoveryLeaseUntil === null ||
			isIsoDate(value.recoveryLeaseUntil)) &&
		Number.isSafeInteger(value.recoveryGeneration) &&
		Number(value.recoveryGeneration) >= 0 &&
		isIntentEventSequence(value.events)
	);
}

function isReportOutcome(
	value: unknown,
): value is ResumeReport["outcomes"][number] {
	if (!isRecord(value)) return false;
	return (
		typeof value.scenario === "string" &&
		isSafeScenario(value.scenario) &&
		REPORT_VERDICTS.includes(
			value.verdict as (typeof REPORT_VERDICTS)[number],
		) &&
		typeof value.reason === "string" &&
		value.reason.trim().length > 0 &&
		isOptionalString(value.jobId) &&
		isOptionalString(value.encodingId) &&
		isOptionalNonNegativeNumber(value.elapsedMs) &&
		isOptionalNonNegativeNumber(value.firstPublishMs) &&
		isOptionalString(value.firstPublishNote) &&
		(value.submittedVia === undefined ||
			value.submittedVia === "wizard-form" ||
			value.submittedVia === "wizard-import") &&
		isOptionalString(value.wizardDivergence) &&
		(value.planSha256 === undefined ||
			(typeof value.planSha256 === "string" &&
				/^[a-f0-9]{64}$/.test(value.planSha256))) &&
		isOptionalString(value.sourceObject) &&
		isOptionalString(value.sourceIdentity) &&
		(value.bitmovinAccountId === undefined ||
			value.bitmovinAccountId === null ||
			typeof value.bitmovinAccountId === "string") &&
		isOptionalString(value.resumedFromRunId) &&
		(value.checks === undefined || isRecord(value.checks)) &&
		(value.liveCleanup === undefined || isRecord(value.liveCleanup)) &&
		(value.liveEvidence === undefined || isRecord(value.liveEvidence))
	);
}

function parseReport(raw: string): ResumeReport | null {
	try {
		const report = JSON.parse(raw) as unknown;
		if (!isRecord(report)) return null;
		const fingerprint = report.fingerprint;
		const evidence = report.evidence;
		const counts = report.counts;
		if (
			typeof report.runId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(report.runId) ||
			report.runId.includes("..") ||
			!isIsoDate(report.startedAt) ||
			!isIsoDate(report.finishedAt) ||
			Date.parse(report.finishedAt) < Date.parse(report.startedAt) ||
			!isRecord(fingerprint) ||
			typeof fingerprint.commit !== "string" ||
			fingerprint.commit.length === 0 ||
			typeof fingerprint.checkoutLatestMigration !== "string" ||
			typeof fingerprint.dbLatestMigration !== "string" ||
			typeof fingerprint.drift !== "boolean" ||
			!Array.isArray(report.preflight) ||
			!report.preflight.every(
				(state) =>
					isRecord(state) &&
					typeof state.capability === "string" &&
					state.capability.length > 0 &&
					typeof state.satisfied === "boolean" &&
					typeof state.evidence === "string" &&
					state.evidence.length > 0,
			) ||
			!Array.isArray(report.outcomes) ||
			report.outcomes.length === 0 ||
			!isRecord(counts) ||
			Object.keys(counts).length !== REPORT_VERDICTS.length ||
			!REPORT_VERDICTS.every(
				(verdict) =>
					Number.isSafeInteger(counts[verdict]) && Number(counts[verdict]) >= 0,
			) ||
			!isRecord(evidence) ||
			evidence.version !== EVIDENCE_VERSION ||
			(evidence.algorithm !== "SHA256" &&
				evidence.algorithm !== "HMAC_SHA256") ||
			!isNullableString(evidence.keyId) ||
			!isIsoDate(evidence.retentionUntil) ||
			!isEvidenceManifest(evidence.manifest) ||
			typeof evidence.reportMarkdownSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(evidence.reportMarkdownSha256) ||
			!Array.isArray(report.resourceIntents) ||
			!report.resourceIntents.every(isReportIntent)
		) {
			return null;
		}
		const scenarioNames = new Set<string>();
		for (const outcome of report.outcomes) {
			if (!isReportOutcome(outcome) || scenarioNames.has(outcome.scenario)) {
				return null;
			}
			scenarioNames.add(outcome.scenario);
		}
		const intentIds = new Set<string>();
		const intentKeys = new Set<string>();
		for (const intent of report.resourceIntents) {
			if (intentIds.has(intent.id) || intentKeys.has(intent.verificationKey)) {
				return null;
			}
			intentIds.add(intent.id);
			intentKeys.add(intent.verificationKey);
		}
		return report as ResumeReport;
	} catch {
		return null;
	}
}

function evidencePopulationError(
	report: ResumeReport,
): { code: string; reason: string } | null {
	const passNames = report.outcomes
		.filter((outcome) => outcome.verdict === "PASS")
		.map((outcome) => outcome.scenario)
		.sort();
	const manifestNames = report.evidence.manifest.scenarios
		.map((entry) => entry.scenario)
		.sort();
	if (
		report.evidence.manifest.version !== EVIDENCE_VERSION ||
		canonical(passNames) !== canonical(manifestNames) ||
		new Set(manifestNames).size !== manifestNames.length
	) {
		return {
			code: "SCENARIO_POPULATION_MISMATCH",
			reason: "PASS outcomes and scenario evidence population differ",
		};
	}
	for (const entry of report.evidence.manifest.scenarios) {
		if (
			!isSafeScenario(entry.scenario) ||
			entry.planFile !== `${entry.scenario}.plan.json` ||
			entry.reportFile !== `${entry.scenario}.report.json`
		) {
			return {
				code: "SCENARIO_PATH_INVALID",
				reason: `scenario ${entry.scenario} carries an unsafe evidence path`,
			};
		}
	}
	return null;
}

export type ReportEnvelopeValidationResult =
	| {
			ok: true;
			report: ResumeReport;
			reportSha256: string;
	  }
	| { ok: false; code: string; reason: string };

/**
 * One runtime contract for both sides of the SEALED transition. The producer
 * calls it before its compare-and-swap; recovery calls the same function before
 * accepting DB bytes. That prevents a writer/reader schema split from making a
 * malformed report authoritative merely because its HMAC is internally valid.
 */
export function validateReportEnvelope(input: {
	reportJson: string;
	reportMarkdown: string;
	seal: string;
	sealAlgorithm: string;
	sealKeyId: string | null;
	sealKey?: string;
	evidenceVersion: number;
	evidenceManifest: unknown;
	retentionUntil: string;
	outcomes: unknown;
	counts: unknown;
	resourceIntents: unknown;
	expectedRunId?: string;
	expectedFinishedAt?: string;
}): ReportEnvelopeValidationResult {
	const report = parseReport(input.reportJson);
	if (!report) {
		return {
			ok: false,
			code: "REPORT_INVALID",
			reason: "the report is not a complete runtime-valid verification report",
		};
	}
	const seal = input.seal.trim();
	const algorithm = input.sealAlgorithm;
	if (
		(algorithm !== "SHA256" && algorithm !== "HMAC_SHA256") ||
		(algorithm === "SHA256" &&
			(input.sealKeyId !== null || !seal.startsWith("sha256:"))) ||
		(algorithm === "HMAC_SHA256" &&
			(typeof input.sealKeyId !== "string" ||
				input.sealKeyId.length === 0 ||
				typeof input.sealKey !== "string" ||
				input.sealKey.length < 16 ||
				!seal.startsWith("hmac-sha256:")))
	) {
		return {
			ok: false,
			code: "SEAL_ALGORITHM_MISMATCH",
			reason: "seal algorithm, key metadata and seal prefix differ",
		};
	}
	const verified = verifyReportSeal(input.reportJson, seal, input.sealKey);
	if (!verified.ok) {
		return { ok: false, code: "SEAL_INVALID", reason: verified.reason };
	}
	if (
		input.evidenceVersion !== EVIDENCE_VERSION ||
		report.evidence.version !== input.evidenceVersion ||
		report.evidence.algorithm !== algorithm ||
		report.evidence.keyId !== input.sealKeyId ||
		report.evidence.retentionUntil !== input.retentionUntil
	) {
		return {
			ok: false,
			code: "EVIDENCE_METADATA_MISMATCH",
			reason: "report and persisted seal metadata differ",
		};
	}
	if (
		input.expectedRunId !== undefined &&
		report.runId !== input.expectedRunId
	) {
		return {
			ok: false,
			code: "RUN_ID_MISMATCH",
			reason: "report and expected run ids differ",
		};
	}
	if (
		input.expectedFinishedAt !== undefined &&
		report.finishedAt !== input.expectedFinishedAt
	) {
		return {
			ok: false,
			code: "FINISHED_AT_MISMATCH",
			reason: "report and persisted finish time differ",
		};
	}
	if (report.evidence.reportMarkdownSha256 !== sha256(input.reportMarkdown)) {
		return {
			ok: false,
			code: "REPORT_MARKDOWN_DIGEST_MISMATCH",
			reason:
				"the exact Markdown bytes do not match the digest bound inside report JSON",
		};
	}
	const derivedCounts = Object.fromEntries(
		REPORT_VERDICTS.map((verdict) => [
			verdict,
			report.outcomes.filter((outcome) => outcome.verdict === verdict).length,
		]),
	);
	if (canonical(report.counts) !== canonical(derivedCounts)) {
		return {
			ok: false,
			code: "REPORT_COUNTS_MISMATCH",
			reason: "report verdict counts do not exactly describe its outcomes",
		};
	}
	const populationError = evidencePopulationError(report);
	if (populationError) {
		return { ok: false, ...populationError };
	}
	if (
		canonical(report.outcomes) !== canonical(input.outcomes) ||
		canonical(report.counts) !== canonical(input.counts) ||
		canonical(report.evidence.manifest) !== canonical(input.evidenceManifest) ||
		canonical(report.resourceIntents) !== canonical(input.resourceIntents)
	) {
		return {
			ok: false,
			code: "REPORT_INPUT_MISMATCH",
			reason:
				"report outcomes, counts, evidence manifest or paid-resource intents differ from the separately persisted inputs",
		};
	}
	const intents = verificationIntentsSealable(report.resourceIntents);
	if (!intents.sealable) {
		return {
			ok: false,
			code: "RESOURCE_INTENTS_UNSEALED",
			reason: `${intents.unresolved.length} paid-resource intent(s) are not terminal and exactly closed`,
		};
	}
	const restartClaim = report.resourceIntents.find((intent) =>
		intent.events.some(
			(event) =>
				event.eventType === "RECOVERY_CLAIMED" &&
				isRecord(event.details) &&
				typeof event.details.owner === "string" &&
				event.details.owner.startsWith("verify-recover:"),
		),
	);
	if (restartClaim) {
		return {
			ok: false,
			code: "RESOURCE_INTENTS_RECOVERED",
			reason: `paid-resource intent ${restartClaim.verificationKey} was claimed by explicit restart recovery`,
		};
	}
	return {
		ok: true,
		report,
		reportSha256: sha256(input.reportJson),
	};
}

export type ReportAuthorityValidationResult =
	| {
			ok: true;
			rowId: string;
			runId: string;
			report: ResumeReport;
			reportSha256: string;
			audit: ResumeEvidenceAudit;
	  }
	| {
			ok: false;
			code: string;
			reason: string;
			audit: ResumeEvidenceAudit;
	  };

function authorityFail(
	code: string,
	reason: string,
	partial: Omit<ResumeEvidenceAudit, "decision" | "reason"> = {},
): ReportAuthorityValidationResult {
	return {
		ok: false,
		code,
		reason,
		audit: { decision: "REFUSED", reason, ...partial },
	};
}

/**
 * Validate the self-contained database authority without consulting exports.
 * Recovery calls this before it writes a single canonical byte; resume then
 * additionally joins these bytes to the local report, seal and scenario files.
 * `reportMarkdownSha256` lives inside report.json, so the report seal/HMAC binds
 * both representations without a circular seal over report.md itself.
 */
export function validateSealedReportAuthority(input: {
	runId: string;
	releaseMode: boolean;
	keyring: { activeKeyId?: string; keys: Readonly<Record<string, string>> };
	row: ResumeEvidenceRow;
	now?: () => Date;
}): ReportAuthorityValidationResult {
	const { row } = input;
	if (row.status !== "SEALED" || !row.sealedAt || !row.seal) {
		return authorityFail(
			"DB_NOT_SEALED",
			`verification run ${input.runId} has no SEALED database authority`,
		);
	}
	if (
		row.recoveryGeneration !== 0 ||
		row.recoveryOwner !== null ||
		row.recoveryLeaseUntil !== null
	) {
		return authorityFail(
			"DB_RECOVERY_FENCED",
			`verification run ${input.runId} was claimed by restart recovery and cannot remain release authority`,
		);
	}
	const baseAudit = {
		algorithm: row.sealAlgorithm ?? undefined,
		keyId: row.sealKeyId,
		retentionUntil: row.retentionUntil?.toISOString(),
		resumedFromId: row.resumedFromId,
	};
	if (
		!row.retentionUntil ||
		row.retentionUntil.getTime() <=
			(input.now ?? (() => new Date()))().getTime()
	) {
		return authorityFail(
			"RETENTION_EXPIRED",
			`verification run ${input.runId} is outside its evidence retention window`,
			baseAudit,
		);
	}
	if (!row.reportJson) {
		return authorityFail(
			"DB_REPORT_MISSING",
			"the SEALED row predates self-contained report authority and cannot be release-resumed",
			baseAudit,
		);
	}
	if (typeof row.reportMarkdown !== "string") {
		return authorityFail(
			"DB_REPORT_MARKDOWN_MISSING",
			"the SEALED row has no self-contained Markdown report bytes",
			baseAudit,
		);
	}
	const digest = sha256(row.reportJson);
	if (!row.reportSha256 || row.reportSha256 !== digest) {
		return authorityFail(
			"DB_REPORT_DIGEST_MISMATCH",
			"the report bytes stored in the database do not match their SEALED digest",
			{ ...baseAudit, reportSha256: digest },
		);
	}
	const seal = row.seal.trim();
	const algorithm = row.sealAlgorithm as SealAlgorithm | null;
	if (input.releaseMode && algorithm !== "HMAC_SHA256") {
		return authorityFail(
			"LEGACY_WEAK_SEAL",
			"release evidence requires an HMAC seal; SHA-only evidence is local corruption detection only",
			{ ...baseAudit, reportSha256: digest, seal },
		);
	}
	let key: string | undefined;
	if (algorithm === "HMAC_SHA256") {
		if (!row.sealKeyId || !(row.sealKeyId in input.keyring.keys)) {
			return authorityFail(
				"SEAL_KEY_UNAVAILABLE",
				`seal key ${row.sealKeyId ?? "(missing id)"} is not available in the verification keyring`,
				{ ...baseAudit, reportSha256: digest, seal },
			);
		}
		key = input.keyring.keys[row.sealKeyId];
	} else if (algorithm !== "SHA256") {
		return authorityFail(
			"SEAL_ALGORITHM_MISMATCH",
			"database seal algorithm is missing or unknown",
			{ ...baseAudit, reportSha256: digest, seal },
		);
	} else if (row.sealKeyId !== null) {
		return authorityFail(
			"SEAL_ALGORITHM_MISMATCH",
			"a SHA-only report must not claim an HMAC key id",
			{ ...baseAudit, reportSha256: digest, seal },
		);
	}
	const envelope = validateReportEnvelope({
		reportJson: row.reportJson,
		reportMarkdown: row.reportMarkdown,
		seal,
		sealAlgorithm: algorithm,
		sealKeyId: row.sealKeyId,
		...(key ? { sealKey: key } : {}),
		evidenceVersion: row.evidenceVersion ?? -1,
		evidenceManifest: row.evidenceManifest,
		retentionUntil: row.retentionUntil.toISOString(),
		outcomes: row.outcomes,
		counts: row.counts,
		resourceIntents: row.intents,
		expectedRunId: input.runId,
	});
	if (!envelope.ok) {
		const code =
			envelope.code === "REPORT_MARKDOWN_DIGEST_MISMATCH"
				? "DB_REPORT_MARKDOWN_DIGEST_MISMATCH"
				: envelope.code === "REPORT_INPUT_MISMATCH"
					? "DB_REPORT_MISMATCH"
					: envelope.code;
		return authorityFail(code, envelope.reason, {
			...baseAudit,
			reportSha256: digest,
			seal,
		});
	}
	const report = envelope.report;
	if (row.runId !== report.runId) {
		return authorityFail(
			"RUN_ID_MISMATCH",
			"report, recovery request and database run ids differ",
			baseAudit,
		);
	}
	const fp = report.fingerprint;
	if (
		row.commit !== fp.commit ||
		row.checkoutLatestMigration !== fp.checkoutLatestMigration ||
		row.dbLatestMigration !== fp.dbLatestMigration ||
		row.drift !== fp.drift
	) {
		return authorityFail(
			"FINGERPRINT_MISMATCH",
			"database and report fingerprints differ",
			baseAudit,
		);
	}
	if (canonical(report.resourceIntents) !== canonical(row.intents)) {
		return authorityFail(
			"DB_RESOURCE_INTENTS_MISMATCH",
			"database paid-resource intents differ from the sealed report dossier",
			baseAudit,
		);
	}
	if (
		report.outcomes.some(
			(outcome) =>
				outcome.bitmovinAccountId !== undefined &&
				outcome.bitmovinAccountId !== row.bitmovinAccountId,
		)
	) {
		return authorityFail(
			"ACCOUNT_MISMATCH",
			"database and report Bitmovin account ids differ",
			baseAudit,
		);
	}
	return {
		ok: true,
		rowId: row.id,
		runId: row.runId,
		report,
		reportSha256: digest,
		audit: {
			decision: "ACCEPTED",
			reason:
				"the SEALED database report, exact Markdown bytes and HMAC/digest contract agree",
			...baseAudit,
			reportSha256: digest,
			seal,
		},
	};
}

function sealPath(reportPath: string): string {
	return reportPath.endsWith("report.json")
		? `${reportPath.slice(0, -"report.json".length)}report.seal`
		: `${reportPath}.seal`;
}

function markdownPath(reportPath: string): string {
	return reportPath.endsWith("report.json")
		? `${reportPath.slice(0, -"report.json".length)}report.md`
		: `${reportPath}.md`;
}

function liveEvidenceMatches(
	row: ResumeEvidenceRow,
	report: ResumeReport,
	scenarioFiles: ReadonlyMap<string, unknown>,
): boolean {
	const isCurrentLiveTuple = (value: unknown): boolean =>
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		(value as { version?: unknown }).version === LIVE_EVIDENCE_VERSION;
	const byScenario = new Map<string, unknown[]>();
	for (const evidence of row.liveEvidence) {
		if (!isCurrentLiveTuple(evidence.tuple)) return false;
		const rows = byScenario.get(evidence.scenario) ?? [];
		rows.push(evidence.tuple);
		byScenario.set(evidence.scenario, rows);
	}
	for (const outcome of report.outcomes) {
		const durable = byScenario.get(outcome.scenario) ?? [];
		const raw = scenarioFiles.get(outcome.scenario);
		const fileEvidence =
			typeof raw === "object" && raw !== null && "evidence" in raw
				? (raw as { evidence?: unknown }).evidence
				: undefined;
		if (durable.length === 0 && fileEvidence === undefined) continue;
		if (!Array.isArray(fileEvidence)) return false;
		if (fileEvidence.some((tuple) => !isCurrentLiveTuple(tuple))) return false;
		const orderedDurable = [...durable].sort((a, b) =>
			canonical(a).localeCompare(canonical(b)),
		);
		const orderedFile = [...fileEvidence].sort((a, b) =>
			canonical(a).localeCompare(canonical(b)),
		);
		if (canonical(orderedDurable) !== canonical(orderedFile)) return false;
	}
	return true;
}

/**
 * Joins the prior report to the one SEALED database row and every scenario
 * file before a caller can honour a PASS. This function performs no provider
 * or product call; callers run it before the submit budget can be spent.
 */
export async function loadResumeEvidence(
	input: ResumeEvidenceInput,
): Promise<ResumeEvidenceResult> {
	const row = await input.store.findByRunId(input.runId);
	if (!row) {
		return fail(
			"DB_NOT_SEALED",
			`verification run ${input.runId} has no SEALED database authority`,
		);
	}
	const authority = validateSealedReportAuthority({
		runId: input.runId,
		releaseMode: input.releaseMode,
		keyring: input.keyring,
		row,
		now: input.now,
	});
	if (!authority.ok) return authority;
	const {
		decision: _decision,
		reason: _reason,
		...baseAudit
	} = authority.audit;
	const authoritativeSeal = authority.audit.seal as string;
	const authoritativeRetention = authority.audit.retentionUntil as string;
	if (resolve(row.reportPath) !== resolve(input.reportPath)) {
		return fail(
			"REPORT_PATH_MISMATCH",
			`database report path ${row.reportPath} does not match ${input.reportPath}`,
			baseAudit,
		);
	}
	let reportJson: string;
	try {
		reportJson = await input.readText(input.reportPath);
	} catch {
		return fail(
			"REPORT_MISSING",
			`resume report ${input.reportPath} is missing`,
			baseAudit,
		);
	}
	if (reportJson !== row.reportJson) {
		return fail(
			"DB_FILE_REPORT_MISMATCH",
			"the local report export does not match the complete report stored in the SEALED row",
			{ ...baseAudit, reportSha256: sha256(reportJson) },
		);
	}
	let reportMarkdown: string;
	try {
		reportMarkdown = await input.readText(markdownPath(input.reportPath));
	} catch {
		return fail(
			"REPORT_MARKDOWN_MISSING",
			"resume Markdown report export is missing",
			baseAudit,
		);
	}
	if (reportMarkdown !== row.reportMarkdown) {
		return fail(
			"DB_FILE_REPORT_MARKDOWN_MISMATCH",
			"the local Markdown export does not match the HMAC-bound bytes stored in the SEALED row",
			baseAudit,
		);
	}
	const digest = authority.reportSha256;
	let fileSeal: string;
	try {
		fileSeal = (await input.readText(sealPath(input.reportPath))).trim();
	} catch {
		return fail("SEAL_MISSING", "resume report seal file is missing", {
			...baseAudit,
			reportSha256: digest,
		});
	}
	if (fileSeal !== authoritativeSeal) {
		return fail("DB_FILE_SEAL_MISMATCH", "database and file seals differ", {
			...baseAudit,
			reportSha256: digest,
			seal: fileSeal,
		});
	}
	const report = authority.report;
	const algorithm = row.sealAlgorithm as SealAlgorithm;
	const manifest = report.evidence.manifest;
	const runDir = dirname(input.reportPath);
	const scenarioFiles = new Map<string, unknown>();
	for (const entry of manifest.scenarios) {
		const planPath = join(runDir, entry.planFile);
		const scenarioPath = join(runDir, entry.reportFile);
		let plan: string;
		let scenario: string;
		try {
			[plan, scenario] = await Promise.all([
				input.readText(planPath),
				input.readText(scenarioPath),
			]);
		} catch {
			return fail(
				"SCENARIO_EVIDENCE_MISSING",
				`plan or report evidence for scenario ${entry.scenario} is missing`,
				baseAudit,
			);
		}
		if (
			sha256(plan) !== entry.planSha256 ||
			sha256(scenario) !== entry.reportSha256
		) {
			return fail(
				"SCENARIO_DIGEST_MISMATCH",
				`scenario ${entry.scenario} evidence bytes changed`,
				baseAudit,
			);
		}
		try {
			scenarioFiles.set(entry.scenario, JSON.parse(scenario));
		} catch {
			return fail(
				"SCENARIO_REPORT_INVALID",
				`scenario ${entry.scenario} report is not JSON`,
				baseAudit,
			);
		}
	}
	if (!liveEvidenceMatches(row, report, scenarioFiles)) {
		return fail(
			"LIVE_EVIDENCE_MISMATCH",
			"scenario files and durable live evidence tuples differ",
			baseAudit,
		);
	}
	return {
		ok: true,
		rowId: row.id,
		runId: row.runId,
		report,
		audit: {
			decision: "ACCEPTED",
			reason:
				"DB SEALED row, report, seal, fingerprint and scenario evidence agree",
			reportSha256: digest,
			seal: fileSeal,
			algorithm,
			keyId: row.sealKeyId,
			retentionUntil: authoritativeRetention,
			resumedFromId: row.resumedFromId,
		},
	};
}
