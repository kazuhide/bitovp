/**
 * `verify run` — the layer-2 loop: rewrite → submit → await → verify → report.
 *
 * Two design decisions carry the weight here :
 *
 * **Through the product, not around it.** Scenarios are submitted to
 * `POST /api/encoding-jobs`, the same endpoint the wizard uses, authenticated the way
 * an operator is. Driving `sdk-ops` directly would verify Bitmovin, not this product —
 * and it is the product's compiler, orchestrator and step log that keep breaking.
 *
 * **Every run is namespaced.** Artefacts go under `verify/<runId>/<scenario>/`, which
 * removes a whole class of false result by construction: a real prefix was found
 * holding another run's manifests and 100 stale segments, and `verify job` on it
 * reported a segment count of 100 where 2 were expected. Nothing can contaminate a
 * prefix no other run has ever written.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	EncodingPlan,
	ExpectedArtefacts,
	LiveChannelPlan,
	VerificationDispatchFence,
	VerificationEncodingIdentity,
} from "@bitovp/core";
import {
	CREDENTIAL_PROVIDER_SHAPES,
	cipherFromEnv,
	compileExpectedArtefacts,
	DEFAULT_MSL_EDGE_HOST_SUFFIXES,
	encodingPlanSchema,
	type LiveEvidenceLeg,
	type LiveEvidenceSummary,
	liveEvidenceSupportsPass,
	mapDestinationPaths,
	parseEdgeBaseUrl,
	type StepLogEntry,
	summarizeLiveEvidence,
	VERIFICATION_KEY_SHA_CONFLICT,
	verificationCreateErrorCode,
	verificationIntentsSealable,
	verificationKeyFor,
	verificationKeyLabel,
	verificationRequestSha256,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import {
	autoTriggerKey,
	createBitmovinAccountStore,
	createCredentialStore,
	createPrismaClient,
} from "@bitovp/db";
import { createBrowserForCredential } from "@bitovp/storage";
import { makeWorkerSdk } from "../orchestrator/make-sdk";
import {
	isBitmovinError,
	VerificationProviderLookupError,
} from "../orchestrator/ops/shared";
import { verificationCreateIdentity } from "../orchestrator/stamping-fetch";
import { edgeReaderFor } from "./edge-reader";
import type { VerificationReport } from "./engine";
import { perTitleUnverifiedChecks } from "./engine";
import { UNOBSERVABLE_READ_PREFIX } from "./engine-live";
import {
	assertFreshRun,
	createSubmitBudget,
	defaultRunId,
	ensureTerminal,
	isProviderEncodingTerminal,
	type ProviderEncodingStatus,
	pickAccount,
	pickByLabel,
	positiveInt,
	prepareRunDir,
	resolveBaseUrl,
	resumeEligibility,
	sealReport,
	validateRunId,
} from "./harness-rails";
import type { VerifyJobResult } from "./job";
import { verifyJob } from "./job";
import { verifyLiveArchives } from "./live-archive-runtime";
import {
	finalizeLiveCleanupSeal,
	type LiveCleanupSeal,
	unestablishedCleanupElements,
} from "./live-cleanup-seal";
import type { Capability, PreflightReport } from "./preflight";
import {
	bucketFromLabel,
	loadScenarios,
	preflight,
	requiredSourceSeconds,
	videoSeconds,
} from "./preflight";
import {
	classifySendFailure,
	createIntentLedger,
	type IntentHandle,
	type IntentLedger,
	type IntentReadback,
	type IntentResolvers,
	type IntentRow,
	type IntentTerminalInput,
	mergeIntentTerminalInputs,
	prismaIntentStore,
	redactIntentDossier,
	verificationLocalResourceKey,
	verificationProviderEncodingKey,
} from "./resource-intent";
import {
	canaryCompletionError,
	createPostCreateResponseLossCanary,
	noteCanaryAdoption,
	noteCanaryCreatePost,
	type PostCreateResponseLossCanaryState,
	type PostCreateResponseLossEvidence,
	postCreateResponseLossEvidence,
	shouldInjectPostCreateResponseLoss,
	validatePostCreateResponseLossCanary,
} from "./response-loss-canary";
import {
	buildEvidenceManifest,
	EVIDENCE_VERSION,
	evidenceSealPolicy,
	loadResumeEvidence,
	prismaResumeEvidenceStore,
	type ResumeEvidenceManifest,
	sealKeyringFromEnv,
	validateSealedReportAuthority,
} from "./resume-evidence";
import type { RunRecorder } from "./run-record";
import {
	createRunRecorder,
	prismaRunRecordStore,
	recordableError,
} from "./run-record";
import {
	prepareLiveScenarioForRun,
	runLiveScenario,
	teardownAdoptedChannel,
	validateLiveEncoderVersion,
} from "./runner-live";

export type ScenarioVerdict = "PASS" | "WARN" | "FAIL" | "SKIP" | "INVALID";

export type ScenarioOutcome = {
	scenario: string;
	verdict: ScenarioVerdict;
	/** Why, in one line — required for every non-PASS. */
	reason: string;
	jobId?: string;
	encodingId?: string;
	checks?: VerifyJobResult["report"]["counts"];
	elapsedMs?: number;
	/**
	 * LIVE only: how long the origin took to publish its first playable segment.
	 *
	 * Kept on the outcome so it reaches report.json and report.md. `MIN_SAMPLE_GAP_SEC = 10`
	 * governs whether the live movement checks can mean anything and was a reasoned guess; a
	 * reviewer's ask was that it be a measurement, and a measurement nobody can read is not one.
	 */
	firstPublishMs?: number;
	firstPublishNote?: string;
	/** Which wizard submit path produced the plan — see `wizardPaths` in this file. */
	submittedVia?: "wizard-form" | "wizard-import";
	/** The field the form could not author, when that is why the import path was used. */
	wizardDivergence?: string;
	/**
	 * What this PASS is a PASS *of* : the exact plan submitted,
	 * the source it read and the account it billed. `--resume-from` honours a
	 * prior PASS only when all three — and the report's fingerprint — match.
	 */
	planSha256?: string;
	sourceObject?: string;
	/** etag / versionId / size of the staged source , or "unavailable". */
	sourceIdentity?: string;
	bitmovinAccountId?: string | null;
	/** Prior run supplying this PASS; present only when no paid submit occurred. */
	resumedFromRunId?: string;
	/**
	 * LIVE only: the durable teardown seal
	 * provider terminal, local terminal, feeder `processGoneAt`, host process
	 * and queue, as one artefact. Rides onto the outcome so it lands in the
	 * VerificationRun evidence row; an unclean seal is what makes the verdict
	 * INVALID.
	 */
	liveCleanup?: LiveCleanupSeal;
	/**
	 * LIVE only: the versioned evidence-tuple summary
 — per output leg, complete or the elements it lacks.
	 * A PASS/WARN live outcome is refused (INVALID) unless every leg is
	 * complete, and the run recorder refuses SEALED for a green live outcome
	 * whose tuple is not. The full legs (object lists, hashes) live in the
	 * VerificationLiveEvidence child rows; this is the same summary the
	 * Dashboard renders.
	 */
	liveEvidence?: LiveEvidenceSummary;
};

/**
 * Stage the three local exports under non-canonical names, run the DB's
 * read-only seal gate, then atomically commit DB SEALED with the exact report
 * bytes before publishing any canonical file. The DB is the sole release
 * authority; report.json/report.md/report.seal are recoverable exports. This
 * ordering has no file-only green crash window. A DB refusal removes staging
 * and fails the run. A later filesystem failure leaves no newly-published seal
 * receipt and retains this invocation's remaining unique pending bytes; it
 * never deletes canonical bytes that a concurrent repair may have completed.
 */
type SealedRunReportExportInput = {
	runDir: string;
	reportJson: string;
	reportMarkdown: string;
	seal: string;
	/** Injection seam for deterministic filesystem-failure tests. */
	publishFile?: (pending: string, published: string) => Promise<void>;
};

const sealedRunReportFiles = (input: SealedRunReportExportInput) => {
	// A recovery may overlap the original publisher or another recovery. Fixed
	// pending names let one invocation rename/delete another invocation's bytes.
	// Per-invocation names make identical DB-authoritative repairs idempotent.
	const nonce = randomBytes(12).toString("hex");
	return [
		{
			pending: join(input.runDir, `report.json.pending.${nonce}`),
			published: join(input.runDir, "report.json"),
			contents: input.reportJson,
		},
		{
			pending: join(input.runDir, `report.md.pending.${nonce}`),
			published: join(input.runDir, "report.md"),
			contents: input.reportMarkdown,
		},
		{
			pending: join(input.runDir, `report.seal.pending.${nonce}`),
			published: join(input.runDir, "report.seal"),
			contents: `${input.seal}\n`,
		},
	];
};

async function stageSealedRunReportExports(
	files: ReturnType<typeof sealedRunReportFiles>,
): Promise<void> {
	await Promise.all(
		files.map((file) => writeFile(file.pending, file.contents)),
	);
}

async function publishStagedRunReportExports(
	files: ReturnType<typeof sealedRunReportFiles>,
	publishFile: (pending: string, published: string) => Promise<void>,
): Promise<{ exported: boolean; error?: string }> {
	try {
		// The array order is the export protocol: the local seal is never visible
		// before both report representations. It is still only an export receipt;
		// the DB row owns release authority.
		for (const file of files) {
			await publishFile(file.pending, file.published);
		}
		return { exported: true };
	} catch (publishError) {
		// Never delete canonical paths here: a concurrent repair may already have
		// published the same validated DB-authoritative bytes. If that happened, this repair
		// is successful too. Otherwise the seal-last protocol means a partial write
		// is not a local release receipt, and this invocation's remaining unique
		// pending files are safe material for diagnosis/retry.
		const canonicalMatches = await Promise.all(
			files.map(
				async (file) =>
					(await readFile(file.published, "utf8").catch(() => null)) ===
					file.contents,
			),
		);
		if (canonicalMatches.every(Boolean)) {
			await Promise.all(files.map((file) => rm(file.pending, { force: true })));
			return { exported: true };
		}
		return { exported: false, error: recordableError(publishError) };
	}
}

/** Rebuild local exports from a self-contained SEALED database row. */
export async function restoreSealedRunReportExports(
	input: SealedRunReportExportInput,
): Promise<{ exported: boolean; error?: string }> {
	const files = sealedRunReportFiles(input);
	await stageSealedRunReportExports(files);
	return publishStagedRunReportExports(files, input.publishFile ?? rename);
}

export async function publishSealedRunReport(
	input: SealedRunReportExportInput & {
		validateDurably: () => Promise<void>;
		sealDurably: () => Promise<void>;
	},
): Promise<{ exported: boolean; error?: string }> {
	const files = sealedRunReportFiles(input);
	await stageSealedRunReportExports(files);
	try {
		await input.validateDurably();
		// SEALED is truthful here because this callback stores reportJson,
		// reportMarkdown, digest, seal and evidence in the same DB row update.
		await input.sealDurably();
	} catch (err) {
		await Promise.all(files.map((file) => rm(file.pending, { force: true })));
		throw err;
	}
	return publishStagedRunReportExports(files, input.publishFile ?? rename);
}

export type RunReport = {
	runId: string;
	startedAt: string;
	finishedAt: string;
	/**
	 *  I-08: what code and what schema this run actually ran
	 * against — the E2E observed a dev DB carrying a migration the
	 * checkout lacked, and reports without a fingerprint cannot even
	 * express that drift.
	 */
	fingerprint: {
		commit: string;
		checkoutLatestMigration: string;
		dbLatestMigration: string;
		drift: boolean;
	};
	preflight: PreflightReport["capabilities"];
	outcomes: ScenarioOutcome[];
	counts: Record<ScenarioVerdict, number>;
	/** EV-03: the HMAC/retention metadata and every retained PASS evidence hash. */
	evidence?: {
		version: number;
		algorithm: "SHA256" | "HMAC_SHA256";
		keyId: string | null;
		retentionUntil: string;
		manifest: ResumeEvidenceManifest;
		/** Exact report.md digest inside the JSON seal/HMAC contract. */
		reportMarkdownSha256: string;
	};
	/** EV-01: redacted DB-authoritative paid-resource closure dossiers. */
	resourceIntents?: IntentRow[];
	/** Audit canary proving one successful create was lost, adopted, and cleaned. */
	faultInjection?: PostCreateResponseLossEvidence & {
		lookupCandidates: number;
		exactLookupCandidates: number;
		intentState: string | null;
		cleanupState: string | null;
		exactResourceSet: boolean;
	};
};

export type RunnerConfig = {
	prisma: AppPrismaClient;
	/** Product base URL — the runner talks HTTP, like an operator. */
	baseUrl: string;
	/** Shared team password for the session cookie. */
	password?: string;
	/**
	 *  I-09: a scoped API token  — the preferred
	 * runner identity. When set, the runner never touches the password
	 * flow and every request rides `Authorization: Bearer`; runs are then
	 * attributable in AuditLog.actor instead of hiding behind a shared
	 * session (or an AUTH_MODE=none sidecar).
	 */
	apiToken?: string;
	/**
	 * The Bitmovin account the run bills . Required when more than
	 * one is registered — "the oldest" was the old answer, and a paid run must
	 * not choose its account by creation date.
	 */
	bitmovinAccountId?: string;
	/** Credential + bucket the rewrite points every S3 scenario at. */
	s3CredentialLabel: string;
	inputBucket: string;
	outputBucket: string;
	/** Source object every rewritten scenario reads. */
	sourceObject: string;
	/** `verify-runs/<runId>` on disk. */
	runDir: string;
	runId: string;
	ffprobePath: string;
	concurrency: number;
	perScenarioTimeoutMs: number;
	/** Only these scenarios (names); empty = every runnable one. */
	only?: string[];
	/** Stop before submitting anything — the dry run the nightly job uses to check itself. */
	dryRun?: boolean;
	/**
	 *  I-03: the circuit breaker's caps. `maxSubmits` bounds how
	 * many scenarios may actually SUBMIT (cost cap); `resumeFrom` is a prior
	 * report.json whose PASSes are honored instead of re-spent.
	 */
	maxSubmits?: number;
	/** One-shot public audit canary; guarded to one selected, non-dry paid scenario. */
	injectPostCreateResponseLoss?: boolean;
	resumeFrom?: string;
	/** Release evidence refuses SHA-only seals and requires a named HMAC key. */
	releaseMode?: boolean;
	/** Rotation keyring; only key ids are persisted. */
	sealKeyring?: {
		activeKeyId?: string;
		keys: Readonly<Record<string, string>>;
	};
	/** Retain report/seal/scenario/plan evidence for this many days (default 90). */
	evidenceRetentionDays?: number;
	/**
	 * Seconds to feed each live channel. Omitted means the live tier is not run.
	 *
	 * Opt-in rather than default, because a live scenario costs encoder minutes per run
	 * while a VOD one costs a short encode — and the nightly job wants both while an
	 * ad-hoc `--only` usually does not. `runner-live.ts` refuses anything below the
	 * engine's sample-gap floor rather than spending those minutes to report SKIPs.
	 */
	liveFeedSeconds?: number;
	/** How long to wait for a live channel to reach RUNNING. */
	liveStartTimeoutSec?: number;
	liveEncoderVersion?: string;
	/** Override `qc.model` on VMAF-measuring scenarios — see `rewriteForRun`. */
	vmafModel?: string;
	/**
	 * Force `acl: PUBLIC_READ` on live destinations so the run's output can be
	 * played in a browser. Opt-in — see `rewriteLiveForRun`.
	 */
	livePublicRead?: boolean;
	/**
	 * The Akamai DELIVERY base URL an MSL stream is served from, for the
	 * delivery-mirror edge closure .
	 *
	 * This is the OVERRIDE (2026-09-02). The default lives on the `AKAMAI_MSL`
	 * credential as `edgeBaseUrl` — the question this docblock used to leave
	 * open, answered: a CDN property is an account/provisioning fact, not a
	 * plan literal and not a per-run flag — and `liveMslEdgeBaseUrlForRun`
	 * re-validates that value against the delivery-host allowlist per
	 * scenario. Absent both, an MSL mirror leg is UNOBSERVED (a SKIP that
	 * cannot pass the run), which is honest — the harness genuinely cannot
	 * see the mirror. Present, the runner reads master → children → segments
	 * back on the edge and the leg can PASS.
	 */
	liveMslEdgeBaseUrl?: string;
	/**
	 * Extra delivery hosts (`VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS`) for the edge
	 * base the CREDENTIAL declares (2026-09-02). The flag above is validated
	 * against them in `main` before anything is spent; a credential's
	 * `edgeBaseUrl` is only known per scenario, so the same allowlist has to
	 * travel with the config for `liveMslEdgeBaseUrlForRun` to apply it there.
	 */
	liveMslEdgeAllowedHosts?: readonly string[];
	/**
	 * Explicit additional event roots an MSL master may reference. Cross-origin
	 * children are refused unless their fully resolved URL remains beneath one
	 * of these validated HTTPS roots.
	 */
	liveMslEdgeAllowedRoots?: readonly string[];
	/** Immutable worker image reference/id (`sha256:<64>`), required for live evidence. */
	liveEvidenceImage?: string;
	/** The source object in the GenericS3 input bucket — see `storageEnv`. */
	genericS3SourceObject?: string;
	/** Where the corpus's declared asset paths live in the input bucket — see `storageEnv`. */
	assetPrefix?: string;
	/** A longer mezzanine for scenarios the default cannot satisfy — see `storageEnv`. */
	longSourceObject?: string;
	log?: (line: string) => void;
};

/**
 * Where the harness's storage lives, read from the environment ONCE.
 *
 * Shared because the smoke command duplicated it with different variable names AND a
 * different default source object — so the smoke reported "the source object does not
 * exist" about a name the runner never uses, i.e. a FAIL that was true of the smoke and
 * false of the harness. Two spellings of one configuration is the disagreement class this
 * project keeps paying for; the smoke exists to be believed, so it has to be reading the
 * same values the corpus will.
 */
export function storageEnv(env: NodeJS.ProcessEnv = process.env): {
	s3CredentialLabel: string;
	inputBucket: string;
	outputBucket: string;
	sourceObject: string;
	genericS3SourceObject: string;
	assetPrefix: string;
	longSourceObject: string;
} {
	return {
		s3CredentialLabel: env.VERIFY_S3_LABEL ?? "verify-aws",
		inputBucket: env.VERIFY_S3_INPUT_BUCKET ?? "ap-northeast-1-input",
		outputBucket: env.VERIFY_S3_OUTPUT_BUCKET ?? "ap-northeast-1-output",
		sourceObject:
			env.VERIFY_SOURCE_OBJECT ?? "big_buck_bunny_1080p_h264_short.mov",
		/**
		 * The source object in the GenericS3 input bucket, which is a DIFFERENT object.
		 *
		 * One global source object was the wrong model. `generic-s3-akamai-io` read from
		 * `bitmovin-api-jp-osa-1-input`, which holds no `big_buck_bunny_1080p_h264_short.mov` —
		 * and I concluded the bucket needed the file copied in, right up to writing (and deleting)
		 * a staging command and recording an owner task. The owner then pointed out
		 * `input/AWOLNATION_muxed_30s.mkv`, which had been sitting there the whole time along with
		 * a 10-minute mezzanine and a whole `fujitv/` tree.
		 *
		 * The harness could not see any of it because its absence check reported only absence.
		 * Saying WHAT IS THERE was one extra call and it answered the question immediately — an
		 * instrument that reports "not found" should report what it found instead.
		 */
		genericS3SourceObject:
			env.VERIFY_GENERIC_S3_SOURCE_OBJECT ?? "input/AWOLNATION_muxed_30s.mkv",
		/**
		 * Where the corpus's DECLARED asset paths live in the input bucket.
		 *
		 * The fixtures name real relative paths and the bucket has them one prefix down: of the 34
		 * paths the corpus declares, `sintel/subtitles_en.vtt` and `sintel/Sintel.2010.1080p.mkv`
		 * resolve under `general/`, and the other 32 are placeholders or assets that are not here.
		 * Measured by listing all 108 objects and matching, not assumed.
		 *
		 * Used for TYPED sources only. Video and audio still collapse to the one staged mezzanine,
		 * because resolving those would point 21 fixtures at a 1.17 GB, ~15-minute Sintel and
		 * multiply the encoder bill for no extra coverage. A typed source is different: a WebVTT
		 * stream cannot be satisfied by a video file at any price, which is why it was gated.
		 */
		assetPrefix: env.VERIFY_ASSET_PREFIX ?? "general/",
		/**
		 * A LONGER mezzanine, for the scenarios the short one cannot satisfy.
		 *
		 * Two scenarios declare a window the 9-second default cannot cover — `trimming-time-based`
		 * wants `offset 10 + duration 30` and `…thumbnail-on-aws` samples at 10s — and the duration
		 * gate correctly refused to submit them. Correct, and a permanent hole: a standard corpus
		 * run would SKIP them forever.
		 *
		 * So the run stages BOTH and picks per scenario from the measured requirement. The short
		 * one stays the default because it is 8 MB against 725 MB and 9s of video against ~10
		 * minutes — using the long one everywhere would multiply the encoder bill for 64 scenarios
		 * that do not need it.
		 */
		longSourceObject:
			env.VERIFY_LONG_SOURCE_OBJECT ?? "big_buck_bunny_1080p_h264.mov",
	};
}

/**
 * What the plan's sources ARE, in bytes — folded over EVERY ingest entry.
 *
 * The first cut read `plan.ingest[0]` only (re-audit BLOCKER-3), which is a resume
 * identity for exactly the single-source scenarios. `concatenation-two-sources`
 * ingests `part-a.mp4` AND `part-b.mp4` from the same input, so replacing the
 * SECOND object left the identity untouched and `--resume-from` would have
 * handed out the prior PASS for a plan that now reads different bytes (review
 * of this PR).
 *
 * Fail-closed in three places, because an identity that cannot be established
 * must refuse rather than assume: no ingest at all, an ingest whose input is
 * not a credentialed bucket (an HTTP or RTMP source has nothing to HEAD), and
 * ANY entry the driver could not HEAD all collapse the whole plan to
 * "unavailable", which `resumeEligibility` refuses on either side. The order
 * is the plan's own `ingest` order, which is deterministic for a given plan —
 * and a reordering changes `planSha256`, so it cannot silently pass either.
 */
export async function planSourceIdentity(
	plan: Pick<EncodingPlan, "ingest" | "inputs">,
	identityOf: (
		credentialId: string,
		bucket: string,
		key: string,
	) => Promise<string>,
): Promise<string> {
	if (plan.ingest.length === 0) {
		return "unavailable";
	}
	const parts: string[] = [];
	for (const ingest of plan.ingest) {
		const input = plan.inputs.find((i) => i.key === ingest.inputKey);
		if (
			!input ||
			!("credentialId" in input) ||
			!("bucket" in input) ||
			typeof input.bucket !== "string"
		) {
			return "unavailable";
		}
		const key = ingest.inputPath.replace(/^\/+/, "");
		const identity = await identityOf(input.credentialId, input.bucket, key);
		if (identity === "unavailable") {
			return "unavailable";
		}
		parts.push(`${key}=${identity}`);
	}
	return parts.join(" | ");
}

/** I-08: commit + latest-migration on both sides, plus the drift verdict. */
export async function collectRunFingerprint(
	prisma: AppPrismaClient,
): Promise<RunReport["fingerprint"]> {
	let commit = "unknown";
	// Re-audit BLOCKER-3 : the container has no `.git`, so the
	// image's own commit — `ARG GIT_COMMIT` → `ENV BITOVP_COMMIT` at build —
	// is the identity; git is the checkout fallback for a dev run.
	const fromImage = process.env.BITOVP_COMMIT?.trim();
	if (fromImage && fromImage !== "unknown") {
		commit = fromImage;
	}
	try {
		if (commit === "unknown") {
			const { execFileSync } = await import("node:child_process");
			commit = execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim();
		}
	} catch {
		// Outside a checkout (a container) the commit is honestly unknown.
	}
	let checkoutLatestMigration = "unknown";
	try {
		const { readdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const dir = join(
			import.meta.dirname,
			"../../../../packages/db/prisma/migrations",
		);
		const names = readdirSync(dir).filter((n) => /^\d{14}_/.test(n));
		checkoutLatestMigration = names.sort().at(-1) ?? "none";
	} catch {
		// Migrations dir unreadable — say so rather than guess.
	}
	let dbLatestMigration = "unknown";
	try {
		const rows = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
			"SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1",
		);
		dbLatestMigration = rows[0]?.migration_name ?? "none";
	} catch {
		// No migrations table (fresh DB) — also worth saying.
	}
	return {
		commit,
		checkoutLatestMigration,
		dbLatestMigration,
		drift:
			checkoutLatestMigration !== "unknown" &&
			dbLatestMigration !== "unknown" &&
			checkoutLatestMigration !== dbLatestMigration,
	};
}

/** I-09: Bearer wins; a session cookie is the password-flow fallback. */
function authHeaders(
	config: Pick<RunnerConfig, "apiToken">,
	session: string | undefined,
): Record<string, string> {
	if (config.apiToken) {
		return { authorization: `Bearer ${config.apiToken}` };
	}
	return session ? { cookie: session } : {};
}

/** Session cookie from the product's own login route. */
async function signIn(
	config: Pick<RunnerConfig, "apiToken" | "password" | "baseUrl">,
): Promise<string | undefined> {
	if (config.apiToken) {
		// I-09: the Bearer token IS the identity — no session needed.
		return undefined;
	}
	if (!config.password) {
		return undefined;
	}
	const res = await fetch(`${config.baseUrl}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password: config.password }),
	});
	if (!res.ok) {
		throw new Error(
			`sign-in failed (${res.status}) — the runner cannot submit without a session`,
		);
	}
	const cookie = res.headers.getSetCookie?.() ?? [];
	const session = cookie.map((c) => c.split(";")[0]).join("; ");
	if (!session) {
		throw new Error("sign-in returned no session cookie");
	}
	return session;
}

/**
 * Point a fixture at the harness's own credential, bucket and namespace.
 *
 * The fixtures carry placeholder credentials and paths on purpose — they are the
 * encoding examples scenarios, not a deployment. Rewriting is therefore part of running
 * them, and it is done structurally (walk the plan, replace the fields) rather than by
 * string substitution on JSON, so a path that happens to contain the same text is not
 * corrupted.
 */
/**
 * The harness's own S3 credential id, or `undefined` when it is not registered.
 *
 * `undefined` rather than a throw: a live scenario with no feed source is still worth
 * running for its provisioning and heartbeat checks, and the engine turns the media
 * assertions into named SKIPs. Throwing here would lose those checks to a missing
 * credential the scenario did not strictly need.
 */
async function s3CredentialId(
	config: RunnerConfig,
): Promise<string | undefined> {
	const rows = await config.prisma.credential.findMany({
		select: { id: true, label: true },
	});
	return rows.find((c) => c.label.startsWith(config.s3CredentialLabel))?.id;
}

/** A browser onto the harness's output bucket. */
type OutputBrowserT = Awaited<ReturnType<typeof browserForCredentialId>>;

async function outputBrowser(config: RunnerConfig) {
	const credentialId = await s3CredentialId(config);
	if (!credentialId) {
		throw new Error(
			`no credential whose label starts with "${config.s3CredentialLabel}"`,
		);
	}
	return browserForCredentialId(config, credentialId);
}

/**
 * A browser for ANY registered credential by id — the general form
 * `outputBrowser` special-cases to the S3 label. The Akamai live set
 * (2026-08-23) reads GENERIC_S3 origins through their own credential, so the
 * reader can no longer assume the S3 one.
 */
async function browserForCredentialId(config: RunnerConfig, id: string) {
	const credentials = createCredentialStore(config.prisma, cipherFromEnv());
	const row = await credentials.get(id);
	if (!row) {
		throw new Error(`credential ${id} no longer exists`);
	}
	return createBrowserForCredential({
		provider: row.provider,
		config: (row.config ?? {}) as Record<string, unknown>,
		secret: JSON.parse(await credentials.revealSecret(id)) as Record<
			string,
			string
		>,
	});
}

/**
 * How long the staged mezzanine actually is, measured once per run.
 *
 * Measured, not configured. A scenario that needs a longer source than the run stages will fail
 * at Bitmovin with something that reads like a product fault — `trimming-time-based` asks for a
 * 40-second window and got `Internal encoding error occurred. Please contact support` on a
 * 10.04-second file — and the harness recorded it as the product's. Gating on a value from an
 * env var would repeat the mistake one level up: the number has to come from the file.
 *
 * Returns `undefined` when the source cannot be probed, and the caller then submits rather than
 * skipping: refusing to run because the harness could not measure something would turn a
 * measurement failure into a coverage loss.
 */
export async function stagedSourceSeconds(
	config: RunnerConfig,
	key: string,
): Promise<number | undefined> {
	let dir: string | undefined;
	try {
		const browser = await outputBrowser(config);
		if (!browser.getObject) {
			return undefined;
		}
		const { mkdtemp } = await import("node:fs/promises");
		const { createWriteStream } = await import("node:fs");
		const { pipeline } = await import("node:stream/promises");
		const { tmpdir } = await import("node:os");
		dir = await mkdtemp(join(tmpdir(), "verify-src-"));
		const path = join(dir, "source");
		await pipeline(
			await browser.getObject({ bucket: config.inputBucket, key }),
			createWriteStream(path),
		);
		const { probeFile } = await import("./adapters");
		const probed = await probeFile(config.ffprobePath, path);
		/**
		 * The VIDEO stream's length, not the container's.
		 *
		 * On the staged mezzanine those differ: `217 frames @ 24fps` is 9.04s of video inside a
		 * 10.04s container, because the audio runs longer. A thumbnail at `positions: [10]` has
		 * no frame to grab, and comparing against 10.04 is what let it reach the encoder —
		 * which answered `Setting up encoding configuration failed! No valid thumbnail positions
		 * set!`
		 */
		return videoSeconds(probed);
	} catch {
		return undefined;
	} finally {
		// The measured source is scratch, including partial downloads.
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Is the staged mezzanine actually present in a NON-S3 input bucket?
 *
 * The capability probe lists a bucket with `limit: 1` and counts what comes back, which proves
 * REACH and nothing more. `generic-s3-akamai-io` was declared runnable on that evidence and then
 * failed with `Download of input file failed. File not found on your GENERIC_S3 storage. (404 Not
 * Found)` — because the harness stages the mezzanine in the S3 input bucket and nowhere else. A
 * reachable bucket is not a stocked one, and the difference is a billed encoding.
 *
 * Measured against the specific key the run will ask for, which is the only question that
 * matters. Returns `undefined` when it cannot be measured, and the caller then submits rather
 * than skipping.
 */
/**
 * Does the run's output prefix already hold objects? A reused run id would let
 * a prior run's artefacts stand as this run's evidence (paid
 * audit BLOCKER-3) — so the prefix must be EMPTY before the first submit.
 */
async function prefixHoldsObjects(
	config: RunnerConfig,
	credentialId: string,
	bucket: string,
	prefix: string,
): Promise<{ holds?: boolean; first?: string; error?: string }> {
	try {
		const credentials = createCredentialStore(config.prisma, cipherFromEnv());
		const row = await credentials.get(credentialId);
		if (!row) {
			return { error: `credential ${credentialId} no longer exists` };
		}
		const browser = createBrowserForCredential({
			provider: row.provider,
			config: (row.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(
				await credentials.revealSecret(credentialId),
			) as Record<string, string>,
		});
		const page = await browser.listObjects({
			bucket,
			prefix,
			limit: 1,
			recursive: true,
		});
		browser.dispose?.();
		const first = page.objects[0]?.key;
		return { holds: first !== undefined, ...(first ? { first } : {}) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

async function sourceStagedIn(
	config: RunnerConfig,
	credentialId: string,
	bucket: string,
	/** The key the plan will actually ask for — per-provider, not the S3 one. */
	key: string,
): Promise<{ present?: boolean; error?: string; found?: string[] }> {
	try {
		const credentials = createCredentialStore(config.prisma, cipherFromEnv());
		const row = await credentials.get(credentialId);
		if (!row) {
			return { error: `credential ${credentialId} no longer exists` };
		}
		const browser = createBrowserForCredential({
			provider: row.provider,
			config: (row.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(
				await credentials.revealSecret(credentialId),
			) as Record<string, string>,
		});
		// The object's DIRECTORY, because `s3.ts` drops a key equal to the prefix — the same
		// trap `verify smoke` documents at length.
		const slash = key.lastIndexOf("/");
		const dir = slash >= 0 ? key.slice(0, slash + 1) : "";
		const page = await browser.listObjects({ bucket, prefix: dir, limit: 100 });
		const present = page.objects.some((o) => o.key === key);
		/**
		 * When the answer is "not there", say WHAT IS.
		 *
		 * The first version reported only absence, and absence of one name is not absence of a
		 * usable source: this bucket turned out to hold a mezzanine under a different name and
		 * prefix, which the owner knew and the harness could not say. A recursive listing costs
		 * one more call and turns "copy the file" into "here is what you already have".
		 */
		let found: string[] | undefined;
		if (!present) {
			const all = await browser.listObjects({
				bucket,
				prefix: "",
				limit: 100,
				recursive: true,
			});
			found = all.objects.map((o) => o.key).slice(0, 20);
		}
		browser.dispose?.();
		return { present, ...(found ? { found } : {}) };
	} catch (err) {
		/**
		 * NAMED, not swallowed. The first version returned `undefined` on any error and the run
		 * logged `COULD NOT MEASURE` with no way to find out why — the same silent-catch mistake
		 * this file has now made three times, in three different places.
		 */
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * One recursive listing of the input bucket, turned into a declared-path → real-key resolver.
 *
 * The fixtures name real relative paths and the bucket has them one prefix down: of the 34 paths
 * the corpus declares, `sintel/subtitles_en.vtt` and `sintel/Sintel.2010.1080p.mkv` resolve under
 * `general/`, and the other 32 are placeholders or assets that are simply not here. I only know
 * that because I listed all 108 objects and matched — the same move that ended the Akamai hunt,
 * and the same move I should have made before writing a staging command and an owner task.
 *
 * Returns a resolver that reports `undefined` for anything absent, so the caller refuses rather
 * than substituting.
 */
async function assetResolver(
	config: RunnerConfig,
): Promise<{ resolve: (path: string) => string | undefined; total: number }> {
	const keys = new Set<string>();
	try {
		const browser = await outputBrowser(config);
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await browser.listObjects({
				bucket: config.inputBucket,
				prefix: "",
				limit: 1000,
				recursive: true,
				...(cursor ? { cursor } : {}),
			});
			for (const o of page.objects) {
				keys.add(o.key);
			}
			cursor = page.nextCursor;
			pages++;
		} while (cursor && pages < 20);
		browser.dispose?.();
	} catch {
		// An unlistable bucket resolves nothing, and the typed-source refusal then stands with
		// its own message. Better than pretending an asset is there.
	}
	const prefix = config.assetPrefix ?? "";
	return {
		total: keys.size,
		resolve: (declared) => {
			for (const candidate of [`${prefix}${declared}`, declared]) {
				if (keys.has(candidate)) {
					return candidate;
				}
			}
			return undefined;
		},
	};
}

/** Read one object's text out of the output bucket. */
async function readOutputText(
	config: RunnerConfig,
	key: string,
	via?: { browser: OutputBrowserT; bucket: string },
): Promise<string> {
	const browser = via?.browser ?? (await outputBrowser(config));
	const bucket = via?.bucket ?? config.outputBucket;
	if (!browser.getObject) {
		throw new Error(
			`the ${config.s3CredentialLabel} driver cannot stream objects, so a live playlist cannot be read`,
		);
	}
	// A live playlist is small. A bounded read rather than an unbounded one, because the
	// wrong key here would otherwise pull a media segment into memory — and the range is
	// generous enough that a 54,000-element DVR manifest still fits.
	const stream = await browser.getObject({
		bucket,
		key,
		range: { start: 0, end: 8 * 1024 * 1024 },
	});
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk as Uint8Array));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** List one prefix in the output bucket, one level, as the engine's deps expect. */
async function listOutput(
	config: RunnerConfig,
	prefix: string,
	via?: { browser: OutputBrowserT; bucket: string },
): Promise<{ key: string; size?: number }[]> {
	/**
	 * Paginated, per C6 — and this one is not theoretical.
	 *
	 * A single page of 100 meant that once a muxing prefix passed 100 objects, both samples
	 * returned exactly 100, `advanced` saw `100 → 100`, and `live:segments` FAILed on a
	 * perfectly healthy channel. The runner deliberately never cleans output, so the prefix
	 * accumulates across nightly runs and crosses 100 within a couple of weeks (review
	 * catch). Bounded so a runaway prefix cannot hang the run, and the bound is REPORTED
	 * rather than silently truncating a count the engine then compares.
	 */
	const browser = via?.browser ?? (await outputBrowser(config));
	const bucket = via?.bucket ?? config.outputBucket;
	const objects: { key: string; size?: number }[] = [];
	let cursor: string | undefined;
	const MAX_PAGES = 40;
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await browser.listObjects({
			bucket,
			prefix,
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		for (const o of res.objects as { key: string; size?: number }[]) {
			objects.push({
				key: o.key,
				...(o.size !== undefined ? { size: o.size } : {}),
			});
		}
		cursor = (res as { nextCursor?: string }).nextCursor;
		if (!cursor) {
			return objects;
		}
	}
	throw new Error(
		`listing ${prefix} exceeded ${MAX_PAGES * 100} objects — refusing to compare a truncated count, which would make a healthy channel look stalled`,
	);
}

export function paidLiveRewrite(
	config: Pick<
		RunnerConfig,
		"runId" | "outputBucket" | "livePublicRead" | "liveEncoderVersion"
	>,
	scenario: string,
	rewrite: {
		bitmovinAccountId: string;
		credentialId: string;
		akamaiStorage?: { credentialId: string; bucket: string };
		akamaiMsl?: {
			credentialId: string;
			streamId: number;
			eventName: string;
			edgeBaseUrl?: string;
		};
	},
) {
	return {
		bitmovinAccountId: rewrite.bitmovinAccountId,
		...(config.liveEncoderVersion
			? { encoderVersion: config.liveEncoderVersion }
			: {}),
		credentialId: rewrite.credentialId,
		outputBucket: config.outputBucket,
		channelName: `${ucNameFor(scenario)} [verify ${config.runId}]`,
		...(rewrite.akamaiStorage ? { akamaiStorage: rewrite.akamaiStorage } : {}),
		...(rewrite.akamaiMsl ? { akamaiMsl: rewrite.akamaiMsl } : {}),
		...(config.livePublicRead ? { publicRead: true } : {}),
		prefix: `verify/${config.runId}/${scenario}/`,
	};
}

/**
 * Run one live scenario, phase C.
 *
 * Thin on purpose: `runner-live.ts` owns the loop, and this owns only the wiring — the
 * session cookie, the storage handles and the feed source. Keeping the loop out of this
 * file is what let it be tested against a fake product without a live channel, which
 * matters because a real live scenario costs encoder minutes and a defect at step six is
 * expensive to find twice.
 */
async function runLive(
	config: RunnerConfig,
	session: string | undefined,
	scenario: { name: string; livePlan?: LiveChannelPlan },
	base: { scenario: string },
	rewrite: {
		bitmovinAccountId: string;
		credentialId: string;
		akamaiStorage?: { credentialId: string; bucket: string };
		akamaiMsl?: {
			credentialId: string;
			streamId: number;
			eventName: string;
			edgeBaseUrl?: string;
		};
	},
	/**
	 * What the evidence tuple binds the run TO
: the exact commit/image this harness runs, and the fed source's
	 * version identity — neither is knowable inside the live loop.
	 */
	evidence: { commit: string; image?: string },
	/** Persist the scenario's evidence legs as they complete (child rows). */
	recordLiveEvidence: (legs: readonly LiveEvidenceLeg[]) => Promise<void>,
): Promise<ScenarioOutcome> {
	const log = config.log ?? (() => {});
	/**
	 * Family-aware artefact readers (2026-08-23, the Akamai live set): the old
	 * readers ignored `outputKey` and read the AWS S3 output bucket
	 * unconditionally, so a GENERIC_S3-output scenario's segments would be
	 * "missing" from a bucket they were never written to. Routing is derived
	 * from the FIXTURE's outputs (keys survive the rewrite) + the same targets
	 * the rewrite applies: S3 → the S3 browser/bucket; GENERIC_S3 → the
	 * registered Akamai credential/bucket; AKAMAI_MSL → a named refusal (MSL
	 * is Akamai's ingest, not readable storage — the engine reports the
	 * observation unavailable rather than inventing one).
	 */
	const outputFamily = new Map<string, { kind: string }>(
		(scenario.livePlan?.outputs ?? []).map((o) => [o.key, { kind: o.kind }]),
	);
	// review-292 S4: one browser per credential, not per read — the reader
	// runs once per muxing per sample and each build is a DB row + AES
	// decrypt + client construct.
	const browserCache = new Map<
		string,
		ReturnType<typeof browserForCredentialId>
	>();
	const cachedBrowser = (id: string) => {
		let hit = browserCache.get(id);
		if (!hit) {
			hit = browserForCredentialId(config, id);
			browserCache.set(id, hit);
		}
		return hit;
	};
	const readerFor = async (outputKey: string) => {
		const kind = outputFamily.get(outputKey)?.kind ?? "S3";
		if (kind === "GENERIC_S3" && rewrite.akamaiStorage) {
			return {
				browser: await cachedBrowser(rewrite.akamaiStorage.credentialId),
				bucket: rewrite.akamaiStorage.bucket,
			};
		}
		if (kind === "AKAMAI_MSL") {
			throw new Error(
				`${UNOBSERVABLE_READ_PREFIX}AKAMAI_MSL is Akamai's ingest, not readable storage — origin read-back is unobservable for this output`,
			);
		}
		// The S3 arm is the path 9 of 12 live fixtures take — memoised under a
		// sentinel key (review-292 follow-up 6: the first memo covered only the
		// Akamai arm, leaving a findMany + decrypt per read on the common path).
		let s3 = browserCache.get("__s3__");
		if (!s3) {
			s3 = outputBrowser(config);
			browserCache.set("__s3__", s3);
		}
		return { browser: await s3, bucket: config.outputBucket };
	};
	const api = liveApiFor(config, session);

	const credentialId = await s3CredentialId(config);
	/**
	 * EV-01: the durable-intent hooks for the channel create. The ledger is
	 * looked up rather than passed, because this function's call site is
	 * being edited by the parallel evidence-tuple work (§14.4 EV-02) and a
	 * sixth argument there would collide with it; the ledger is installed by
	 * `runVerificationRecorded` for exactly the config it runs.
	 */
	const intents = intentLedgerFor.get(config);
	if (!intents) {
		throw new Error(
			"runLive was reached with no intent ledger installed for this run — a harness bug: no live channel may be created without a durable intent",
		);
	}
	const intentKey = verificationKeyFor(
		config.runId,
		scenario.name,
		"LIVE_CHANNEL",
	);
	const result = await runLiveScenario(
		{
			verifyArchives: (input) => verifyLiveArchives(config.prisma, input),
			api,
			readText: async (outputKey, key) =>
				readOutputText(config, key, await readerFor(outputKey)),
			listAll: async (outputKey, prefix) =>
				listOutput(config, prefix, await readerFor(outputKey)),
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			now: () => Date.now(),
			log,
			// The Akamai delivery EDGE reader for MSL mirror-leg closure:
			// a plain HTTP GET as a player would,
			// dormant unless an `edgeBaseUrl` is configured (see
			// `collectEdgeClosures`). Lives in `edge-reader.ts` so its raw-bytes
			// and Last-Modified forwarding are judged by behaviour (rev411 M-A).
			readEdge: edgeReaderFor(),
			...(config.liveMslEdgeAllowedRoots?.length
				? { edgeAllowedRoots: config.liveMslEdgeAllowedRoots }
				: {}),
		},
		{
			plan: scenario.livePlan,
			scenario: scenario.name,
			evidence,
			...(responseLossCanaryFor.get(config)
				? {
						postCreateResponseLossCanary: responseLossCanaryFor.get(
							config,
						) as PostCreateResponseLossCanaryState,
					}
				: {}),
			...(credentialId
				? {
						feed: {
							credentialId,
							bucket: config.inputBucket,
							key: config.sourceObject,
						},
					}
				: {}),
			feedSeconds: config.liveFeedSeconds ?? 0,
			startTimeoutSec: config.liveStartTimeoutSec ?? 600,
			// The rewrite is REQUIRED, not optional: no live fixture carries
			// `bitmovin.accountId` and `/api/live-channels` demands one, so a fixture
			// submitted verbatim is a guaranteed 400. The per-run prefix also keeps
			// `live:segments` meaningful — see `rewriteLiveForRun`.
			rewrite: paidLiveRewrite(config, scenario.name, rewrite),
			intent: {
				key: intentKey,
				prepare: (input) =>
					intents.prepare({
						scenario: scenario.name,
						kind: "LIVE_CHANNEL",
						verificationKey: intentKey,
						requestSha256: input.requestSha256,
						resourceName: input.resourceName,
					}),
				resolveTerminal: async (channelId, product) => {
					const closure = await resolveLiveVerificationIntent(
						config,
						api,
						channelId,
						{
							product: {
								cleanup: product.cleanup,
								stopFailures: [...product.stopFailures],
								...(product.providerId
									? { providerId: product.providerId }
									: {}),
							},
							now: Date.now,
							sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
							log,
						},
					);
					const { terminal, ...terminalInput } = closure;
					return {
						cleanupState: terminal ? "CLEANED" : "UNRESOLVED",
						...terminalInput,
					};
				},
			},
		},
	);
	if (result.submittedPlan) {
		await writeFile(
			join(config.runDir, `${scenario.name}.plan.json`),
			`${JSON.stringify(result.submittedPlan, null, "\t")}\n`,
		);
	}

	/**
	 * Persist the live report the way VOD does, because until now it was thrown away.
	 *
	 * The VOD path writes `<scenario>.report.json` with every check, so "what did this run
	 * actually verify" is answerable afterwards. Live wrote only the one-line summary, so a
	 * `PASS — 12 live check(s) passed, 5 skipped` could not be opened: which twelve, and which
	 * five, was unrecoverable. That made the report unable to answer the question the whole
	 * harness exists for, and it surfaced when I was asked exactly that question.
	 */
	if (result.report) {
		await writeFile(
			join(config.runDir, `${scenario.name}.report.json`),
			`${JSON.stringify({ scenario: scenario.name, channelId: result.channelId, firstPublish: result.firstPublish, report: result.report, evidence: result.evidence }, null, "\t")}\n`,
		);
	}
	// The evidence TUPLE, durably, per scenario as it completes,
	// BEFORE the verdict is derived, so a
	// crash between the two still leaves the legs the run witnessed.
	if (result.evidence) {
		await recordLiveEvidence(result.evidence);
	}
	return outcomeFromLiveResult(result, base, scenario.name);
}

/**
 * The live report → outcome decision, as a pure function.
 *
 * Extracted because it silently dropped `checks` on all four of its paths, which made every
 * live scenario invisible to the report's "greens that verified the least" ranking — a green
 * backed by 13 PASSes and 5 SKIPs could not be weighed against the VOD corpus at all. A
 * decision buried inside an async function that needs a live encoder to reach is a decision
 * nothing can test, so it is out here now and the test asserts the invariant directly: any
 * outcome derived from a report carries that report's counts.
 */
/**
 * Counts → verdict for a VOD scenario report. The twin of the zero-PASS branch
 * in `outcomeFromLiveResult`, and out here for the same stated reason: buried
 * inside `runVerification` it needed a real encoding to reach, so nothing tested
 * it — and the rule the live arm and `exitCodeFor` both apply never arrived.
 *
 * What that cost: the VOD arm scored FAIL=0, WARN=0 as PASS without ever asking
 * whether anything had PASSed. A scenario whose every check SKIPped (credentials
 * absent, or an output that could not be opened at all) therefore read green;
 * the top-level exit sums only FAIL and INVALID, so the process exited 0 and
 * `verify-nightly.sh` printed "all scenarios green" over a corpus that verified
 * nothing. A report with no PASS verified nothing whatever its FAIL count says
 * (design §5) — INVALID keeps a harness or credential problem from reading as
 * an encoder pass, and INVALID is never product-green.
 */
export function vodVerdictForCounts(counts: {
	PASS: number;
	WARN: number;
	FAIL: number;
}): "PASS" | "WARN" | "FAIL" | "INVALID" {
	if (counts.PASS === 0) {
		return "INVALID";
	}
	if (counts.FAIL > 0) {
		return "FAIL";
	}
	if (counts.WARN > 0) {
		return "WARN";
	}
	return "PASS";
}

/**
 * The VOD scenario's verdict AND its reason, together.
 *
 * Extracted for the reason `outcomeFromLiveResult` was: a decision that only a
 * real encoding can reach is a decision nothing can test. The first cut of this
 * fix extracted the RULE and left the wiring inline — and review-298 showed
 * that was not enough. Reverting the single call site to the pre-fix ternary
 * re-introduced the whole defect (all-SKIP scenarios scoring PASS, the nightly
 * printing "all scenarios green") with the entire worker suite still green,
 * because no test invokes `runVerification` at all.
 *
 * Returning the whole outcome leaves the call site a spread with nothing to get
 * wrong. It also removes a second copy of the rule: the old `reason` re-derived
 * `verdict === "INVALID"` beside the verdict that already knew.
 */
export function vodOutcomeForReport(
	report: VerificationReport,
	scenarioName: string,
): {
	verdict: "PASS" | "WARN" | "FAIL" | "INVALID";
	reason: string;
} {
	const counts = report.counts;
	const verdict = vodVerdictForCounts(counts);
	if (verdict === "INVALID") {
		return {
			verdict,
			reason: `no check PASSed for ${scenarioName} — this report verified nothing, which is not a pass`,
		};
	}
	if (counts.FAIL > 0) {
		return {
			verdict,
			reason: report.checks
				.filter((c) => c.verdict === "FAIL")
				.slice(0, 2)
				.map((c) => `${c.id}: ${c.detail}`)
				.join(" | "),
		};
	}
	const unverified = perTitleUnverifiedChecks(report);
	if (unverified.length > 0) {
		return {
			verdict: "INVALID",
			reason: `per-title evidence is UNVERIFIED for ${scenarioName} — ${unverified
				.map((check) => `${check.id}: ${check.detail}`)
				.join("; ")}`,
		};
	}
	return { verdict, reason: `${counts.PASS} check(s) passed` };
}

/**
 * How long the run watches a job it is ABANDONING (cancel → local terminal →
 * provider settled). 's budget, unchanged.
 */
export const ABANDON_CLEANUP_BUDGET_MS = 5 * 60 * 1000;

/**
 * How long it watches a job whose LOCAL row is already terminal but whose
 * provider encodings may not be.
 *
 * Shorter than the abandon budget on purpose: the cancel route cannot act on a
 * terminal job (409), so this budget buys exactly one thing — the chance for a
 * sibling encoding to settle on its own — and a corpus with many FAILs must
 * not pay five minutes for each of them. What it does NOT buy is silence: an
 * unsettled provider is named in the outcome either way.
 */
export const TERMINAL_PROVIDER_BUDGET_MS = 60 * 1000;

/**
 * Is this failure "the encoding is no longer at Bitmovin"?
 *
 * Read off the TYPED status, never the prose. The first cut matched
 * `/404|not found/i` against `err.message`, so a 500 whose message merely
 * contains "404" (a path, an id, a quoted upstream body) read as GONE — i.e.
 * as terminal, which is the one direction this must never fail.
 *
 * The typed read is `isBitmovinError`, not `err instanceof BitmovinCallError`:
 * `getEncodingStatus` is the ONE op in `ops/encoding.ts` that does not go
 * through `audited` (it is `api.encoding.encodings.status(id).then(taskResult)`
 * — the wrapper is what constructs a `BitmovinCallError`), so the error that
 * arrives here is the SDK's own `BitmovinError`. `isBitmovinError` is the guard
 * `BitmovinCallError` itself uses, and it reads `httpStatusCode` off either
 * shape — so no message fallback is needed, and none is kept.
 */
export function encodingIsGone(err: unknown): boolean {
	return isBitmovinError(err) && err.httpStatusCode === 404;
}

/**
 * Product cancellation and provider cost safety are independent attempts.
 * Losing the product route must not skip direct stops for exact, marker-bound
 * provider ids. A zero status keeps the unavailable product acknowledgement
 * visible to `ensureTerminal`; provider readback still decides the seal.
 */
export async function cancelAndStopVerificationEncodings(deps: {
	cancelProduct: () => Promise<number>;
	loadProviderContext: () => Promise<{
		sdk: { stopEncoding: (encodingId: string) => Promise<unknown> };
		ids: readonly string[];
	}>;
}): Promise<number> {
	const cancelHttp = await deps.cancelProduct().catch(() => 0);
	const provider = await deps.loadProviderContext();
	await Promise.allSettled(
		provider.ids.map((encodingId) => provider.sdk.stopEncoding(encodingId)),
	);
	return cancelHttp;
}

/** Cache a proven context, but never turn a transient rejected lookup into fact. */
export function memoizeSuccessfulAsync<T>(
	load: () => Promise<T>,
): () => Promise<T> {
	let cached: Promise<T> | undefined;
	return () => {
		if (!cached) {
			const pending = load();
			cached = pending;
			void pending.catch(() => {
				if (cached === pending) cached = undefined;
			});
		}
		return cached;
	};
}

/**
 * Product cancel + exact provider readback, shared by normal and restart
 * recovery. Re-audit BLOCKER-2 : local CANCELED is insufficient;
 * closure requires the provider's word on every encoding the job created.
 */
function vodCleanupDeps(
	config: Pick<RunnerConfig, "prisma" | "baseUrl" | "apiToken">,
	session: string | undefined,
	jobId: string,
) {
	const discovery = verificationProviderDiscoveryStability();
	let providerProofUncertain = false;
	let providerIdentityConflict = false;
	const loadProviderContext = async () => {
		const row = await config.prisma.encodingJob.findUnique({
			where: { id: jobId },
			select: {
				stepLog: true,
				bitmovinAccountId: true,
				verificationKey: true,
				verificationRequestSha256: true,
			},
		});
		if (!row?.bitmovinAccountId) {
			throw new Error("job has no Bitmovin account");
		}
		const entries = (row.stepLog ?? []) as StepLogEntry[];
		const createEntries = entries.filter(
			(entry) => entry.kind === "CREATE_ENCODING",
		);
		const recorded = createEntries
			.filter(
				(entry): entry is StepLogEntry & { resourceId: string } =>
					typeof entry.resourceId === "string",
			)
			.map((entry) => recordedVerificationEncoding(entry));
		const names = createEntries
			.map((entry) => entry.payload.name)
			.filter(
				(name): name is string => typeof name === "string" && name.length > 0,
			);
		const accounts = createBitmovinAccountStore(config.prisma, cipherFromEnv());
		const account = await accounts.get(row.bitmovinAccountId);
		if (!account) throw new Error("Bitmovin account no longer exists");
		const sdk = makeWorkerSdk(config.prisma)({
			apiKey: await accounts.revealApiKey(row.bitmovinAccountId),
			tenantOrgId: account.tenantOrgId,
			bitmovinAccountId: row.bitmovinAccountId,
		});
		const verification = verificationCreateIdentity(
			row.verificationKey,
			row.verificationRequestSha256,
		);
		if (!verification) {
			return {
				sdk,
				ids: [...new Set(recorded.map((item) => item.encodingId))].sort(),
				identities: [],
				requireGoneIds: [] as string[],
				discoveryStable: true,
				identityConflict: false,
				identityComplete: true,
				providerProofUncertain: false,
			};
		}
		if (names.length === 0) {
			throw new VerificationProviderLookupError(
				"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
				"encoding",
			);
		}
		const found = await captureVerificationProviderDiscovery(() =>
			sdk.findVerificationEncodings({
				jobId,
				verificationKey: verification.key,
				requestSha256: verification.requestSha256,
				resources: createEntries.map((entry) => ({
					step: entry.attempt ? `${entry.step}#${entry.attempt}` : entry.step,
					name: entry.payload.name as string,
				})),
			}),
		);
		const merged = mergeVerificationProviderResources(
			found.identities,
			recorded,
			"encoding",
			possiblySubmittedEncodingSteps(createEntries),
			found.ownedCandidateIds,
		);
		providerProofUncertain ||= found.providerProofUncertain;
		providerIdentityConflict ||= found.identityConflict;
		return {
			sdk,
			...merged,
			identityConflict: merged.identityConflict || providerIdentityConflict,
			identityComplete:
				merged.identityComplete &&
				found.identityComplete &&
				!providerProofUncertain,
			providerProofUncertain,
			discoveryStable: discovery.observe(merged.ids),
		};
	};
	return {
		cancel: () =>
			cancelAndStopVerificationEncodings({
				cancelProduct: async () =>
					(
						await fetch(`${config.baseUrl}/api/encoding-jobs/${jobId}/cancel`, {
							method: "POST",
							headers: authHeaders(config, session),
						})
					).status,
				loadProviderContext,
			}),
		readStatus: async () => {
			const row = await config.prisma.encodingJob.findUnique({
				where: { id: jobId },
				select: { status: true },
			});
			return row ? String(row.status) : undefined;
		},
		readProviderStatuses: async () => {
			const provider = await loadProviderContext();
			// The provider list is intentionally refreshed on every read. A CREATE
			// can be invisible to the first eventually-consistent label query and
			// appear later; caching an empty scan would leak it for the whole cleanup
			// budget. Stop every newly discovered exact id before reading status.
			await Promise.allSettled(
				provider.ids.map((encodingId) => provider.sdk.stopEncoding(encodingId)),
			);
			const identities = new Map(
				provider.identities.map((identity) => [identity.encodingId, identity]),
			);
			const requireGoneIds = new Set(provider.requireGoneIds);
			const statuses: ProviderEncodingStatus[] = [];
			for (const encodingId of provider.ids) {
				statuses.push(
					await readVerificationProviderEncodingStatus(
						(id) => provider.sdk.getEncodingStatus(id),
						encodingId,
						requireGoneIds.has(encodingId),
						identities.get(encodingId),
					),
				);
			}
			if (!provider.discoveryStable) {
				return statuses.map((status) => ({
					...status,
					status: "PROVIDER_DISCOVERY_PENDING",
				}));
			}
			if (!provider.identityComplete) {
				return statuses.map((status) => ({
					...status,
					status: "PROVIDER_DISCOVERY_PENDING",
				}));
			}
			if (provider.identityConflict) {
				return statuses.map((status) => ({
					...status,
					status: "PROVIDER_IDENTITY_CONFLICT",
				}));
			}
			return statuses;
		},
		sleep: () => new Promise<void>((done) => setTimeout(done, 10_000)),
		now: Date.now,
	};
}

type RecordedVerificationEncoding = {
	encodingId: string;
	step: string;
	compensationDeleteSucceeded: boolean;
};

async function captureVerificationProviderDiscovery(
	load: () => Promise<VerificationEncodingIdentity[]>,
): Promise<{
	identities: VerificationEncodingIdentity[];
	identityConflict: boolean;
	identityComplete: boolean;
	providerProofUncertain: boolean;
	ownedCandidateIds: string[];
}> {
	try {
		return {
			identities: await load(),
			identityConflict: false,
			identityComplete: true,
			providerProofUncertain: false,
			ownedCandidateIds: [],
		};
	} catch (err) {
		if (!(err instanceof VerificationProviderLookupError)) throw err;
		const conflict = [
			"VERIFICATION_PROVIDER_SHA_CONFLICT",
			"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			"VERIFICATION_PROVIDER_DUPLICATE",
		].includes(err.code);
		return {
			identities: [...err.provenIdentities],
			identityConflict: conflict,
			identityComplete: false,
			providerProofUncertain: true,
			ownedCandidateIds: [...err.ownedCandidateIds],
		};
	}
}

function recordedVerificationEncoding(
	entry: StepLogEntry & { resourceId: string },
): RecordedVerificationEncoding {
	const response =
		typeof entry.response === "object" && entry.response !== null
			? (entry.response as Record<string, unknown>)
			: undefined;
	const compensation =
		typeof response?.compensation === "object" && response.compensation !== null
			? (response.compensation as Record<string, unknown>)
			: undefined;
	return {
		encodingId: entry.resourceId,
		step: entry.attempt ? `${entry.step}#${entry.attempt}` : entry.step,
		compensationDeleteSucceeded:
			response?.providerId === entry.resourceId &&
			response?.source === "created" &&
			response?.durability === "DEFINITELY_NOT_PERSISTED" &&
			compensation?.delete === "SUCCEEDED",
	};
}

/**
 * Reconcile two independent identity channels: exact provider marker scan and
 * the id captured directly from CREATE. A locally recorded id missing from the
 * marker scan is unsafe unless bounded compensation says delete succeeded; in
 * that one case it remains in the possible set until a direct typed 404 proves
 * it gone. Extra marker-bound ids are always included, never hidden by the
 * locally recorded id.
 */
export function mergeVerificationProviderResources(
	identities: readonly VerificationEncodingIdentity[],
	recorded: readonly RecordedVerificationEncoding[],
	label: string,
	expectedSteps: readonly string[] = [],
	ownedCandidateIds: readonly string[] = [],
): {
	ids: string[];
	identities: VerificationEncodingIdentity[];
	requireGoneIds: string[];
	identityConflict: boolean;
	identityComplete: boolean;
} {
	const discoveredIds = new Set(
		identities.map((identity) => identity.encodingId),
	);
	const requireGoneIds = new Set<string>();
	let recordedIdentityMissing = false;
	for (const item of recorded) {
		if (item.compensationDeleteSucceeded) {
			requireGoneIds.add(item.encodingId);
			continue;
		}
		if (!discoveredIds.has(item.encodingId)) {
			recordedIdentityMissing = true;
		}
	}
	const coveredSteps = new Set([
		...identities.map((identity) => identity.step),
		...recorded
			.filter((item) => item.compensationDeleteSucceeded)
			.map((item) => item.step),
	]);
	const identityComplete =
		!recordedIdentityMissing &&
		expectedSteps.every((step) => coveredSteps.has(step));
	const identityCountsByStep = new Map<string, number>();
	for (const identity of identities) {
		identityCountsByStep.set(
			identity.step,
			(identityCountsByStep.get(identity.step) ?? 0) + 1,
		);
	}
	const expectedStepSet = new Set(expectedSteps);
	const identityConflict =
		[...identityCountsByStep.values()].some((count) => count !== 1) ||
		identities.some(
			(identity) =>
				expectedStepSet.size > 0 && !expectedStepSet.has(identity.step),
		);
	const ids = [
		...new Set([
			...identities.map((identity) => identity.encodingId),
			...recorded.map((item) => item.encodingId),
			...ownedCandidateIds,
		]),
	].sort();
	if (ids.length === 0) {
		// Empty is not absence after a product submission. Refuse a successful
		// context so the next poll re-runs the provider label scan; this is the
		// eventual-consistency window in which a billable encoding can appear.
		throw new VerificationProviderLookupError(
			"VERIFICATION_PROVIDER_LOOKUP_UNKNOWN",
			label,
		);
	}
	return {
		ids,
		identities: [...identities],
		requireGoneIds: [...requireGoneIds].sort(),
		identityConflict,
		identityComplete,
	};
}

function possiblySubmittedEncodingSteps(
	entries: readonly StepLogEntry[],
): string[] {
	return entries
		.filter(
			(entry) =>
				entry.status !== "PENDING" ||
				entry.startedAt !== undefined ||
				entry.finishedAt !== undefined ||
				entry.resourceId !== undefined,
		)
		.map((entry) =>
			entry.attempt ? `${entry.step}#${entry.attempt}` : entry.step,
		);
}

const PROVIDER_DISCOVERY_STABILITY_MS = 10_000;

/**
 * Require the exact provider-id set to remain unchanged across a real polling
 * interval before closure. This gives an eventually-consistent label index a
 * second chance to reveal a duplicate with the same step marker; a first
 * non-empty page is discovery, not completeness proof.
 */
export function verificationProviderDiscoveryStability(
	now: () => number = Date.now,
) {
	let signature: string | undefined;
	let firstObservedAt = 0;
	return {
		observe(ids: readonly string[]): boolean {
			const next = [...new Set(ids)].sort().join("\u0000");
			const at = now();
			if (next !== signature) {
				signature = next;
				firstObservedAt = at;
				return false;
			}
			return at - firstObservedAt >= PROVIDER_DISCOVERY_STABILITY_MS;
		},
	};
}

/** One exact-id readback; delete compensation closes only on provider 404. */
export async function readVerificationProviderEncodingStatus(
	getStatus: (encodingId: string) => Promise<{ status: string }>,
	encodingId: string,
	requireGone: boolean,
	identity?: VerificationEncodingIdentity,
): Promise<ProviderEncodingStatus> {
	try {
		const status = (await getStatus(encodingId)).status;
		return {
			encodingId,
			status: requireGone ? "COMPENSATION_DELETE_PENDING" : status,
			...(identity ? { identity } : {}),
		};
	} catch (err) {
		if (!encodingIsGone(err)) throw err;
		return {
			encodingId,
			status: "NOT_FOUND",
			...(identity ? { identity } : {}),
		};
	}
}

type LiveVerificationProviderContext = {
	sdk: ReturnType<ReturnType<typeof makeWorkerSdk>>;
	ids: string[];
	identities: VerificationEncodingIdentity[];
	requireGoneIds: string[];
	identityConflict: boolean;
	identityComplete: boolean;
	providerProofUncertain: boolean;
	row: {
		status: string;
		bitmovinEncodingId: string | null;
		verificationKey: string | null;
		verificationRequestSha256: string | null;
	};
};

async function liveVerificationProviderContext(
	config: Pick<RunnerConfig, "prisma">,
	channelId: string,
): Promise<LiveVerificationProviderContext> {
	const row = await config.prisma.liveChannel.findUnique({
		where: { id: channelId },
		select: {
			status: true,
			stepLog: true,
			bitmovinAccountId: true,
			bitmovinEncodingId: true,
			verificationKey: true,
			verificationRequestSha256: true,
		},
	});
	if (!row?.bitmovinAccountId) {
		throw new Error("live channel has no Bitmovin account");
	}
	const verification = verificationCreateIdentity(
		row.verificationKey,
		row.verificationRequestSha256,
	);
	if (!verification) {
		throw new VerificationProviderLookupError(
			"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			"live encoding",
		);
	}
	const entries = (row.stepLog ?? []) as StepLogEntry[];
	const names = entries
		.filter((entry) => entry.kind === "CREATE_ENCODING")
		.map((entry) => entry.payload.name)
		.filter(
			(name): name is string => typeof name === "string" && name.length > 0,
		);
	if (names.length === 0) {
		throw new VerificationProviderLookupError(
			"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			"live encoding",
		);
	}
	const accounts = createBitmovinAccountStore(config.prisma, cipherFromEnv());
	const account = await accounts.get(row.bitmovinAccountId);
	if (!account) throw new Error("Bitmovin account no longer exists");
	const sdk = makeWorkerSdk(config.prisma)({
		apiKey: await accounts.revealApiKey(row.bitmovinAccountId),
		tenantOrgId: account.tenantOrgId,
		bitmovinAccountId: row.bitmovinAccountId,
	});
	const found = await captureVerificationProviderDiscovery(() =>
		sdk.findVerificationEncodings({
			jobId: channelId,
			verificationKey: verification.key,
			requestSha256: verification.requestSha256,
			resources: entries
				.filter((entry) => entry.kind === "CREATE_ENCODING")
				.map((entry) => ({
					step: entry.attempt ? `${entry.step}#${entry.attempt}` : entry.step,
					name: entry.payload.name as string,
				})),
		}),
	);
	const liveCreateEntries = entries.filter(
		(entry) => entry.kind === "CREATE_ENCODING",
	);
	const recorded = liveCreateEntries
		.filter(
			(entry): entry is StepLogEntry & { resourceId: string } =>
				typeof entry.resourceId === "string",
		)
		.map(recordedVerificationEncoding);
	if (
		row.bitmovinEncodingId &&
		!recorded.some((item) => item.encodingId === row.bitmovinEncodingId)
	) {
		const step = liveCreateEntries[0];
		if (!step) {
			throw new VerificationProviderLookupError(
				"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
				"live encoding",
			);
		}
		recorded.push({
			encodingId: row.bitmovinEncodingId,
			step: step.attempt ? `${step.step}#${step.attempt}` : step.step,
			compensationDeleteSucceeded: false,
		});
	}
	const merged = mergeVerificationProviderResources(
		found.identities,
		recorded,
		"live encoding",
		possiblySubmittedEncodingSteps(liveCreateEntries),
		found.ownedCandidateIds,
	);
	return {
		sdk,
		...merged,
		identityConflict: merged.identityConflict || found.identityConflict,
		identityComplete:
			merged.identityComplete &&
			found.identityComplete &&
			!found.providerProofUncertain,
		providerProofUncertain: found.providerProofUncertain,
		row: {
			status: String(row.status),
			bitmovinEncodingId: row.bitmovinEncodingId,
			verificationKey: row.verificationKey,
			verificationRequestSha256: row.verificationRequestSha256,
		},
	};
}

const LIVE_PROVIDER_DISCOVERY_BUDGET_MS = 60_000;

/**
 * Re-scan the eventually-consistent label index before Live closure. Every
 * exact id already visible is stopped immediately, while the set must remain
 * stable for a polling interval and cover every possibly-submitted step.
 */
async function stabilizeLiveVerificationProviderContext(
	load: () => Promise<LiveVerificationProviderContext>,
	initial: LiveVerificationProviderContext | undefined,
	options: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<LiveVerificationProviderContext> {
	const stability = verificationProviderDiscoveryStability(options.now);
	const deadline = options.now() + LIVE_PROVIDER_DISCOVERY_BUDGET_MS;
	let aggregate = initial;
	let current = initial;
	let lastError: unknown;
	for (;;) {
		if (!current) {
			try {
				current = await load();
			} catch (err) {
				lastError = err;
			}
		}
		if (current) {
			aggregate = aggregate
				? {
						...current,
						ids: [...new Set([...aggregate.ids, ...current.ids])].sort(),
						identities: [
							...new Map(
								[...aggregate.identities, ...current.identities].map(
									(identity) => [identity.encodingId, identity],
								),
							).values(),
						].sort((a, b) => a.encodingId.localeCompare(b.encodingId)),
						requireGoneIds: [
							...new Set([
								...aggregate.requireGoneIds,
								...current.requireGoneIds,
							]),
						].sort(),
						identityConflict:
							aggregate.identityConflict || current.identityConflict,
						providerProofUncertain:
							aggregate.providerProofUncertain ||
							current.providerProofUncertain,
					}
				: current;
			const known = aggregate;
			await Promise.allSettled(
				known.ids.map((id) => known.sdk.stopLiveEncoding(id)),
			);
			const stable = stability.observe(current.ids);
			if (
				stable &&
				(current.identityComplete || current.identityConflict) &&
				!known.providerProofUncertain
			) {
				return known;
			}
		}
		if (options.now() >= deadline) {
			if (aggregate) {
				return { ...aggregate, identityComplete: false };
			}
			throw (
				lastError ?? new Error("live provider identity remained undiscoverable")
			);
		}
		await options.sleep(10_000);
		try {
			current = await load();
		} catch (err) {
			lastError = err;
			current = undefined;
		}
	}
}

export async function stopAndReadLiveVerificationProviders(
	sdk: ReturnType<ReturnType<typeof makeWorkerSdk>>,
	ids: readonly string[],
	options: {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
		requireGoneIds?: readonly string[];
		identityConflict?: boolean;
		identityComplete?: boolean;
	},
): Promise<ProviderEncodingStatus[]> {
	const deadline = options.now() + ABANDON_CLEANUP_BUDGET_MS;
	const requireGoneIds = new Set(options.requireGoneIds ?? []);
	const identityConflict = options.identityConflict ?? false;
	const identityComplete = options.identityComplete ?? true;
	let statuses: ProviderEncodingStatus[] = [];
	for (;;) {
		// Stop is idempotent and retried with each status poll. A transient
		// provider failure must not consume the only cost-safety attempt.
		await Promise.allSettled(ids.map((id) => sdk.stopLiveEncoding(id)));
		statuses = [];
		for (const encodingId of ids) {
			try {
				statuses.push(
					await readVerificationProviderEncodingStatus(
						(id) => sdk.getEncodingStatus(id),
						encodingId,
						requireGoneIds.has(encodingId),
					),
				);
			} catch {
				// A transient GET is unknown, not terminal and not a reason to stop
				// retrying the idempotent stop. Keep no provider-owned error text in
				// the dossier; the next poll reissues both stop and status read.
				statuses.push({
					encodingId,
					status: "PROVIDER_STATUS_UNKNOWN",
				});
			}
		}
		if (
			(!identityConflict &&
				identityComplete &&
				statuses.every((status) =>
					isProviderEncodingTerminal(status.status),
				)) ||
			options.now() >= deadline
		) {
			if (identityConflict) {
				return statuses.map((status) => ({
					...status,
					status: "PROVIDER_IDENTITY_CONFLICT",
				}));
			}
			if (!identityComplete) {
				return statuses.map((status) => ({
					...status,
					status: "PROVIDER_DISCOVERY_PENDING",
				}));
			}
			return statuses;
		}
		await options.sleep(10_000);
	}
}

type LiveProductCleanup = Awaited<ReturnType<typeof teardownAdoptedChannel>>;

const redundantLiveStopConflict = (failure: string): boolean =>
	/^(?:channel|feeder) .+ refused the stop: HTTP 409$/.test(failure);

const exactResourceSet = (
	possible: readonly string[],
	cleaned: readonly string[],
) =>
	possible.length === cleaned.length &&
	possible.every((key, index) => key === cleaned[index]);

/**
 * One closure algorithm for every Live intent exit (normal scenario finally,
 * run-level teardown, and process-death recovery). It discovers the exact
 * marker-bound provider SET until stable, stops every member, reads every
 * member terminal, and only then constructs the set-equality dossier.
 */
export async function resolveLiveVerificationIntentCleanup(input: {
	channelId: string;
	product: LiveProductCleanup;
	loadProviderContext: () => Promise<LiveVerificationProviderContext>;
	initialProvider?: LiveVerificationProviderContext;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}): Promise<IntentReadback> {
	let provider = input.initialProvider;
	let providerLookupError: string | undefined;
	try {
		provider = await stabilizeLiveVerificationProviderContext(
			input.loadProviderContext,
			provider,
			{ now: input.now, sleep: input.sleep },
		);
	} catch (err) {
		providerLookupError = recordableError(err);
	}
	const localKey = verificationLocalResourceKey(
		"LIVE_CHANNEL",
		input.channelId,
	);
	if (!provider) {
		const providerKey = input.product.providerId
			? verificationProviderEncodingKey(input.product.providerId)
			: undefined;
		const cleanup = finalizeLiveCleanupSeal(input.product.cleanup, {
			established: false,
			detail: "EV-01 exact resource-set lookup is unreadable",
		});
		return {
			terminal: false,
			readback: {
				channelId: input.channelId,
				...input.product,
				cleanup,
				providerLookupError,
			},
			providerId: input.product.providerId ?? null,
			providerIds: input.product.providerId ? [input.product.providerId] : [],
			possiblyCreatedKeys: [localKey, ...(providerKey ? [providerKey] : [])],
			cleanedResourceKeys: [
				...(cleanup.localTerminal.established ? [localKey] : []),
			],
			error: `provider marker lookup is unproven: ${providerLookupError ?? "unknown"}`,
		};
	}

	const providerStatuses = await stopAndReadLiveVerificationProviders(
		provider.sdk,
		provider.ids,
		{
			now: input.now,
			sleep: input.sleep,
			requireGoneIds: provider.requireGoneIds,
			identityConflict: provider.identityConflict,
			identityComplete: provider.identityComplete,
		},
	);
	const providerTerminalObservedAt = new Date(input.now()).toISOString();
	const providerIds = [
		...new Set([
			...provider.ids,
			...(input.product.providerId ? [input.product.providerId] : []),
		]),
	].sort();
	const providerKeys = providerIds.map(verificationProviderEncodingKey);
	const terminalProviderIds = new Set(
		providerStatuses
			.filter((status) => isProviderEncodingTerminal(status.status))
			.map((status) => status.encodingId),
	);
	const providerTerminal =
		providerIds.length > 0 &&
		providerIds.every((id) => terminalProviderIds.has(id));
	const exactProviderSetTerminal =
		providerTerminal &&
		provider.identityComplete === true &&
		provider.identityConflict !== true &&
		provider.providerProofUncertain !== true;
	const cleanup = finalizeLiveCleanupSeal(input.product.cleanup, {
		established: exactProviderSetTerminal,
		detail: exactProviderSetTerminal
			? `EV-01 exact provider set read terminal (${providerStatuses
					.map((status) => `${status.encodingId} ${status.status}`)
					.join(", ")})`
			: "EV-01 exact resource-set readback is unresolved",
	});
	const possiblyCreatedKeys = [localKey, ...providerKeys].sort();
	const cleanedResourceKeys = [
		...(input.product.cleanup.localTerminal.established ? [localKey] : []),
		...providerIds
			.filter((id) => terminalProviderIds.has(id))
			.map(verificationProviderEncodingKey),
	].sort();
	const exactResourceSetTerminal = exactResourceSet(
		possiblyCreatedKeys,
		cleanedResourceKeys,
	);
	const redundantStopFailures = input.product.stopFailures.filter(
		redundantLiveStopConflict,
	);
	const blockingStopFailures = input.product.stopFailures.filter(
		(failure) => !redundantLiveStopConflict(failure),
	);
	const terminal =
		cleanup.clean &&
		blockingStopFailures.length === 0 &&
		exactProviderSetTerminal &&
		exactResourceSetTerminal;
	return {
		terminal,
		readback: {
			channelId: input.channelId,
			...input.product,
			cleanup: {
				...cleanup,
				// A 409 means "already stopping/stopped" only after independent
				// terminal readback and exact possible==cleaned resource-set proof.
				clean: terminal,
			},
			...(redundantStopFailures.length > 0 ? { redundantStopFailures } : {}),
			providerStatuses,
			providerTerminalObservedAt,
			providerIdentities: provider.identities,
			providerIdentityComplete: provider.identityComplete,
			providerIdentityConflict: provider.identityConflict,
			providerProofUncertain: provider.providerProofUncertain,
		},
		providerId:
			input.product.providerId ??
			(providerIds.length === 1 ? providerIds[0] : null),
		providerIds,
		possiblyCreatedKeys,
		cleanedResourceKeys,
		...(!terminal
			? {
					error:
						blockingStopFailures.join("; ") ||
						"live provider encoding set or terminal cleanup is unproven",
				}
			: {}),
	};
}

async function resolveLiveVerificationIntent(
	config: Pick<RunnerConfig, "prisma">,
	api: ReturnType<typeof liveApiFor>,
	channelId: string,
	options: {
		product?: LiveProductCleanup;
		now: () => number;
		sleep: (ms: number) => Promise<void>;
		log?: (line: string) => void;
	},
): Promise<IntentReadback> {
	let initialProvider: LiveVerificationProviderContext | undefined;
	try {
		initialProvider = await liveVerificationProviderContext(config, channelId);
	} catch {
		// The shared resolver below retries discovery for its full bounded window.
	}
	if (
		!options.product &&
		initialProvider?.row.bitmovinEncodingId === null &&
		initialProvider.ids.length === 1 &&
		initialProvider.row.status === "ERROR" &&
		initialProvider.identityComplete &&
		!initialProvider.identityConflict
	) {
		// Exact key+SHA+provider marker proved the lost id. Restore only an ERROR
		// row with no pointer so the product cleanup seal can read provider state.
		await config.prisma.liveChannel.updateMany({
			where: {
				id: channelId,
				status: "ERROR",
				bitmovinEncodingId: null,
				verificationKey: initialProvider.row.verificationKey,
				verificationRequestSha256:
					initialProvider.row.verificationRequestSha256,
			},
			data: { bitmovinEncodingId: initialProvider.ids[0] },
		});
	}
	const product =
		options.product ??
		(await teardownAdoptedChannel(
			{
				api,
				now: options.now,
				sleep: options.sleep,
				...(options.log ? { log: options.log } : {}),
			},
			channelId,
		));
	return resolveLiveVerificationIntentCleanup({
		channelId,
		product,
		loadProviderContext: () =>
			liveVerificationProviderContext(config, channelId),
		...(initialProvider ? { initialProvider } : {}),
		now: options.now,
		sleep: options.sleep,
	});
}

/**
 * What the report says about the provider side of a cleanup.
 *
 * An empty read is UNKNOWN, not absence: provider CREATE may have succeeded
 * immediately before the local step-log/provider-id write died.
 */
export function providerWord(cleanup: {
	provider?: readonly ProviderEncodingStatus[];
	providerTerminal: boolean | "unread";
}): string {
	if (cleanup.provider && cleanup.provider.length > 0) {
		return cleanup.provider
			.map((p) => `${p.encodingId.slice(0, 8)}=${p.status}`)
			.join(",");
	}
	if (cleanup.providerTerminal === "unread") {
		return "provider unread";
	}
	if (cleanup.providerTerminal === true) {
		return "provider terminal";
	}
	return cleanup.provider ? "provider identity unknown" : "provider unreadable";
}

/** Exact identities observed and individually proven terminal for a VOD job. */
export function vodIntentResourceSets(
	jobId: string,
	provider: readonly ProviderEncodingStatus[] | undefined,
	localTerminal: boolean,
): {
	providerIds: string[];
	possiblyCreatedKeys: string[];
	cleanedResourceKeys: string[];
} {
	const providerIds = [
		...new Set((provider ?? []).map((p) => p.encodingId)),
	].sort();
	const possiblyCreatedKeys = [
		verificationLocalResourceKey("VOD_JOB", jobId),
		...providerIds.map(verificationProviderEncodingKey),
	].sort();
	const terminalProviderIds = new Set(
		(provider ?? [])
			.filter((p) => isProviderEncodingTerminal(p.status))
			.map((p) => p.encodingId),
	);
	const cleanedResourceKeys = [
		...(localTerminal ? [verificationLocalResourceKey("VOD_JOB", jobId)] : []),
		...providerIds
			.filter((id) => terminalProviderIds.has(id))
			.map(verificationProviderEncodingKey),
	].sort();
	return { providerIds, possiblyCreatedKeys, cleanedResourceKeys };
}

/**
 * The report line for a job whose LOCAL status went terminal but not FINISHED.
 *
 * A verdict, extracted for the reason `vodOutcomeForReport` was: the call site
 * is unreachable by any test, so a rule left inline there is a rule nothing
 * pins. The rule itself is the audit's: "never claim a job is over without the
 * PROVIDER's word". That was scoped to the abandon/cancel path only, so a
 * multi-encoding plan whose FIRST encoding errored — job row FAILED — closed
 * its report while a sibling encoding was still RUNNING and billing (review of
 * this PR). The verdict is unchanged (FAIL is the product's answer); what
 * changes is that the line cannot say the job is over when the provider says
 * it is not.
 */
export function failedJobOutcome(
	terminal: { status: string; error: string | null },
	cleanup: {
		terminal: boolean;
		provider?: readonly ProviderEncodingStatus[];
		providerTerminal: boolean | "unread";
	},
): { verdict: "FAIL"; reason: string } {
	const why = `job ${terminal.status}: ${terminal.error?.slice(0, 200) ?? "no error recorded"}`;
	const word = providerWord(cleanup);
	return {
		verdict: "FAIL",
		reason: cleanup.terminal
			? `${why} (provider ${word})`
			: `${why} — but the PROVIDER is NOT terminal (${word}): the encoding may still be billing, stop it by hand`,
	};
}

export function outcomeFromLiveResult(
	result: {
		invalid?: string;
		report?: VerificationReport;
		firstPublish?: { ms?: number; polls: number; note: string };
		/**
		 * The durable teardown seal. When
		 * present and NOT clean it seals the run INVALID before any report-based
		 * verdict — a missing teardown element is not run success — and it rides
		 * onto EVERY outcome so the evidence lands in the run row regardless of
		 * verdict.
		 */
		cleanup?: LiveCleanupSeal;
		/**
		 * The evidence legs. Summarised onto
		 * every outcome; a PASS/WARN is refused — INVALID, never FAIL, because a
		 * verifier gap is not a delivery failure — unless every leg is complete.
		 */
		evidence?: readonly LiveEvidenceLeg[];
	},
	base: { scenario: string },
	scenarioName: string,
): ScenarioOutcome {
	// Attached to EVERY path, including the INVALID ones: a channel that came up and then
	// failed to tear down still measured its origin, and that number is still worth having.
	const publish = result.firstPublish
		? {
				...(result.firstPublish.ms !== undefined
					? { firstPublishMs: result.firstPublish.ms }
					: {}),
				firstPublishNote: result.firstPublish.note,
			}
		: {};
	const evidence = result.evidence
		? summarizeLiveEvidence(result.evidence)
		: undefined;
	// The seal and the evidence summary ride onto every outcome, whatever the
	// verdict — the run row must carry the teardown and delivery evidence for
	// a PASS as much as for an INVALID.
	const withCleanup = (outcome: ScenarioOutcome): ScenarioOutcome => ({
		...outcome,
		...(result.cleanup ? { liveCleanup: result.cleanup } : {}),
		...(evidence ? { liveEvidence: evidence } : {}),
	});
	if (result.invalid) {
		return withCleanup({
			...base,
			...publish,
			verdict: "INVALID",
			reason: result.invalid,
		});
	}
	// A teardown that did not prove itself is not a success, whatever the report
	// said. BEFORE any report-based
	// verdict: a green report over a push that may still be running is exactly
	// the false-clean the seal exists to refuse.
	if (result.cleanup && !result.cleanup.clean) {
		return withCleanup({
			...base,
			...publish,
			verdict: "INVALID",
			reason: `live cleanup did not seal clean for ${scenarioName} — ${unestablishedCleanupElements(
				result.cleanup,
			).join("; ")}`,
			...(result.report ? { checks: result.report.counts } : {}),
		});
	}
	const outcome = liveReportOutcome(result.report, base, publish, scenarioName);
	/**
	 * The evidence gate: a green live
	 * outcome must be BACKED by a complete tuple — source, plan, provider
	 * resource, edge/origin media bytes, two probes with progression, provider
	 * terminal, cleanup — for every output leg. AFTER the report verdict: a
	 * FAIL the engine found stays a FAIL (it says more than "unverified"), and
	 * a missing element makes the run INVALID, never a delivery failure.
	 */
	if (outcome.verdict === "PASS" || outcome.verdict === "WARN") {
		const gate = liveEvidenceSupportsPass(evidence);
		if (!gate.ok) {
			return withCleanup({
				...outcome,
				verdict: "INVALID",
				reason: `the live evidence tuple for ${scenarioName} is not complete, so this ${outcome.verdict} is not sealed — ${gate.reason}`,
			});
		}
	}
	return withCleanup(outcome);
}

/**
 * The live report → verdict decision, split out so the durable cleanup seal
 * is attached to EVERY outcome by the one
 * `withCleanup` in `outcomeFromLiveResult` rather than repeated on each return
 * below. Every branch here is reached only after the seal proved clean (an
 * unclean seal seals INVALID before this runs), so the verdict logic is
 * unchanged from before the seal existed.
 */
function liveReportOutcome(
	report: VerificationReport | undefined,
	base: { scenario: string },
	publish: Partial<ScenarioOutcome>,
	scenarioName: string,
): ScenarioOutcome {
	if (!report) {
		return {
			...base,
			...publish,
			verdict: "INVALID",
			reason: "the live runner returned neither a report nor a reason",
		};
	}
	// A report with no PASS verified nothing, whatever its FAIL count says — the same rule
	// `exitCodeFor` applies to the VOD side (design §5).
	if (report.counts.PASS === 0) {
		return {
			...base,
			...publish,
			verdict: "INVALID",
			reason: `no live check PASSed for ${scenarioName} — this report verified nothing`,
			checks: report.counts,
		};
	}
	if (report.failed > 0) {
		const first = report.checks.find((c) => c.verdict === "FAIL");
		return {
			...base,
			...publish,
			verdict: "FAIL",
			reason: `${report.failed} live check(s) failed, first: ${first?.id}: ${first?.detail}`,
			checks: report.counts,
		};
	}
	/**
	 * A run that observed NO delivery cannot be a pass. AKR-E57-007,
	 * .
	 *
	 * The zero-PASS floor above does not reach this: an MSL channel's
	 * provisioning and heartbeat checks PASS honestly, while every manifest
	 * check SKIPs because `AKAMAI_MSL` is Akamai's ingest and its origin cannot
	 * be read back by any driver. So the scenario reported PASS on 8 PASS / 11
	 * SKIP — and a manual closure against the Staging edge found 116 of 116
	 * segments returning 404. The verifier said the delivery worked; nothing
	 * had looked at a delivered byte.
	 *
	 * INVALID rather than FAIL, and the distinction is the point: the product
	 * may well be fine. What is not fine is calling it verified. INVALID is
	 * already this harness's word for "a harness or credential problem must not
	 * read as an encoder pass" (design §5), and an unobservable topology is
	 * exactly that.
	 *
	 * Detected STRUCTURALLY — every manifest check skipped — rather than by
	 * matching the unobservable message, so a reworded skip reason cannot
	 * silently restore the false pass.
	 *
	 * SCOPE, so the next reader does not have to re-derive it. Only two sites
	 * in `engine-live.ts` emit this prefix: `live:manifest:${manifestKey}` and
	 * its `:entries` child, which cannot PASS unless its parent did. The other
	 * delivery-ish checks (`live:dvr:*`, `live:segments`, `live:segment-bytes`,
	 * `live:media-sequence`) are deliberately NOT in the population: they read
	 * the same playlist that throws UNOBSERVABLE for MSL, so including them
	 * could only make this stricter, never less blind.
	 *
	 * What this floor still cannot see is a PARTIALLY blind topology — the
	 * manifest population comes from `expected.manifests`, which omits mirror
	 * outputs entirely, so a plan delivering to an origin AND an MSL mirror
	 * passes on the origin's manifests while nothing ever looks at the mirror.
	 * Recorded as 's remaining item (b) rather than fixed here.
	 *
	 * AFTER the FAIL branch on purpose: a manifest that was read and found
	 * wrong is a product failure and says more than "unverified". My first cut
	 * put this first and turned a real FAIL into INVALID — caught by the arm
	 * written to assert the opposite.
	 */
	// A direct AKAMAI_MSL primary has no readable storage manifest. Its
	// `live:manifest:*` checks therefore SKIP by design; delivery is instead
	// established by the credential-bound `live:edge:*` checks. Treating only
	// storage manifests as delivery would make a fully closed direct MSL run
	// INVALID forever — the same impossible-ORIGIN topology EV-02 removes from
	// the evidence tuple.
	const deliveryChecks = report.checks.filter(
		(c) => c.id.startsWith("live:manifest:") || c.id.startsWith("live:edge:"),
	);
	if (
		deliveryChecks.length > 0 &&
		!deliveryChecks.some((c) => c.verdict === "PASS")
	) {
		return {
			...base,
			...publish,
			verdict: "INVALID",
			reason: `no manifest was verified and no direct MSL edge was verified for ${scenarioName} — every delivery check was skipped (${deliveryChecks.length} manifest/edge check(s), none passed), so this report says nothing about whether anything was delivered`,
			checks: report.counts,
		};
	}
	/**
	 * The PARTIALLY-blind mirror topology the manifest floor above could not see
	 * .
	 *
	 * An origin + MSL-mirror plan passes the manifest floor on the origin's OWN
	 * manifests — the mirror output is not in `expected.manifests` at all — so
	 * the origin PASS was laundering into a whole-run PASS while nothing looked
	 * at the mirror (the deferred partial-blind-mirror item, row 187(b)). The
	 * manual closure that exposed the incident found the origin green and
	 * 116/116 segments 404 on the Akamai edge.
	 *
	 * So every `live:mirror:*` leg must be individually observed: a leg that did
	 * not PASS is UNOBSERVED (no edge base URL to read it back), and an
	 * origin-only PASS must NOT pass the run while ANY mirror leg is unseen.
	 * AFTER the FAIL branch, like the manifest floor: a mirror the edge read and
	 * found empty is a product FAIL and says more than "unverified", so it never
	 * reaches here. INVALID, not FAIL: the mirror may well be delivering — what
	 * is not fine is calling it verified (design §5).
	 */
	const mirrorChecks = report.checks.filter((c) =>
		c.id.startsWith("live:mirror:"),
	);
	const unobservedMirrors = mirrorChecks.filter((c) => c.verdict !== "PASS");
	if (mirrorChecks.length > 0 && unobservedMirrors.length > 0) {
		return {
			...base,
			...publish,
			verdict: "INVALID",
			reason: `a delivery-mirror leg was not observed for ${scenarioName} — ${unobservedMirrors.length} of ${mirrorChecks.length} mirror check(s) did not PASS (first: ${unobservedMirrors[0]?.id}), so the origin PASS says nothing about whether the mirror delivered`,
			checks: report.counts,
		};
	}
	// Archive-only floor: generic SKIPs retain their meaning. A verified live
	// delivery leg cannot stand in for an unobserved post-stop MP4 copy.
	const unverifiedArchives = report.checks.filter(
		(check) => check.id.startsWith("live:archive:") && check.verdict !== "PASS",
	);
	if (unverifiedArchives.length > 0) {
		return {
			...base,
			...publish,
			verdict: "INVALID",
			reason: `MP4 archive evidence is UNVERIFIED for ${scenarioName} — ${unverifiedArchives.length} archive check(s) did not PASS (first: ${unverifiedArchives[0]?.id}); live delivery does not prove the archive`,
			checks: report.counts,
		};
	}
	return {
		...base,
		...publish,
		verdict: report.counts.WARN > 0 ? "WARN" : "PASS",
		reason: `${report.counts.PASS} live check(s) passed, ${report.counts.SKIP} skipped`,
		checks: report.counts,
	};
}

/** Where one provider family's io gets repointed. */
export type RepointTarget = {
	/**
	 * Separate credentials per DIRECTION, because they are separate rows.
	 *
	 * The first version used the output credential for input io too, on the reasoning that "one
	 * credential id can only be one row". That was a shortcut, not a reason: `verify-akamai-input`
	 * and `verify-akamai-output` are two registered credentials with their own key pairs, and
	 * handing Bitmovin the output pair to READ the input bucket is not what an operator would
	 * configure. Whether it is the cause of the 404 is unproven — but shipping a knowingly wrong
	 * pairing while investigating that 404 makes the investigation worthless.
	 */
	inputCredentialId: string;
	outputCredentialId: string;
	inputBucket: string;
	outputBucket: string;
};

/**
 * What a DRY RUN counts as "this plan produces something" (E2E 2026-08-14,
 * I-05): delivery muxings + manifests + QC mirrors. The mirrors term exists
 * because a `qc.only` plan legitimately compiles to zero of the first two —
 * counting only those misjudged vmaf-only-h264 as "NO expected artefacts".
 */
export function dryRunArtefactCount(expected: ExpectedArtefacts): number {
	return (
		expected.muxings.length +
		expected.manifests.length +
		(expected.qc?.mirrorRenditionKeys.length ?? 0)
	);
}

/**
 * Customer use-case number for a verification scenario. The colocated data
 * file is an executable runner input, not documentation. Its numbers are
 * stable run labels; add a mapping for each new scenario rather than
 * renumbering existing ones. Missing file or unmapped scenario → "uc00" — a
 * VISIBLE unmapped marker, never a throw (naming must not fail a run).
 */
let ucMapCache: Record<string, number> | undefined;
function ucNameFor(scenario: string): string {
	if (ucMapCache === undefined) {
		try {
			ucMapCache = JSON.parse(
				readFileSync(
					join(import.meta.dirname, "data/fixture-to-uc.json"),
					"utf8",
				),
			) as Record<string, number>;
		} catch {
			ucMapCache = {};
		}
	}
	const no = ucMapCache[scenario];
	return `uc${String(no ?? 0).padStart(2, "0")}-${scenario}`;
}

export function rewriteForRun(
	plan: EncodingPlan,
	options: {
		credentialId: string;
		inputBucket: string;
		outputBucket: string;
		sourceObject: string;
		prefix: string;
		bitmovinAccountId?: string;
		/**
		 * The GenericS3 family's target, when one is registered.
		 *
		 * Absent means "no Akamai/OCI credential" — the io then stays as authored and the
		 * capability gate reports it, which is the honest outcome.
		 */
		genericS3?: RepointTarget;
		/** The source object in the GenericS3 input bucket, when the plan reads from one. */
		genericS3SourceObject?: string;
		/** UC-numbered job name (uc{NN}-{scenario}); overrides the fixture name. */
		jobName?: string;
		/**
		 * The GCS family's target, when a `verify-gcs-*` credential is registered.
		 *
		 *  harness follow-up (found by the 2026-08-23 billed run):
		 * multi-output-s3-gcs's GCS MIRROR output kept the
		 * fixture's placeholder credential and failed its real run with `Storage credential no
		 * longer exists` — the exact "product-shaped message for a harness omission" this file's
		 * GenericS3 comment PREDICTED would hit GCS. Absent means no GCS credential is registered,
		 * and the GCS io then stays as authored and is gated by its capability.
		 */
		gcs?: RepointTarget;
		/**
		 * Declared asset path → the key that actually exists, or `undefined`.
		 *
		 * Injected rather than looked up here, so this function stays pure and testable; the runner
		 * builds it from ONE recursive listing of the input bucket.
		 */
		resolveAsset?: (declaredPath: string) => string | undefined;
		/**
		 * Override `qc.model` on any plan that measures VMAF.
		 *
		 * The corpus's one VMAF fixture OMITS `qc.model`, so it takes the schema
		 * default — now `vmaf_v1.0.16_3d0h`, a file-only VMAF v1 model (ledger
		 * #104). The un-overridden run therefore exercises `model=path=`, and
		 * this override's remaining use is the opposite one: pinning a BUILT-IN
		 * (`--vmaf-model vmaf_v0.6.1`) to reach `model=version=` without forking
		 * a fixture. review-234 I3 caught this comment still claiming the
		 * reverse — the sentence stopped being true in the same commit that
		 * changed the default, today, not months ago.
		 */
		vmafModel?: string;
	},
): EncodingPlan {
	const next = structuredClone(plan) as unknown as Record<string, unknown>;

	// Only when the plan already measures VMAF: adding `qc` to a plan that has
	// none would change what the scenario verifies.
	if (options.vmafModel) {
		const qc = next.qc as Record<string, unknown> | undefined;
		if (qc && qc.vmaf === true) {
			qc.model = options.vmafModel;
		}
	}

	/**
	 * S3-KIND ONLY. Repointing everything at the S3 credential broke C10.
	 *
	 * `generic-s3-akamai-io` failed its real run with `step "input:main" needs an
	 * Akamai/OCI/GenericS3 credential but got provider "AWS_S3"` — because this loop
	 * overwrote its GenericS3 credential with the S3 one. The same would happen to the GCS
	 * and Azure scenarios the moment their capabilities are satisfied, so the fix is not
	 * "special-case Akamai": a rewrite may only repoint a credential at one of the SAME
	 * provider family. Anything else stays as authored and is gated by its capability.
	 *
	 * Found by the first real corpus run. No fixture test could: every runner test asserts
	 * the credential WAS replaced, which is exactly the wrong assertion for these kinds.
	 */
	/**
	 * One repoint target per PROVIDER FAMILY, because a family with no target must stay as
	 * authored.
	 *
	 * The S3-only rule above fixed a real C10 violation but left the other half undone:
	 * `generic-s3-akamai-io` kept the fixture's PLACEHOLDER credential id and failed its next
	 * real run with `Storage credential no longer exists` — another product-shaped message for a
	 * harness omission. The Akamai credentials were registered the whole time
	 * (`verify-akamai-input (…)` / `verify-akamai-output (…)`); nothing pointed the scenario at
	 * them.
	 *
	 * Akamai Object Storage IS GenericS3 with V4 signing (C10), so GENERIC_S3 io repoints to an
	 * `AKAMAI_OBJECT_STORAGE` credential and its own buckets — never to the S3 ones, which is
	 * the mistake that started this.
	 */
	const family = (kind: string): RepointTarget | undefined => {
		if (kind === "S3" || kind === "S3_ROLE") {
			// One S3 credential covers both directions for this harness; the shape still carries
			// them separately so no family is special-cased.
			return {
				inputCredentialId: options.credentialId,
				outputCredentialId: options.credentialId,
				inputBucket: options.inputBucket,
				outputBucket: options.outputBucket,
			};
		}
		if (kind === "GENERIC_S3") {
			return options.genericS3;
		}
		if (kind === "GCS") {
			return options.gcs;
		}
		return undefined;
	};
	const repoint = (
		io: { kind: string; [k: string]: unknown },
		which: "inputBucket" | "outputBucket",
	): void => {
		const target = family(io.kind);
		const credentialFor =
			which === "inputBucket" ? "inputCredentialId" : "outputCredentialId";
		if (!target) {
			// No registered credential of this family: leave it exactly as authored, so the
			// capability gate is what reports it rather than a confusing runtime error.
			return;
		}
		if ("credentialId" in io) {
			io.credentialId = target[credentialFor];
		}
		if ("bucket" in io) {
			io.bucket = target[which];
		}
		if ("container" in io) {
			io.container = target[which];
		}
	};
	for (const input of next.inputs as { kind: string; [k: string]: unknown }[]) {
		repoint(input, "inputBucket");
	}
	for (const output of next.outputs as {
		kind: string;
		[k: string]: unknown;
	}[]) {
		repoint(output, "outputBucket");
	}

	/**
	 * Every source object becomes the one asset we know the shape of — and this now REFUSES
	 * rather than trusting that preflight got there first.
	 *
	 * The previous version of this comment said a scenario needing distinct sources "is gated
	 * by preflight, so it never reaches here with the wrong asset". That was a promise, not a
	 * mechanism, and it was false: preflight matched only literal placeholder spellings, so
	 * REAL-VOD-4 collapsed five Dolby masters and two WebVTT sidecars into an H.264 `.mov`,
	 * billed for seven encodings that could not succeed, and reported each as a product FAIL.
	 *
	 * A gate somewhere else cannot be relied on by the code that depends on it. So the
	 * substitution that is unsound is refused HERE, where it would happen — an exception costs
	 * one INVALID row, and the alternative costs encoder minutes and a wrong verdict.
	 */
	/**
	 * Which source object THIS plan reads, chosen by the provider it reads FROM.
	 *
	 * Each provider's input bucket holds its own mezzanine; one global object was a wrong model
	 * that cost a whole round of misdiagnosis. Falls back to the S3 object when no GenericS3
	 * source is configured, so an install with only S3 behaves exactly as before.
	 */
	const readsGenericS3 = (next.inputs as { kind: string }[]).some(
		(io) => io.kind === "GENERIC_S3",
	);
	const sourceObjectForRun =
		readsGenericS3 && options.genericS3SourceObject
			? options.genericS3SourceObject
			: options.sourceObject;

	const fileStreams = (next.fileStreams ?? []) as {
		key?: string;
		fileType?: string;
	}[];
	/**
	 * A typed source is RESOLVED to its real asset when one exists, and refused otherwise.
	 *
	 * The refusal was right — pointing a WEBVTT stream at an H.264 `.mov` submits an encoding that
	 * cannot succeed — but it was the whole answer, and it should not have been. The fixtures
	 * declare real paths and the bucket has them one prefix down, so the honest first move is to
	 * LOOK. `resolveAsset` returns the key that exists, or `undefined`, and only then does the
	 * refusal stand.
	 */
	for (const stream of fileStreams.filter(
		(x) => typeof x.fileType === "string",
	)) {
		const declared = (stream as { inputPath?: unknown }).inputPath;
		const resolved =
			typeof declared === "string"
				? options.resolveAsset?.(declared)
				: undefined;
		if (!resolved) {
			throw new Error(
				`refusing to rewrite: fileStream "${stream.key}" declares fileType ${stream.fileType} and no asset for "${typeof declared === "string" ? declared : "(no path)"}" is in the input bucket — pointing it at ${options.sourceObject} would submit an encoding that cannot succeed (needs TYPED_SOURCE_ASSETS)`,
			);
		}
		(stream as { inputPath?: unknown }).inputPath = resolved;
	}
	const dolbyStreams = (next.dolbyStreams ?? []) as unknown[];
	if (dolbyStreams.length > 0) {
		throw new Error(
			`refusing to rewrite: the plan has ${dolbyStreams.length} dolbyStream(s), whose masters and sidecars ${options.sourceObject} cannot stand in for — this scenario needs DOLBY_ASSETS`,
		);
	}
	for (const key of ["ingest", "fileStreams", "dolbyStreams"] as const) {
		for (const stream of (next[key] ?? []) as Record<string, unknown>[]) {
			// A typed stream was resolved above to a real asset; collapsing it now would undo that
			// and hand the encoder the mezzanine again.
			if (typeof stream.fileType === "string") {
				continue;
			}
			// All THREE source fields. A review found `sourcesOf` was reading only
			// `inputPath`, and fixing that immediately exposed this: the rewrite left
			// `videoInputPath` and `metadataInputPath` pointing at the original DV
			// mezzanine and metadata sidecar, so a Dolby scenario would have been
			// submitted still reading `<REDACTED_DV_MEZZANINE>.mxf` from a bucket the run
			// never staged — the "verify the wrong place" hazard this function's own doc
			// comment warns about, caught by a corpus-wide assertion rather than by luck.
			for (const field of [
				"inputPath",
				"videoInputPath",
				"metadataInputPath",
			] as const) {
				if (typeof stream[field] === "string") {
					stream[field] = sourceObjectForRun;
				}
			}
		}
	}

	if (options.bitmovinAccountId) {
		const bitmovin = next.bitmovin as Record<string, unknown>;
		bitmovin.accountId = options.bitmovinAccountId;
	}
	// Test-job naming (owner item 3, 2026-08-23): fixture display names were
	// mixed-case and inconsistent in the Bitmovin console. The caller passes
	// the UC-numbered form (uc{NN}-{scenario}, lowercase, from the use-case
	// table's fixture map); absent (unit tests, unmapped) falls back to the
	// fixture name so nothing breaks silently.
	next.name = `${options.jobName ?? plan.name} [verify ${options.prefix.split("/")[1] ?? ""}]`;
	// Destinations move under the run namespace, keeping their internal structure so
	// per-rendition folders, {uuid}/{bitrate} placeholders and qc/ suffixes survive.
	// Expressed over the shared structural walk (review-284 N1): the hand-listed
	// five-array loop this replaces was blind to any destination site off its list.
	return encodingPlanSchema.parse(
		mapDestinationPaths(
			next,
			(path) => `${options.prefix}${path.replace(/^\/+/, "")}`,
		),
	);
}

export type RewriteOptions = Parameters<typeof rewriteForRun>[1];

/**
 * What a scenario's verdict is a verdict OF — independent of the run that
 * produced it .
 *
 * The real rewrite embeds the run id twice: in the job name and in every
 * destination path (`verify/<runId>/<scenario>/…`). A run never reuses an id,
 * so a digest of the real rewrite could never equal a prior run's, and
 * `--resume-from` — whose whole purpose is to not re-spend on an unchanged
 * scenario — honoured nothing. This digest is taken over the SAME rewrite
 * (credentials, buckets, source, repoints, VMAF model, asset resolution) under
 * a placeholder run id, so it changes when anything that changes the encoding
 * changes, and only then.
 */
export function planIdentitySha256(
	plan: EncodingPlan,
	options: RewriteOptions,
	scenario: string,
): string {
	const canonical = rewriteForRun(plan, {
		...options,
		prefix: `verify/RUN/${scenario}/`,
	});
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * The authenticated JSON client the live runner drives the product with. A
 * body that does not parse is `json: null`, never a throw — the create path
 * reads "2xx with no id" as an AMBIGUOUS create (EV-01). Module-level so the
 * run-level intent teardown can stop an adopted channel with the same client.
 */
export function liveApiFor(
	config: Pick<RunnerConfig, "baseUrl" | "apiToken">,
	session: string | undefined,
) {
	return async (path: string, init?: { method?: string; body?: unknown }) => {
		const res = await fetch(`${config.baseUrl}${path}`, {
			method: init?.method ?? "GET",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				...authHeaders(config, session),
			},
			...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		});
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		return { status: res.status, json };
	};
}

/**
 * EV-01: the intent ledger of the run a `RunnerConfig` belongs to, installed
 * by `runVerificationRecorded` and read by `runLive`. See the note there for
 * why it is not a parameter.
 */
const intentLedgerFor = new WeakMap<RunnerConfig, IntentLedger>();
const responseLossCanaryFor = new WeakMap<
	RunnerConfig,
	PostCreateResponseLossCanaryState
>();

/** The request the VOD spend site sends — the key rides with the plan. */
export type SubmitBody = {
	name: string;
	plan: EncodingPlan;
	verificationKey: string;
	requestSha256: string;
	verificationDispatch: VerificationDispatchFence;
};

/**
 * What one submit attempt established about the paid job
. The old `submit` THREW on a lost or unreadable
 * response, and the catch saw `!jobId` and returned INVALID with no cleanup —
 * the job was billing and nothing named it. Now every failure says WHERE it
 * happened relative to the wire, so the caller can tell "nothing was created"
 * from "something may have been":
 *
 * BEFORE_SEND — the request provably never left (`classifySendFailure`).
 * REFUSED — the product answered a definitive 4xx (not 409): not created.
 * AMBIGUOUS — a lost response, an unparseable body, a body with no id, a
 * 5xx (the route marks the row ERROR after an enqueue failure
 * and rethrows — the row EXISTS), or a 409 (a job with this
 * key exists). The job may exist and must be LOOKED UP.
 */
export type SubmitResult =
	| { ok: true; jobId: string; replayed: boolean }
	| {
			ok: false;
			phase: "BEFORE_SEND" | "REFUSED" | "AMBIGUOUS";
			error: string;
			httpStatus?: number;
			errorCode?: string;
	  };

export async function submit(
	config: Pick<RunnerConfig, "baseUrl" | "apiToken">,
	session: string | undefined,
	body: SubmitBody,
	fetchImpl: typeof fetch = fetch,
): Promise<SubmitResult> {
	let res: Response;
	try {
		res = await fetchImpl(`${config.baseUrl}/api/encoding-jobs`, {
			method: "POST",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				...authHeaders(config, session),
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		return {
			ok: false,
			phase: classifySendFailure(err),
			error: `submit threw: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	let text: string;
	try {
		text = await res.text();
	} catch (err) {
		return {
			ok: false,
			phase: "AMBIGUOUS",
			error: `submit response body could not be read (HTTP ${res.status}): ${err instanceof Error ? err.message : String(err)}`,
			httpStatus: res.status,
		};
	}
	if (!res.ok) {
		let errorCode: string | undefined;
		try {
			errorCode = verificationCreateErrorCode(JSON.parse(text));
		} catch {
			// An unreadable or foreign response cannot prove no create occurred.
		}
		// A different-SHA conflict proves that this key already names a local
		// resource. It proves this POST did not create a new row, but it does NOT
		// prove that the paid key's existing resource is terminal or cleaned. Keep
		// the intent AMBIGUOUS so the caller runs exact-key lookup/cleanup instead
		// of closing it NEVER_CREATED. The remaining bounded route codes reject
		// before a paid row can be created and are definitive refusals.
		const definitive =
			errorCode !== undefined && errorCode !== VERIFICATION_KEY_SHA_CONFLICT;
		return {
			ok: false,
			phase: definitive ? "REFUSED" : "AMBIGUOUS",
			error: `submit failed (${res.status}): ${text.slice(0, 300)}`,
			httpStatus: res.status,
			...(errorCode ? { errorCode } : {}),
		};
	}
	let parsed: { id?: unknown; replayed?: unknown };
	try {
		parsed = JSON.parse(text) as { id?: unknown; replayed?: unknown };
	} catch {
		return {
			ok: false,
			phase: "AMBIGUOUS",
			error: `submit returned an unparseable body (HTTP ${res.status}): ${text.slice(0, 200)}`,
			httpStatus: res.status,
		};
	}
	if (typeof parsed?.id !== "string" || parsed.id.length === 0) {
		return {
			ok: false,
			phase: "AMBIGUOUS",
			error: `submit returned no job id (HTTP ${res.status}): ${text.slice(0, 200)}`,
			httpStatus: res.status,
		};
	}
	return { ok: true, jobId: parsed.id, replayed: parsed.replayed === true };
}

/**
 * The key, as a label on the plan — so the local row's `labels` column and
 * the provider encoding's statistics labels (the compiler's CREATE_ENCODING
 * payload) both carry it, and a lookup that has no key column to read can
 * still find the job by its marker.
 */
export function withVerificationLabel(
	plan: EncodingPlan,
	verificationKey: string,
): EncodingPlan {
	const label = verificationKeyLabel(verificationKey);
	const labels = plan.bitmovin.labels ?? [];
	return {
		...plan,
		bitmovin: {
			...plan.bitmovin,
			labels: labels.includes(label) ? labels : [...labels, label],
		},
	};
}

/**
 * Poll the job row until it leaves QUEUED/RUNNING, or the budget runs out.
 *
 * Exported, with `pollMs` and `now` as parameters, purely so this is testable: the real 10s
 * interval would make a test of the two timeout arms take minutes, and a test that measured
 * real elapsed time against a millisecond budget would be flaky by construction — my first
 * attempt was, and it failed on its own arithmetic rather than on the code. Both arms shipped
 * a defect that a real corpus run had to find, which is the argument for a fast test.
 */
export async function awaitTerminal(
	config: RunnerConfig,
	jobId: string,
	pollMs = 10_000,
	now: () => number = Date.now,
): Promise<{
	status: string;
	error: string | null;
	encodingId: string | null;
}> {
	let deadline = now() + config.perScenarioTimeoutMs;
	/**
	 * A separate, much larger budget for "the queue never served this job".
	 *
	 * Four times the per-scenario budget: long enough that a genuinely busy queue drains, short
	 * enough that a stopped worker does not hang a corpus run overnight.
	 */
	const queueBudgetMs = config.perScenarioTimeoutMs * 4;
	const queueDeadline = now() + queueBudgetMs;
	for (;;) {
		const row = await config.prisma.encodingJob.findUnique({
			where: { id: jobId },
			select: {
				status: true,
				error: true,
				bitmovinEncodingId: true,
				doneSteps: true,
				totalSteps: true,
			},
		});
		if (!row) {
			throw new Error(`job ${jobId} disappeared while we waited for it`);
		}
		// AWAITING_QC is a PARK, not an end : a gate plan sits there
		// until the measurement's continuation flips it to FINISHED or QC_FAILED.
		// Returning on it read a correctly gated job as "job AWAITING_QC" → FAIL.
		if (
			row.status !== "QUEUED" &&
			row.status !== "RUNNING" &&
			row.status !== "AWAITING_QC"
		) {
			return {
				status: String(row.status),
				error: row.error,
				encodingId: row.bitmovinEncodingId,
			};
		}
		/**
		 * The budget starts when the WORKER starts, not when we submitted.
		 *
		 * A real corpus run reported 6 scenarios INVALID at `step 0/N (status QUEUED)` — jobs
		 * the worker had never picked up, timed out for waiting in a queue. That is not a
		 * scenario taking too long; it is a scenario that has not begun, and charging it for
		 * queue time makes the harness report a product it never exercised.
		 *
		 * So the clock is reset while nothing has been done, and a job that stays QUEUED past a
		 * generous multiple of the budget is reported as exactly that — a queue that never
		 * served it — rather than as a slow encoding.
		 */
		if (row.doneSteps === 0 && row.status === "QUEUED") {
			if (now() > queueDeadline) {
				throw new Error(
					`still QUEUED after ${Math.round(queueBudgetMs / 1000)}s and step 0/${row.totalSteps}: the orchestrator never picked this job up, so nothing about the product was exercised (check ORCHESTRATOR_CONCURRENCY)`,
				);
			}
			deadline = now() + config.perScenarioTimeoutMs;
		} else if (now() > deadline) {
			throw new Error(
				`timed out after ${Math.round(config.perScenarioTimeoutMs / 1000)}s at step ${row.doneSteps}/${row.totalSteps} (status ${row.status})`,
			);
		}
		await new Promise((done) => setTimeout(done, pollMs));
	}
}

/**
 * Poll the AUTO VmafJob for a finished encoding until it is terminal, absent for good,
 * or out of budget .
 *
 * The encoding's FINISHED write precedes the trigger, so a plan with `qc.vmaf` and no
 * gate hands `verifyJob` a row that is PENDING or RUNNING — and a verifier that reads it
 * then reports on a measurement that has not happened. This waits, then lets `verifyJob`
 * read the row and say what it found: it NEVER throws on the product's account. A row
 * that is still absent after `absentGraceMs` is one that is not coming (the trigger is
 * synchronous in the FINISHED tail), and a run past the scenario budget is a slow
 * measurement — both are `qc:measurement` FAILs for the report, not harness INVALIDs.
 */
export async function awaitVmafTerminal(
	config: RunnerConfig,
	jobId: string,
	pollMs = 10_000,
	now: () => number = Date.now,
	absentGraceMs = 120_000,
): Promise<{
	status: "FINISHED" | "ERROR" | "ABSENT" | "TIMEOUT";
	polls: number;
}> {
	const deadline = now() + config.perScenarioTimeoutMs;
	const absentDeadline = now() + absentGraceMs;
	let polls = 0;
	for (;;) {
		const row = await config.prisma.vmafJob.findFirst({
			where: { encodingJobId: jobId, triggerKey: autoTriggerKey(jobId) },
			select: { status: true },
		});
		polls += 1;
		if (!row) {
			if (now() > absentDeadline) {
				return { status: "ABSENT", polls };
			}
		} else if (row.status === "FINISHED" || row.status === "ERROR") {
			return { status: row.status, polls };
		} else if (now() > deadline) {
			return { status: "TIMEOUT", polls };
		}
		await new Promise((done) => setTimeout(done, pollMs));
	}
}

/** Run `items` with at most `limit` in flight; order of results follows input. */

/**
 *  I-03 — the circuit breaker. One harness-fault or start-5xx
 * outcome means every FURTHER submission would spend encoder minutes on an
 * environment already known broken (the 2026-08-14 E2E burned a corpus
 * learning this). The breaker trips on:
 *  - any INVALID (a harness fault by definition, never a product verdict),
 *  - a FAIL whose reason carries a start 5xx or an unknown outcome.
 * In-flight scenarios finish; queued ones report a named SKIP.
 */
export function breakerTripReason(outcome: {
	verdict: ScenarioVerdict;
	reason: string;
}): string | null {
	if (outcome.verdict === "INVALID") {
		return `INVALID outcome: ${outcome.reason.slice(0, 120)}`;
	}
	if (
		outcome.verdict === "FAIL" &&
		/start failed \(5\d\d\)|unknown outcome/i.test(outcome.reason)
	) {
		return `start-5xx/unknown outcome: ${outcome.reason.slice(0, 120)}`;
	}
	return null;
}

/**
 * Prior PASSes from a resume report — scenario name → runId it passed in.
 *
 * No longer what the runner honours (: `resumeEligibility` compares
 * fingerprint, plan, source and account before a PASS stands in); kept as the
 * plain reader some tooling imports.
 */
export function loadResumePasses(reportJson: string): Map<string, string> {
	const parsed = JSON.parse(reportJson) as {
		runId?: string;
		outcomes?: { scenario: string; verdict: string }[];
	};
	const passes = new Map<string, string>();
	for (const o of parsed.outcomes ?? []) {
		if (o.verdict === "PASS") {
			passes.set(o.scenario, parsed.runId ?? "prior run");
		}
	}
	return passes;
}

async function pooled<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const runners = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			for (;;) {
				const index = next++;
				if (index >= items.length) {
					return;
				}
				results[index] = await worker(items[index] as T, index);
			}
		},
	);
	await Promise.all(runners);
	return results;
}

/**
 * The durable-evidence wrapper (re-audit HIGH-7 / GO 11).
 *
 * A run that throws past its reservation must leave a row saying so: RUNNING
 * would be indistinguishable from a process still working. `failed` is a
 * no-op when the reservation itself was refused — that row belongs to another
 * host's run, and marking it INCOMPLETE would be this process vandalising
 * someone else's evidence.
 */
export async function runVerification(
	config: RunnerConfig,
): Promise<RunReport> {
	const recorder = createRunRecorder(prismaRunRecordStore(config.prisma), {
		...(config.log ? { log: config.log } : {}),
	});
	try {
		return await runVerificationRecorded(config, recorder);
	} catch (err) {
		await recorder.failed(err);
		throw err;
	}
}

export type VerificationRecoveryResult = {
	runId: string;
	sealable: boolean;
	/** True only when DB state durably prevents the original producer sealing. */
	authorityFenced: boolean;
	/** Canonical report export repair, when the final row remains SEALED. */
	reportExports: "NOT_APPLICABLE" | "RESTORED" | "FAILED";
	unresolvedKeys: string[];
	lines: string[];
	dossier: IntentRow[];
};

export type VerificationRecoveryConfig = Pick<
	RunnerConfig,
	| "prisma"
	| "baseUrl"
	| "password"
	| "apiToken"
	| "log"
	| "releaseMode"
	| "sealKeyring"
> & {
	/** Lazy so a malformed seal env cannot block teardown of billable resources. */
	loadSealKeyring?: () => ReturnType<typeof sealKeyringFromEnv>;
};

class VerificationDispatchInFlightError extends Error {
	constructor(readonly verificationKeys: string[]) {
		super("paid-resource dispatch is still in flight");
		this.name = "VerificationDispatchInFlightError";
	}
}

/**
 * Restart entrypoint for a run whose original process died.
 *
 * It never reserves a new run id and never submits a create. It loads the old
 * VerificationRun/intent population from the database, leases each open intent
 * with a generation fence, and runs only stop/readback reconciliation. The
 * original product verdict is never promoted to SEALED by recovery: cleanup can
 * make the resource safe, but it cannot recreate observations the dead process
 * never wrote.
 */
export async function recoverVerificationRun(
	config: VerificationRecoveryConfig,
	targetRunId: string,
	options: {
		owner?: string;
		leaseMs?: number;
		now?: () => number;
		/** Test/operations injection; production derives exact product resolvers. */
		resolvers?: IntentResolvers;
		/** Deterministic filesystem-failure seam for export-repair tests. */
		publishFile?: (pending: string, published: string) => Promise<void>;
	} = {},
): Promise<VerificationRecoveryResult> {
	const validatedRunId = validateRunId(targetRunId);
	const evidenceStore = prismaResumeEvidenceStore(config.prisma);
	const run = await evidenceStore.findByRunId(validatedRunId);
	if (!run) throw new Error(`verification run ${targetRunId} does not exist`);
	const intentStore = prismaIntentStore(config.prisma);
	const before = await intentStore.listForRun(run.id);
	const hadOpen = !verificationIntentsSealable(before).sealable;
	const at = new Date((options.now ?? Date.now)());
	let dispatchInFlight = false;
	let deferredDossier = before;
	let demoted = hadOpen || run.status !== "SEALED";
	const recoveryOwner = `verify-recover:${validatedRunId}:${options.owner ?? randomUUID()}`;
	const recoveryLeaseMs = options.leaseMs ?? 15 * 60 * 1000;
	const recoveryLeaseUntil = new Date(at.getTime() + recoveryLeaseMs);
	const fenceLines: string[] = [];
	let concurrentExactSeal = false;
	const claimRunRecoveryFence = async (input: {
		error: string;
		holdLease: boolean;
	}): Promise<"CLAIMED" | "LOST" | "DISPATCH_IN_FLIGHT"> => {
		try {
			return await config.prisma.$transaction(async (tx) => {
				// This tentative parent update is the lock. A producer's SUBMITTED
				// transaction locks the same parent before touching its child intent.
				// If an active child is found below, throwing rolls this update back.
				const claimed = await tx.verificationRun.updateMany({
					where: {
						id: run.id,
						status: run.status,
						recoveryGeneration: run.recoveryGeneration,
						OR: [
							{ recoveryOwner },
							{ recoveryOwner: null },
							{ recoveryLeaseUntil: null },
							{ recoveryLeaseUntil: { lte: at } },
						],
					},
					data: {
						status: "INCOMPLETE",
						finishedAt: at,
						error: recordableError(input.error),
						recoveryOwner: input.holdLease ? recoveryOwner : null,
						recoveryLeaseUntil: input.holdLease ? recoveryLeaseUntil : null,
						recoveryGeneration: { increment: 1 },
					},
				});
				if (claimed.count !== 1) return "LOST" as const;
				const active = await tx.verificationResourceIntent.findMany({
					where: {
						verificationRunId: run.id,
						state: "SUBMITTED",
						recoveryOwner: { startsWith: "verify-dispatch:" },
						recoveryLeaseUntil: { gt: at },
					},
					orderBy: [{ createdAt: "asc" }, { id: "asc" }],
					select: { verificationKey: true },
				});
				if (active.length > 0) {
					throw new VerificationDispatchInFlightError(
						active.map((row) => row.verificationKey),
					);
				}
				return "CLAIMED" as const;
			});
		} catch (err) {
			if (err instanceof VerificationDispatchInFlightError) {
				fenceLines.push(
					`recovery deferred: ${err.verificationKeys.length} paid-resource dispatch lease(s) remain live (${err.verificationKeys.join(", ")})`,
				);
				return "DISPATCH_IN_FLIGHT";
			}
			throw err;
		}
	};
	if (demoted) {
		// Authority must fall before teardown mutates the last open intent. Otherwise
		// a concurrent recovery can observe zero open intents plus stale SEALED and
		// republish a report that no longer represents the run's resource ledger.
		try {
			const claim = await claimRunRecoveryFence({
				error:
					"EV-01 restart recovery began with incomplete paid-resource evidence",
				holdLease: true,
			});
			if (claim === "DISPATCH_IN_FLIGHT") {
				dispatchInFlight = true;
				demoted = false;
				deferredDossier = await intentStore.listForRun(run.id);
			} else if (claim === "LOST") {
				const [refreshedRun, refreshedIntents] = await Promise.all([
					evidenceStore.findByRunId(validatedRunId),
					intentStore.listForRun(run.id),
				]);
				concurrentExactSeal =
					refreshedRun?.status === "SEALED" &&
					verificationIntentsSealable(refreshedIntents).sealable;
				fenceLines.push(
					concurrentExactSeal
						? "run recovery claim lost to a concurrent SEALED producer; exact authority will be revalidated and preserved"
						: "run recovery fence is held by another generation; paid-resource teardown still attempted",
				);
			}
		} catch (err) {
			const detail = recordableError(err);
			fenceLines.push(
				`initial run recovery fence write failed (${detail}); paid-resource teardown continued`,
			);
			config.log?.(`[verify] ${fenceLines.at(-1) as string}`);
		}
	}
	const session =
		dispatchInFlight || options.resolvers ? undefined : await signIn(config);
	const resolvers: IntentResolvers =
		options.resolvers ??
		({
			VOD_JOB: async (row) => {
				const cleanup = await ensureTerminal({
					...vodCleanupDeps(config, session, row.localId),
					budgetMs: ABANDON_CLEANUP_BUDGET_MS,
				});
				const resources = vodIntentResourceSets(
					row.localId,
					cleanup.provider,
					cleanup.localTerminal,
				);
				return {
					terminal: cleanup.terminal && cleanup.providerTerminal === true,
					readback: { jobId: row.localId, recovery: true, ...cleanup },
					providerId: cleanup.provider?.[0]?.encodingId ?? null,
					...resources,
					...(cleanup.terminal && cleanup.providerTerminal === true
						? {}
						: {
								error: `job ${row.localId}: local ${cleanup.status}, provider ${providerWord(cleanup)}`,
							}),
				};
			},
			LIVE_CHANNEL: async (row) => {
				const closure = await resolveLiveVerificationIntent(
					config,
					liveApiFor(config, session),
					row.localId,
					{
						now: options.now ?? Date.now,
						sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
						...(config.log ? { log: config.log } : {}),
					},
				);
				return {
					...closure,
					readback: {
						recovery: true,
						...(closure.readback as Record<string, unknown>),
					},
				};
			},
		} satisfies IntentResolvers);
	const ledger = createIntentLedger(intentStore, {
		verificationRunId: run.id,
		recoveryOwner,
		recoveryLeaseMs: options.leaseMs,
		now: options.now,
		...(config.log ? { log: config.log } : {}),
	});
	const teardown = dispatchInFlight
		? {
				sealable: false,
				unresolved: redactIntentDossier(
					verificationIntentsSealable(deferredDossier).unresolved,
				),
				lines: [] as string[],
				dossier: redactIntentDossier(deferredDossier),
			}
		: await ledger.teardown(resolvers);
	const summary = teardown.sealable
		? `EV-01 restart recovery closed ${teardown.dossier.length} intent(s); the original run remains INCOMPLETE and is not release evidence`
		: `EV-01 restart recovery left ${teardown.unresolved.length} unresolved intent(s): ${teardown.unresolved.map((row) => row.verificationKey).join(", ")}`;
	let authorityFenced = !demoted && !dispatchInFlight;
	if (demoted) {
		// This CAS also recovers a response-lost initial claim: the owner and
		// incremented generation prove that the write landed despite its error.
		for (let attempt = 1; attempt <= 2 && !authorityFenced; attempt += 1) {
			try {
				const owned = await config.prisma.verificationRun.updateMany({
					where: {
						id: run.id,
						recoveryGeneration: run.recoveryGeneration + 1,
						recoveryOwner,
					},
					data: {
						status: "INCOMPLETE",
						finishedAt: at,
						error: recordableError(summary),
						recoveryOwner: null,
						recoveryLeaseUntil: null,
					},
				});
				authorityFenced = owned.count === 1;
				// A clean zero proves this owner never held the incremented generation;
				// retrying the same predicate cannot change that.
				if (owned.count === 0) break;
			} catch (err) {
				fenceLines.push(
					`owned run recovery fence finalize failed (attempt ${attempt} of 2: ${recordableError(err)})`,
				);
			}
		}
		if (!authorityFenced) {
			try {
				// The initial write did not land. Claim and close generation atomically
				// after teardown; this turns a transient pre-teardown DB failure into a
				// durable non-SEALED authority without ever skipping paid cleanup.
				const retried = await claimRunRecoveryFence({
					error: summary,
					holdLease: false,
				});
				authorityFenced = retried === "CLAIMED";
				if (retried === "DISPATCH_IN_FLIGHT") dispatchInFlight = true;
			} catch (err) {
				fenceLines.push(
					`final run recovery fence write failed (${recordableError(err)}); DB authority must be treated as unsafe`,
				);
			}
		}
	}
	const lines = [...fenceLines, ...teardown.lines];
	// Re-read after any demotion. The initial `run` object is deliberately not
	// trusted here: using its stale SEALED status was the false-green window.
	const finalRun = await evidenceStore.findByRunId(validatedRunId);
	if (!finalRun) {
		throw new Error(
			`verification run ${targetRunId} disappeared during recovery`,
		);
	}
	if (
		demoted &&
		finalRun.status !== "SEALED" &&
		finalRun.recoveryGeneration > run.recoveryGeneration
	) {
		authorityFenced = true;
	}
	let reportExports: VerificationRecoveryResult["reportExports"] =
		"NOT_APPLICABLE";
	if (
		(!hadOpen || concurrentExactSeal) &&
		teardown.sealable &&
		finalRun.status === "SEALED"
	) {
		const authority = validateSealedReportAuthority({
			runId: validatedRunId,
			releaseMode: config.releaseMode === true,
			keyring:
				config.sealKeyring ??
				config.loadSealKeyring?.() ??
				sealKeyringFromEnv(process.env),
			row: finalRun,
			now: () => at,
		});
		if (!authority.ok) {
			throw new Error(
				`SEALED report authority is invalid (${authority.code}): ${authority.reason}`,
			);
		}
		if (concurrentExactSeal) authorityFenced = true;
		const restored = await restoreSealedRunReportExports({
			runDir: dirname(finalRun.reportPath),
			reportJson: finalRun.reportJson as string,
			reportMarkdown: finalRun.reportMarkdown as string,
			seal: finalRun.seal as string,
			...(options.publishFile ? { publishFile: options.publishFile } : {}),
		});
		reportExports = restored.exported ? "RESTORED" : "FAILED";
		lines.push(
			restored.exported
				? "self-contained SEALED report exports restored from DB authority"
				: `SEALED DB authority is intact, but report export repair failed: ${restored.error ?? "unknown filesystem failure"}`,
		);
	}
	const recoveryEvidence = {
		runId: targetRunId,
		recoveredAt: at.toISOString(),
		sealable: teardown.sealable,
		authorityFenced,
		reportExports,
		lines,
		resourceIntents: teardown.dossier,
	};
	await writeFile(
		join(dirname(run.reportPath), "resource-intent-recovery.json"),
		`${JSON.stringify(recoveryEvidence, null, "\t")}\n`,
	).catch((err) => {
		config.log?.(
			`[verify] recovery DB evidence landed, but the local dossier could not be written: ${recordableError(err)}`,
		);
	});
	return {
		runId: targetRunId,
		sealable: teardown.sealable,
		authorityFenced,
		reportExports,
		unresolvedKeys: teardown.unresolved.map((row) => row.verificationKey),
		lines,
		dossier: teardown.dossier,
	};
}

async function runVerificationRecorded(
	config: RunnerConfig,
	recorder: RunRecorder,
): Promise<RunReport> {
	const log = config.log ?? (() => {});
	const startedAt = new Date().toISOString();
	validatePostCreateResponseLossCanary({
		enabled: config.injectPostCreateResponseLoss === true,
		only: config.only,
		maxSubmits: config.maxSubmits,
		dryRun: config.dryRun,
		resumeFrom: config.resumeFrom,
	});
	if (config.injectPostCreateResponseLoss === true) {
		responseLossCanaryFor.set(
			config,
			createPostCreateResponseLossCanary(config.only?.[0] as string),
		);
	}
	// Validated before the run directory, DB reservation, sign-in or any paid
	// submit. A release run without HMAC authority must cost exactly zero.
	const sealKeyring = config.sealKeyring ?? sealKeyringFromEnv(process.env);
	const sealPolicy = evidenceSealPolicy({
		releaseMode: config.releaseMode === true,
		keyring: sealKeyring,
		...(config.evidenceRetentionDays !== undefined
			? { retentionDays: config.evidenceRetentionDays }
			: {}),
	});
	// A run directory is never reused either : a second run under
	// the same id would overwrite this one's report while sharing its prefix.
	await prepareRunDir(config.runDir, {
		exists: existsSync,
		mkdir: (path) => mkdir(path, { recursive: true }),
	});
	/**
	 * The RESERVATION (re-audit GO 4). `prepareRunDir` is one host's disk, and
	 * two hosts sharing a database do not share a filesystem — so the run id is
	 * claimed here, atomically, before preflight and long before anything is
	 * spent. A unique violation refuses the run rather than letting two
	 * processes write into one `verify/<runId>/` prefix.
	 */
	await recorder.reserve({
		runId: config.runId,
		startedAt,
		reportPath: join(config.runDir, "report.json"),
		baseUrl: config.baseUrl,
		...(config.apiToken ? { apiToken: config.apiToken } : {}),
		sourceObject: config.sourceObject,
	});
	/**
	 * EV-01: the durable-intent ledger, a child of
	 * the reservation just made. Every paid create below — the VOD job POST
	 * and the live channel POST — commits an intent row through it BEFORE
	 * sending, and the seal at the end of this function reads the ledger, not
	 * the ids this process happens to hold.
	 */
	const producerFence = recorder.producerFence();
	if (!producerFence) {
		throw new Error(
			"the run reservation returned no row id/generation fence, so no durable intent could be filed — refusing to spend",
		);
	}
	const intents = createIntentLedger(prismaIntentStore(config.prisma), {
		verificationRunId: producerFence.verificationRunId,
		producerRecoveryGeneration: producerFence.recoveryGeneration,
		log,
	});
	intentLedgerFor.set(config, intents);

	const pre = await preflight({ prisma: config.prisma, log });
	const selected = new Set(config.only ?? []);
	/**
	 * Which scenarios this run will actually attempt.
	 *
	 * `kind === "VOD"` was the phase-B filter and it silently defeated the phase-C wiring:
	 * live scenarios never reached the dispatch that was written for them, so they landed in
	 * the `skipped` complement and were reported as `not selected by --only ` — with nothing
	 * after it, the exact dishonest shape design §3 forbids and that this file already fixed
	 * once for VOD. The dry run made it visible immediately, which is the argument for
	 * running the thing rather than reading it.
	 *
	 * Live is included only when the run asked for it, because each scenario costs encoder
	 * minutes; the `runLive` dispatch turns a run without `--live-feed-seconds` into a SKIP
	 * that says so.
	 */
	const wantsLive = config.liveFeedSeconds !== undefined;
	/**
	 * One probe of the staged mezzanine, reused by every scenario.
	 *
	 * Skipped entirely on a dry run, which submits nothing and therefore cannot hand the encoder
	 * an impossible job.
	 */
	const sourceSeconds = config.dryRun
		? undefined
		: await stagedSourceSeconds(config, config.sourceObject);
	/**
	 * The long mezzanine's duration, measured the same way and only when one is configured.
	 *
	 * Measured, not declared: "the long one is 10 minutes" is exactly the kind of assumption this
	 * round has been unwinding, and the gate compares numbers it took itself.
	 */
	const longSeconds =
		config.dryRun || !config.longSourceObject
			? undefined
			: await stagedSourceSeconds(config, config.longSourceObject);
	if (longSeconds !== undefined) {
		log(
			`[verify] long source ${config.longSourceObject} carries ${longSeconds.toFixed(2)}s of VIDEO`,
		);
	}
	/**
	 * The asset resolver, built once — for DRY RUNS TOO (E2E 2026-08-14, I-05).
	 * The empty stand-in this branch used to substitute made preflight and the
	 * dry-run REWRITE disagree about the same facts: preflight read the real
	 * bucket and resolved a typed WebVTT source, the rewrite then rejected the
	 * identical asset as unregistered, and two VTT scenarios reported INVALID
	 * on a harness artifact rather than anything about the plans. One
	 * read-only listing is the price of a single fact source.
	 */
	const assets = await assetResolver(config);
	if (assets.total > 0) {
		log(
			`[verify] ${config.inputBucket} holds ${assets.total} object(s); declared asset paths resolve under "${config.assetPrefix ?? ""}"`,
		);
	}
	if (sourceSeconds !== undefined) {
		log(
			`[verify] staged source ${config.sourceObject} carries ${sourceSeconds.toFixed(2)}s of VIDEO (the container may be longer)`,
		);
	}
	const runnable = pre.scenarios.filter(
		(s) =>
			(s.kind === "VOD" || (s.kind === "LIVE" && wantsLive)) &&
			(selected.size === 0 || selected.has(s.name)),
	);
	if (
		!config.dryRun &&
		runnable.some((scenario) => scenario.kind === "LIVE") &&
		!config.liveEvidenceImage
	) {
		throw new Error(
			"live verification requires --live-evidence-image (or VERIFY_LIVE_EVIDENCE_IMAGE) with an immutable sha256 digest before anything is submitted",
		);
	}
	if (selected.size > 0) {
		const unknown = [...selected].filter(
			(n) => !pre.scenarios.some((s) => s.name === n),
		);
		if (unknown.length > 0) {
			// A typo in --only would otherwise run nothing and report a green nothing.
			throw new Error(
				`--only names unknown scenario(s): ${unknown.join(", ")}`,
			);
		}
	}

	// The credential the rewrite points at must exist, or every scenario would fail
	// for the same uninformative reason.
	const credentials = await config.prisma.credential.findMany({
		// provider is selected so the GCS family can require GCS_HMAC — GCS is the
		// one cloud here with two providers, and VERIFICATION.md contemplates a
		// GCS_SERVICE_ACCOUNT credential landing next; picking by label alone would
		// hand an HMAC io a service-account credential (review-290 Sug2).
		select: { id: true, label: true, provider: true, config: true },
	});
	// Exact label first, a prefix only when unique : "the first
	// whose label starts with X" answered an ambiguous label silently.
	const credential = pickByLabel(
		credentials,
		config.s3CredentialLabel,
		"S3 credential",
	);
	if (!credential) {
		throw new Error(
			`no credential whose label starts with "${config.s3CredentialLabel}" — register one in 設定 → 資格情報`,
		);
	}
	/**
	 * The GenericS3 family's target, resolved the same way the S3 one is.
	 *
	 * Akamai Object Storage is GenericS3 with V4 signing (C10), and both its credentials were
	 * registered all along — `verify-akamai-input (bucket)` / `verify-akamai-output (bucket)`.
	 * Nothing pointed the scenario at them, so `generic-s3-akamai-io` submitted the fixture's
	 * PLACEHOLDER id and failed with `Storage credential no longer exists`: a product-shaped
	 * message for a harness omission.
	 *
	 * The bucket comes from the label, the same convention preflight already relies on
	 * (`bucketFromLabel`), so there is one source of truth for it rather than a second env var.
	 * Absent when no Akamai credential is registered, and the io then stays as authored.
	 */
	const akamaiOut = pickByLabel(
		credentials,
		"verify-akamai-output",
		"Akamai output credential",
	);
	const akamaiIn = pickByLabel(
		credentials,
		"verify-akamai-input",
		"Akamai input credential",
	);
	const genericS3 =
		akamaiOut && bucketFromLabel(akamaiOut.label)
			? {
					// Each direction gets ITS OWN credential, falling back to the output row only
					// when no input row is registered.
					inputCredentialId: (akamaiIn ?? akamaiOut).id,
					outputCredentialId: akamaiOut.id,
					inputBucket:
						(akamaiIn && bucketFromLabel(akamaiIn.label)) ??
						(bucketFromLabel(akamaiOut.label) as string),
					outputBucket: bucketFromLabel(akamaiOut.label) as string,
				}
			: undefined;
	if (genericS3) {
		log(
			`[verify] GenericS3 io repoints — read ${akamaiIn?.label ?? akamaiOut?.label} → ${genericS3.inputBucket}, write ${akamaiOut?.label} → ${genericS3.outputBucket}`,
		);
	}
	/**
	 * The GCS family's target, resolved exactly like GenericS3 above ( harness
	 * follow-up, found by the 2026-08-23 billed run).
	 * multi-output-s3-gcs's GCS MIRROR output was the placeholder-credential failure the
	 * GenericS3 comment predicted for GCS; `verify-gcs-output`/`verify-gcs-input` were registered
	 * all along (bucket in the label), nothing pointed the mirror at them.
	 */
	const gcsHmac = credentials.filter((c) => c.provider === "GCS_HMAC");
	const gcsOut = pickByLabel(
		gcsHmac,
		"verify-gcs-output",
		"GCS output credential",
	);
	const gcsIn = pickByLabel(
		gcsHmac,
		"verify-gcs-input",
		"GCS input credential",
	);
	const gcs =
		gcsOut && bucketFromLabel(gcsOut.label)
			? {
					inputCredentialId: (gcsIn ?? gcsOut).id,
					outputCredentialId: gcsOut.id,
					inputBucket:
						(gcsIn && bucketFromLabel(gcsIn.label)) ??
						(bucketFromLabel(gcsOut.label) as string),
					outputBucket: bucketFromLabel(gcsOut.label) as string,
				}
			: undefined;
	if (gcs) {
		log(
			`[verify] GCS io repoints — read ${gcsIn?.label ?? gcsOut?.label} → ${gcs.inputBucket}, write ${gcsOut?.label} → ${gcs.outputBucket}`,
		);
	}
	// A run id is never reused: its prefix would let a prior run's artefacts
	// stand as this run's evidence (BLOCKER-3). Checked at EVERY bucket the
	// rewrite can write to — S3, and the GenericS3 (Akamai/OCI) and GCS targets
	// when registered (review-327 I3: the first cut listed only S3 while the
	// akamai-* and multi-output-s3-gcs scenarios write elsewhere) — and at the
	// bucket rather than only on disk, which is what `--run-id` reuse would
	// recreate. Before the sign-in: nothing is spent past this line.
	if (!config.dryRun) {
		await assertFreshRun({
			prefix: `verify/${config.runId}/`,
			families: [
				{
					family: "S3",
					credentialId: credential.id,
					bucket: config.outputBucket,
				},
				...(genericS3
					? [
							{
								family: "GenericS3",
								credentialId: genericS3.outputCredentialId,
								bucket: genericS3.outputBucket,
							},
						]
					: []),
				...(gcs
					? [
							{
								family: "GCS",
								credentialId: gcs.outputCredentialId,
								bucket: gcs.outputBucket,
							},
						]
					: []),
			],
			holds: (family, prefix) =>
				prefixHoldsObjects(config, family.credentialId, family.bucket, prefix),
		});
	}
	// Named, or the only one — never "the oldest" .
	const account = pickAccount(
		await config.prisma.bitmovinAccount.findMany({ select: { id: true } }),
		config.bitmovinAccountId,
	);
	// Collected ONCE, up front: it is both the report's fingerprint and the
	// thing a prior report's PASS is compared against before it is honoured.
	const fingerprint = await collectRunFingerprint(config.prisma);

	const session = await signIn(config);

	// I-03 shared state: the breaker + the submit-cost budget + resume set.
	const breaker = { tripped: false, reason: "" };
	// Spent at the spend sites, never up front (review-327 I4).
	const budget = createSubmitBudget(config.maxSubmits);
	/**
	 * The prior report, whole — a PASS is honoured per scenario only after the
	 * eligibility check below (same commit, schema, plan, source, account), and
	 * only once the scenario has been found runnable and its plan rewritten;
	 * the old name-keyed map returned PASS before either .
	 */
	let priorReport:
		| {
				runId?: string;
				fingerprint?: Partial<RunReport["fingerprint"]>;
				outcomes?: ({ scenario: string; verdict: string } & Pick<
					ScenarioOutcome,
					"planSha256" | "sourceObject" | "sourceIdentity" | "bitmovinAccountId"
				>)[];
				evidence?: RunReport["evidence"];
		  }
		| undefined;
	let priorRowId: string | undefined;
	if (config.resumeFrom) {
		let claimedRunId: string | undefined;
		try {
			claimedRunId = (
				JSON.parse(await readFile(config.resumeFrom, "utf8")) as {
					runId?: unknown;
				}
			).runId as string | undefined;
		} catch {
			// The joined loader below emits the authoritative refusal.
		}
		const loaded = await loadResumeEvidence({
			runId: claimedRunId ?? "(invalid-report)",
			reportPath: config.resumeFrom,
			releaseMode: config.releaseMode === true,
			keyring: sealKeyring,
			store: prismaResumeEvidenceStore(config.prisma),
			readText: (path) => readFile(path, "utf8"),
		});
		await recorder.resumeDecision({
			...loaded.audit,
			...(loaded.ok ? { priorRowId: loaded.rowId } : {}),
		});
		if (!loaded.ok) {
			throw new Error(
				`--resume-from ${config.resumeFrom} refused [${loaded.code}]: ${loaded.reason}`,
			);
		}
		priorReport = loaded.report;
		priorRowId = loaded.rowId;
		log(
			`[verify] prior report joined to SEALED row ${loaded.rowId} (${loaded.audit.algorithm}/${loaded.audit.keyId ?? "no-key"})`,
		);
	}
	/**
	 * What the run turned out to BE, written before the first submission: the
	 * tier(s) it selected, the code and schema it fingerprinted, the account it
	 * will bill, and the prior run whose PASSes it may honour for free. Placed
	 * here rather than at the reservation because none of it is known that
	 * early — and all of it is known before a single encode is spent.
	 */
	await recorder.context({
		scenarios: runnable.map((s) => ({ name: s.name, kind: s.kind })),
		fingerprint,
		bitmovinAccountId: account?.id ?? null,
	});
	/**
	 * The staged source's identity per (credential, bucket, key) — HEADed once
	 * and cached . Resume compares it, so a re-upload under the
	 * same key cannot inherit a prior PASS.
	 */
	const sourceIdentityCache = new Map<string, Promise<string>>();
	const sourceIdentityFor = (
		credentialId: string,
		bucket: string,
		key: string,
	): Promise<string> => {
		const cacheKey = `${credentialId}\u0000${bucket}\u0000${key}`;
		const cached = sourceIdentityCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const pending = (async () => {
			try {
				const store = createCredentialStore(config.prisma, cipherFromEnv());
				const row = await store.get(credentialId);
				if (!row) {
					return "unavailable";
				}
				const browser = createBrowserForCredential({
					provider: row.provider,
					config: (row.config ?? {}) as Record<string, unknown>,
					secret: JSON.parse(await store.revealSecret(credentialId)) as Record<
						string,
						string
					>,
				});
				try {
					if (!browser.headObject) {
						return "unavailable";
					}
					const id = await browser.headObject({ bucket, key });
					const parts = [
						id.etag ? `etag=${id.etag}` : undefined,
						id.versionId ? `versionId=${id.versionId}` : undefined,
						id.size !== undefined ? `size=${id.size}` : undefined,
					].filter((p): p is string => p !== undefined);
					return parts.length > 0 ? parts.join(";") : "unavailable";
				} finally {
					browser.dispose?.();
				}
			} catch {
				return "unavailable";
			}
		})();
		sourceIdentityCache.set(cacheKey, pending);
		return pending;
	};

	/**
	 * The three readings that decide whether a job is really over — in ONE
	 * place, because the rule ("never claim terminal without the provider's
	 * word", re-audit BLOCKER-2) was written into the abandon path only, and a
	 * job that reached FAILED / ERROR / QC_FAILED locally returned without ever
	 * asking Bitmovin (review of this PR). Two call sites, one set of deps: a
	 * third caller cannot get a weaker cleanup by copying an older one.
	 *
	 * `cancel` is issued on both paths even though the route can only act on a
	 * QUEUED|RUNNING job (it is a cooperative `cancelRequested` flip and answers
	 * 409 for anything terminal — `apps/web/src/app/api/encoding-jobs/[id]/cancel`).
	 * Asking is honest and free; branching here is how the two paths drifted
	 * apart in the first place.
	 */
	const cleanupDeps = (jobId: string) => vodCleanupDeps(config, session, jobId);

	/**
	 * The durable half of a cleanup, beside `cleanupDeps` and for its reason
	 * (GO 11 + review of PR #337): `ensureTerminal` now runs on BOTH endings of
	 * `runOne` — the job the run abandons, and the job whose local row went
	 * terminal but not FINISHED — and the provider's word on each is said once,
	 * to a terminal nobody can read afterwards. Recorded through ONE function so
	 * a third ending cannot get a thinner row by copying an older call.
	 */
	const recordCleanup = (
		scenario: string,
		jobId: string,
		cleanup: Awaited<ReturnType<typeof ensureTerminal>>,
	) =>
		recorder.cleanup({
			scenario,
			jobId,
			status: cleanup.status,
			cancelHttp: cleanup.cancelHttp,
			terminal: cleanup.terminal,
			localTerminal: cleanup.localTerminal,
			providerTerminal: cleanup.providerTerminal,
			...(cleanup.provider ? { provider: cleanup.provider } : {}),
		});

	/**
	 * EV-01: the provider readback for a job whose LOCAL row reached FINISHED.
	 * No cancel (nothing to cancel), no run-row cleanup entry (that column is
	 * the abandoned set) — just the local status and every encoding's provider
	 * status, retried three times, because a transient GET must not turn a
	 * finished run into an UNRESOLVED intent lightly, and an unreadable
	 * provider must not become CLEANED at all.
	 */
	const providerReadback = async (
		jobId: string,
	): Promise<{
		terminal: boolean;
		localTerminal: boolean;
		providerTerminal: boolean | "unread";
		status: string;
		provider?: ProviderEncodingStatus[];
		error?: string;
	}> => {
		const deps = cleanupDeps(jobId);
		let lastError = "unknown";
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				const status = (await deps.readStatus()) ?? "UNKNOWN";
				const provider = await deps.readProviderStatuses();
				const localTerminal = status === "FINISHED";
				const providerTerminal =
					provider.length > 0 &&
					provider.every((p) => isProviderEncodingTerminal(p.status));
				return {
					status,
					provider,
					localTerminal,
					providerTerminal,
					terminal: localTerminal && providerTerminal,
				};
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				if (attempt < 3) {
					await deps.sleep();
				}
			}
		}
		return {
			status: "UNKNOWN",
			localTerminal: false,
			providerTerminal: "unread",
			terminal: false,
			error: `provider readback failed after 3 attempts: ${lastError}`,
		};
	};

	const runOne = async (
		s: (typeof runnable)[number],
	): Promise<ScenarioOutcome> => {
		const startedScenario = Date.now();
		const base: ScenarioOutcome = {
			scenario: s.name,
			verdict: "SKIP",
			reason: "",
			submittedVia: s.submittedVia,
			...(s.wizardDivergence ? { wizardDivergence: s.wizardDivergence } : {}),
		};
		if (breaker.tripped) {
			return {
				...base,
				verdict: "SKIP" as const,
				reason: `circuit breaker open (${breaker.reason}) — no further submissions`,
			};
		}
		// The cheap early exit: a scenario the cap has already closed is not
		// rewritten. It reserves nothing — the budget is SPENT at the spend
		// sites below (the encoding-job POST, the live channel create), so a
		// prior PASS honoured for free or an invalid rewrite never eats a unit
		// (review-327 I4).
		if (budget.exhausted() && s.runnable && !s.invalid && !config.dryRun) {
			return {
				...base,
				verdict: "SKIP" as const,
				reason: `max-submits cap (${config.maxSubmits}) reached`,
			};
		}
		if (s.invalid) {
			return { ...base, verdict: "INVALID" as const, reason: s.invalid };
		}
		if (!s.runnable) {
			return {
				...base,
				verdict: "SKIP" as const,
				reason: `blocked by ${s.blockedBy.join("+")}`,
			};
		}
		if (s.kind === "LIVE") {
			// Phase C. The live tier has its own runner because the loop is different in kind
			// — provision, feed, sample twice, stop, roll to VOD — not because it is a
			// variant of the VOD one.
			if (config.liveFeedSeconds === undefined) {
				return {
					...base,
					verdict: "SKIP" as const,
					reason:
						"live scenarios are opt-in: pass --live-feed-seconds, since each costs encoder minutes",
				};
			}
			if (!s.livePlan) {
				return {
					...base,
					verdict: "INVALID" as const,
					reason:
						"live scenario reached the runner without a parsed live plan — a harness fault, not a result",
				};
			}
			if (!account?.id) {
				return {
					...base,
					verdict: "INVALID" as const,
					reason:
						"no Bitmovin account is registered, so no live channel can be provisioned",
				};
			}
			// The Akamai live targets (2026-08-23): GENERIC_S3 rides the same
			// genericS3 target the VOD rewrite resolves (credential + its own
			// bucket); AKAMAI_MSL rides the registered provisioning-config
			// credential. Absent targets leave those families as authored —
			// the capability gates report them.
			// review-292 I1: the verify- prefix IS the harness-safety property —
			// every other family resolves by it, and preflight's evidence loop is
			// prefix-filtered. Without it, the day the CUSTOMER's own MSL
			// credential registers in this app, a verify run could publish test
			// video into their production MSL event.
			const mslCredential = credentials.find(
				(c) => c.provider === "AKAMAI_MSL" && c.label.startsWith("verify-"),
			);
			const mslConfig = mslCredential
				? CREDENTIAL_PROVIDER_SHAPES.AKAMAI_MSL.config.safeParse(
						mslCredential.config,
					)
				: undefined;
			if (mslCredential && mslConfig && !mslConfig.success) {
				return {
					...base,
					verdict: "INVALID" as const,
					reason: `verify AKAMAI_MSL credential ${mslCredential.id} has no usable streamId/eventName identity: ${mslConfig.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
				};
			}
			// The edge base (2026-09-02): the flag/env override when given, else
			// the credential's own `edgeBaseUrl`, re-validated against the
			// harness's delivery-host allowlist. A credential value the rail
			// refuses is INVALID here, before the channel is created — never a
			// silent fall-back to UNOBSERVED, which would read as "not
			// configured" about a value that IS configured.
			const mslEdge =
				mslCredential && mslConfig?.success
					? liveMslEdgeBaseUrlForRun({
							override: config.liveMslEdgeBaseUrl,
							credentialEdgeBaseUrl: mslConfig.data.edgeBaseUrl,
							allowedHosts: config.liveMslEdgeAllowedHosts,
						})
					: undefined;
			if (mslEdge && !mslEdge.ok) {
				return {
					...base,
					verdict: "INVALID" as const,
					reason: `verify AKAMAI_MSL credential ${mslCredential?.id}: ${mslEdge.reason}`,
				};
			}
			if (mslEdge?.ok && mslEdge.source === "credential") {
				log(
					`${s.name}: MSL edge base ${mslEdge.url} taken from credential ${mslCredential?.id} (no --live-msl-edge-base-url override)`,
				);
			}
			const liveRewrite = {
				bitmovinAccountId: account.id,
				...(config.liveEncoderVersion
					? { encoderVersion: config.liveEncoderVersion }
					: {}),
				credentialId: credential.id,
				outputBucket: config.outputBucket,
				channelName: `${ucNameFor(s.name)} [verify ${config.runId}]`,
				...(genericS3
					? {
							akamaiStorage: {
								credentialId: genericS3.outputCredentialId,
								bucket: genericS3.outputBucket,
							},
						}
					: {}),
				...(mslCredential && mslConfig?.success
					? {
							akamaiMsl: {
								credentialId: mslCredential.id,
								streamId: mslConfig.data.streamId,
								eventName: mslConfig.data.eventName,
								...(mslEdge?.ok && mslEdge.url
									? { edgeBaseUrl: mslEdge.url }
									: {}),
							},
						}
					: {}),
				...(config.livePublicRead ? { publicRead: true } : {}),
				prefix: `verify/${config.runId}/${s.name}/`,
			};
			// A rehearsal stops only at the paid create boundary. It still executes
			// the same schema parse, per-run rewrite, expectation compile, and MSL
			// credential binding as the paid path. SKIP is deliberate: this proves
			// harness preparation, not delivery, and therefore is never release green.
			if (config.dryRun) {
				try {
					const prepared = prepareLiveScenarioForRun({
						plan: s.livePlan,
						rewrite: liveRewrite,
						startTimeoutSec: config.liveStartTimeoutSec ?? 600,
						feedSeconds: config.liveFeedSeconds ?? 0,
					});
					await writeFile(
						join(config.runDir, `${s.name}.plan.json`),
						`${JSON.stringify(prepared.submitted, null, "\t")}\n`,
					);
					return {
						...base,
						verdict: "SKIP" as const,
						reason: `dry run: validated, rewritten, and compiled ${prepared.expected.muxings.length} muxing(s) and ${prepared.expected.manifests.length} manifest(s); no paid resource was created`,
						elapsedMs: Date.now() - startedScenario,
					};
				} catch (err) {
					return {
						...base,
						verdict: "INVALID" as const,
						reason: `dry run: live preparation failed: ${err instanceof Error ? err.message : String(err)}`,
						elapsedMs: Date.now() - startedScenario,
					};
				}
			}
			// The live spend site: the live runner creates the channel right after
			// its own rewrite, so the unit is charged here, in the same synchronous
			// step as the cap check (review-327 I4).
			const liveSpend = budget.spend();
			if (!liveSpend.ok) {
				return { ...base, verdict: "SKIP" as const, reason: liveSpend.reason };
			}
			return await runLive(
				config,
				session,
				s,
				base,
				liveRewrite,
				// What the evidence tuple binds to:
				// EV-02): the run's fingerprinted commit and explicitly supplied image
				// identity. The fed source seal comes from the feeder row AFTER it hashes
				// the bytes actually pushed; a pre-feed HEAD is not that evidence.
				{
					commit: fingerprint.commit,
					...(config.liveEvidenceImage
						? { image: config.liveEvidenceImage }
						: {}),
				},
				(legs) => recorder.liveEvidence({ scenario: s.name, legs }),
			);
		}
		if (!s.plan) {
			return {
				...base,
				verdict: "SKIP" as const,
				reason:
					"a VOD scenario reached the runner without a plan — a harness fault",
			};
		}

		const needSeconds = s.plan ? requiredSourceSeconds(s.plan) : undefined;
		/**
		 * Escalate to the LONG mezzanine rather than skipping.
		 *
		 * The gate was right to refuse the short source and wrong to stop there: a permanent SKIP
		 * for two scenarios that a second staged asset covers is a hole, not a verdict. The run
		 * stages both and picks from the measured requirement — and only SKIPs when neither is long
		 * enough, which is then an honest statement about the assets rather than about the product.
		 */
		let sourceForScenario = config.sourceObject;
		if (needSeconds !== undefined && sourceSeconds !== undefined) {
			if (needSeconds > sourceSeconds) {
				if (
					config.longSourceObject !== undefined &&
					longSeconds !== undefined &&
					needSeconds <= longSeconds
				) {
					sourceForScenario = config.longSourceObject;
					log(
						`${s.name}: needs ${needSeconds}s, so reading ${config.longSourceObject} (${longSeconds.toFixed(2)}s) instead of the ${sourceSeconds.toFixed(2)}s default`,
					);
				} else {
					return {
						...base,
						verdict: "SKIP" as const,
						reason: `needs a source of at least ${needSeconds}s; the run stages ${sourceSeconds.toFixed(2)}s${longSeconds !== undefined ? ` and ${longSeconds.toFixed(2)}s` : ""} — submitting it would bill for a guaranteed input failure (stage a longer mezzanine to open this)`,
						elapsedMs: Date.now() - startedScenario,
					};
				}
			}
		}
		const prefix = `verify/${config.runId}/${s.name}/`;
		const rewriteOptions: RewriteOptions = {
			credentialId: credential.id,
			inputBucket: config.inputBucket,
			outputBucket: config.outputBucket,
			// Per scenario: the long mezzanine where the plan's own numbers demand it.
			sourceObject: sourceForScenario,
			prefix,
			...(account ? { bitmovinAccountId: account.id } : {}),
			...(genericS3 ? { genericS3 } : {}),
			...(gcs ? { gcs } : {}),
			jobName: ucNameFor(s.name),
			...(config.genericS3SourceObject
				? { genericS3SourceObject: config.genericS3SourceObject }
				: {}),
			resolveAsset: assets.resolve,
			...(config.vmafModel ? { vmafModel: config.vmafModel } : {}),
		};
		let plan: EncodingPlan;
		try {
			plan = rewriteForRun(s.plan, rewriteOptions);
		} catch (err) {
			// A rewrite that produces an invalid plan is OUR bug, so it is INVALID
			// (never counted as product-green) rather than a scenario failure.
			return {
				...base,
				verdict: "INVALID" as const,
				reason: `rewrite produced an invalid plan: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
			};
		}

		if (config.dryRun) {
			// Compile the expectations anyway: a plan that rewrites cleanly but compiles
			// to nothing would "verify" green later, and this is where that shows up.
			const expected = compileExpectedArtefacts(plan);
			const artefacts = dryRunArtefactCount(expected);
			await writeFile(
				join(config.runDir, `${s.name}.plan.json`),
				`${JSON.stringify(plan, null, "\t")}\n`,
			);
			return {
				...base,
				verdict: artefacts > 0 ? ("PASS" as const) : ("INVALID" as const),
				reason:
					artefacts > 0
						? `dry run: rewritten and compiles to ${artefacts} expected artefact group(s)`
						: "dry run: rewritten plan compiles to NO expected artefacts",
				elapsedMs: Date.now() - startedScenario,
			};
		}

		/**
		 * Refuse to hand the encoder a job the staged source cannot satisfy.
		 *
		 * A SKIP that names the numbers, not a submitted encoding that fails opaquely and gets
		 * filed as a product defect. Only fires when BOTH numbers are known — an unmeasurable
		 * source must not cost coverage.
		 */

		/**
		 * And refuse when the source is not staged on the provider this scenario READS from.
		 *
		 * Only checked for GenericS3, the one non-S3 family with a registered credential; the
		 * others are already gated by their capability being unsatisfied. Measured per run, not
		 * assumed from the capability probe, which only ever proved the bucket answers.
		 */
		const genericInput = (s.plan?.inputs ?? []).some(
			(io) => io.kind === "GENERIC_S3",
		);
		if (genericInput && genericS3) {
			// Checked with the INPUT credential, i.e. the one Bitmovin will read with — checking
			// with a different key pair than the encoder uses would prove the wrong thing.
			const staged = await sourceStagedIn(
				config,
				genericS3.inputCredentialId,
				genericS3.inputBucket,
				config.genericS3SourceObject ?? config.sourceObject,
			);
			/**
			 * Logged whichever way it goes — and read off the FIELDS, not the object.
			 *
			 * The first version returned `undefined` on error and logged nothing else, so a gate
			 * that did not fire was indistinguishable from a measurement that failed. The second
			 * version returned `{present, error}` but kept the old ternary, `staged ? … : …` — and
			 * an object is always truthy, so it printed `present` unconditionally. I then read
			 * that line, concluded the object WAS in the bucket, and told the owner my earlier
			 * reasoning had been wrong. It had not: the gate was right and my instrument was lying,
			 * for the fourth time in this round and the second time within one hour.
			 */
			const genericKey = config.genericS3SourceObject ?? config.sourceObject;
			log(
				`${s.name}: ${genericKey} in ${genericS3.inputBucket}: ${
					staged.error
						? `COULD NOT MEASURE — ${staged.error}`
						: staged.present
							? "present"
							: `ABSENT — the bucket holds: ${staged.found?.length ? staged.found.join(", ") : "(nothing)"}`
				}`,
			);
			if (staged.present === false) {
				return {
					...base,
					verdict: "SKIP" as const,
					reason: `${genericKey} is not in ${genericS3.inputBucket} — set VERIFY_GENERIC_S3_SOURCE_OBJECT to one of the objects the log lists, or stage this one`,
					elapsedMs: Date.now() - startedScenario,
				};
			}
		}
		// EV-03: retain the exact submitted plan for every paid attempt. The old
		// runner wrote plan files only in --dry-run, so a sealed PASS had no
		// scenario-level plan artefact for resume to bind.
		await writeFile(
			join(config.runDir, `${s.name}.plan.json`),
			`${JSON.stringify(plan, null, "\t")}\n`,
		);

		// : what this scenario's verdict is a verdict OF, recorded on
		// every outcome from here on.
		const identity = {
			// RUN-INDEPENDENT (review-327 Critical): the rewritten plan carries the
			// run id in its name and in every destination path, and a run never
			// reuses an id — so a digest of `plan` itself could never equal a
			// prior run's, and `--resume-from` honoured nothing, ever. The digest
			// is taken over the same rewrite under a placeholder run id.
			planSha256: planIdentitySha256(s.plan, rewriteOptions, s.name),
			sourceObject: sourceForScenario,
			// From the rewritten plan's OWN ingests — every one of them — so the
			// GenericS3 / GCS sources are HEADed through their own credential
			// and bucket, and a two-source plan cannot hide a swapped second
			// object (review of this PR).
			sourceIdentity: await planSourceIdentity(plan, sourceIdentityFor),
			bitmovinAccountId: account?.id ?? null,
		};
		if (priorReport) {
			const eligibility = resumeEligibility(
				{
					fingerprint: priorReport.fingerprint,
					outcome: priorReport.outcomes?.find((o) => o.scenario === s.name),
					runId: priorReport.runId,
				},
				{ fingerprint, ...identity },
			);
			if (eligibility.honor) {
				const priorManifest = priorReport.evidence?.manifest.scenarios.find(
					(entry) => entry.scenario === s.name,
				);
				await writeFile(
					join(config.runDir, `${s.name}.report.json`),
					`${JSON.stringify(
						{
							scenario: s.name,
							resumedFrom: {
								runId: eligibility.runId,
								rowId: priorRowId,
								priorEvidence: priorManifest,
							},
						},
						null,
						"\t",
					)}\n`,
				);
				return {
					...base,
					...identity,
					verdict: "PASS" as const,
					reason: `resume: passed in ${eligibility.runId} against the same commit, schema, plan, source and account; not re-spent`,
					resumedFromRunId: eligibility.runId,
				};
			}
			log(`${s.name}: resume not honoured — ${eligibility.reason}`);
		}

		// The VOD spend site (review-327 I4): checked and charged in one
		// synchronous step, after the resume decision, so a free PASS costs
		// nothing and concurrent scenarios cannot both squeeze past the cap.
		const spend = budget.spend();
		if (!spend.ok) {
			return {
				...base,
				...identity,
				verdict: "SKIP" as const,
				reason: spend.reason,
			};
		}
		/**
		 * EV-01: the durable intent, BEFORE the paid
		 * POST. The old `submit` threw on a lost or unparseable response and the
		 * catch below saw `!jobId` and returned INVALID with no cleanup — the job
		 * was created, billing, and named by nothing. Now the intent row lands
		 * first (PREPARED, then SUBMITTED — both HARD: a failed write means
		 * nothing is sent), the key rides the request as a body field AND a plan
		 * label, and an ambiguous response is resolved by LOOKUP, never by a
		 * second send.
		 */
		const intentKey = verificationKeyFor(config.runId, s.name, "VOD_JOB");
		const submitPlan = withVerificationLabel(plan, intentKey);
		const submitBody = {
			name: submitPlan.name,
			plan: submitPlan,
			verificationKey: intentKey,
		};
		let intent: IntentHandle;
		try {
			intent = await intents.prepare({
				scenario: s.name,
				kind: "VOD_JOB",
				verificationKey: intentKey,
				requestSha256: verificationRequestSha256(submitBody),
				resourceName: submitPlan.name,
			});
		} catch (err) {
			return {
				...base,
				...identity,
				verdict: "INVALID" as const,
				reason: `durable intent could not be recorded (${err instanceof Error ? err.message.slice(0, 200) : String(err)}) — nothing was submitted`,
				elapsedMs: Date.now() - startedScenario,
			};
		}
		let verificationDispatch: VerificationDispatchFence;
		try {
			verificationDispatch = await intent.submitted();
		} catch (err) {
			return {
				...base,
				...identity,
				verdict: "INVALID" as const,
				reason: `durable intent could not be marked SUBMITTED (${err instanceof Error ? err.message.slice(0, 200) : String(err)}) — nothing was sent`,
				elapsedMs: Date.now() - startedScenario,
			};
		}
		/**
		 * Close the intent from EVERY ending that read the provider. CLEANED
		 * only on a local terminal AND a provider readback that settled; a
		 * provider left unread or non-terminal is UNRESOLVED and the run will
		 * not seal — the intent set is the seal's authority, not this log.
		 */
		const terminalInputFor = (
			jobId: string,
			readback: {
				terminal: boolean;
				providerTerminal: boolean | "unread";
				localTerminal: boolean;
				status: string;
				provider?: readonly ProviderEncodingStatus[];
				error?: string;
			},
		): IntentTerminalInput => {
			const resources = vodIntentResourceSets(
				jobId,
				readback.provider,
				readback.localTerminal,
			);
			return {
				cleanupState:
					readback.terminal && readback.providerTerminal === true
						? "CLEANED"
						: "UNRESOLVED",
				readback: { jobId, ...readback },
				providerId: readback.provider?.[0]?.encodingId ?? null,
				...resources,
				...(readback.terminal && readback.providerTerminal === true
					? {}
					: {
							error:
								readback.error ??
								`job ${jobId} not proven terminal: local ${readback.status}, provider ${readback.providerTerminal === "unread" ? "unread" : readback.providerTerminal ? "terminal" : "NOT terminal"}`,
						}),
			};
		};
		const additionalCanaryClosures: IntentTerminalInput[] = [];
		const closeIntent = (
			jobId: string,
			readback: Parameters<typeof terminalInputFor>[1],
		) =>
			intent.terminal(
				mergeIntentTerminalInputs(
					terminalInputFor(jobId, readback),
					additionalCanaryClosures,
				),
			);
		let jobId: string | undefined;
		try {
			log(`${s.name}: submitting (intent ${intentKey})`);
			const responseLossCanary = responseLossCanaryFor.get(config);
			noteCanaryCreatePost(responseLossCanary, "VOD_JOB", s.name);
			const sent = await submit(config, session, {
				...submitBody,
				requestSha256: intent.requestSha256,
				verificationDispatch,
			});
			if (sent.ok) {
				// The exact-key/SHA route is idempotent, and this durable id capture
				// lands before the dispatch lease is released. A lost client response
				// therefore remains discoverable without a second paid resource.
				jobId = sent.jobId;
				await intent.recordCreateResponseId(sent.jobId);
			}
			const injectResponseLoss =
				sent.ok &&
				shouldInjectPostCreateResponseLoss(responseLossCanary, {
					resourceKind: "VOD_JOB",
					scenario: s.name,
					localId: sent.jobId,
					replayed: sent.replayed,
				});
			if (sent.ok && injectResponseLoss) {
				// The successful response's exact id becomes cleanup-owned BEFORE
				// either durable-intent write/lookup can throw. The response is being
				// discarded as evidence, not forgotten for paid-resource safety.
				const reason =
					"fault injection: discarded the successful fresh VOD product HTTP CREATE response after the product API returned an id";
				await intent.ambiguous(reason);
				const found = await intent.resolve();
				if (!found.adopted) {
					// Keep the hidden canary id solely for bounded cleanup. It is not
					// counted as adoption evidence and the run cannot seal.
					throw new Error(
						`fault injection lost the successful CREATE response and ${found.reason}; intent adoption failed`,
					);
				}
				noteCanaryAdoption(responseLossCanary, found.localId);
				if (found.localId !== sent.jobId) {
					const mismatched = await ensureTerminal({
						...cleanupDeps(found.localId),
						budgetMs: ABANDON_CLEANUP_BUDGET_MS,
					});
					await recordCleanup(s.name, found.localId, mismatched);
					additionalCanaryClosures.push(
						terminalInputFor(found.localId, mismatched),
					);
					throw new Error(
						`fault injection adopted ${found.localId}, not the known successfully created job ${sent.jobId}; both resources are included in bounded cleanup`,
					);
				}
				jobId = found.localId;
				log(
					`${s.name}: injected product-HTTP post-CREATE response loss; adopted job ${jobId} by durable intent and continuing without another create`,
				);
			} else if (sent.ok) {
				if (sent.replayed) {
					log(
						`${s.name}: the product returned the EXISTING job ${jobId} for this key — not re-spent`,
					);
				}
				await intent.confirmed(sent.jobId);
			} else if (sent.phase === "BEFORE_SEND") {
				await intent.neverSent(sent.error);
				return {
					...base,
					...identity,
					verdict: "INVALID" as const,
					reason: `harness error: ${sent.error.slice(0, 250)} (the request never left — nothing was created)`,
					elapsedMs: Date.now() - startedScenario,
				};
			} else if (sent.phase === "REFUSED") {
				await intent.refused(sent.error);
				return {
					...base,
					...identity,
					verdict: "INVALID" as const,
					reason: `harness error: ${sent.error.slice(0, 250)}`,
					elapsedMs: Date.now() - startedScenario,
				};
			} else {
				// AMBIGUOUS — never a blind re-send. The job may exist and bill;
				// find it by its key and label, adopt exactly one, continue with
				// it (it is the job this scenario paid for).
				await intent.ambiguous(sent.error);
				const found = await intent.resolve();
				if (!found.adopted) {
					return {
						...base,
						...identity,
						verdict: "INVALID" as const,
						reason: `harness error: ${sent.error.slice(0, 200)} — ${found.reason}; intent ${intentKey} is UNRESOLVED and the run will not seal — operator action required`,
						elapsedMs: Date.now() - startedScenario,
					};
				}
				jobId = found.localId;
				log(
					`${s.name}: submit response lost (${sent.error.slice(0, 120)}); adopted job ${jobId} by its verification key — continuing with it`,
				);
			}
			if (!jobId) {
				throw new Error(
					"submit completed without a durable response id or exact-key adoption",
				);
			}
			const terminal = await awaitTerminal(config, jobId);
			if (terminal.status !== "FINISHED") {
				// The LOCAL row is terminal — that is what `awaitTerminal`
				// returned on — and that is exactly the claim the audit says we
				// may not make alone (review of this PR): a plan with several
				// encodings can write FAILED off the first one while a sibling
				// is still RUNNING and billing. Same deps as the abandon path.
				const cleanup = await ensureTerminal({
					...cleanupDeps(jobId),
					budgetMs: TERMINAL_PROVIDER_BUDGET_MS,
				});
				// This ending reads the provider too, so this ending records it
				// too: a FAIL whose sibling encoding is still billing is exactly
				// the row a release reader has to be able to find afterwards.
				await recordCleanup(s.name, jobId, cleanup);
				await closeIntent(jobId, cleanup);
				log(
					`${s.name}: job ${jobId} ended ${terminal.status} [${providerWord(cleanup)}]${cleanup.terminal ? "" : " — provider NOT terminal"}`,
				);
				return {
					...base,
					...identity,
					...failedJobOutcome(terminal, cleanup),
					jobId,
					...(terminal.encodingId ? { encodingId: terminal.encodingId } : {}),
					elapsedMs: Date.now() - startedScenario,
				};
			}
			if (plan.qc?.vmaf || plan.qc?.psnr) {
				// : the measurement is part of the scenario. Wait for it so
				// verifyJob's qc:* checks read a terminal row, not a race.
				const vmaf = await awaitVmafTerminal(config, jobId);
				log(`${s.name}: AUTO VMAF ${vmaf.status} after ${vmaf.polls} poll(s)`);
			}
			const verified = await verifyJob({
				prisma: config.prisma,
				ffprobePath: config.ffprobePath,
				jobIdPrefix: jobId,
				//  (BLOCKER-3): objects written before this job, or
				// matching nothing the plan declares, are FOREIGN and fail the run.
				// The declared population was completed by #207, which is what
				// makes this safe to switch on for every paid scenario.
				excludeOlderThanJob: true,
				log: (line) => log(`${s.name}: ${line}`),
			});
			await writeFile(
				join(config.runDir, `${s.name}.report.json`),
				`${JSON.stringify(verified, null, "\t")}\n`,
			);
			// EV-01: a FINISHED job is still a possibly-created resource, and its
			// terminal is READ BACK at the provider — never inferred from the
			// local row alone (the #217 rule, now on the success ending too).
			await closeIntent(jobId, await providerReadback(jobId));
			const counts = verified.report.counts;
			return {
				...base,
				...identity,
				// The WHOLE outcome, not a verdict this call site then reasons
				// about — see vodOutcomeForReport. review-298 found that the
				// verdict-only version left this line able to revert to the
				// pre-fix ternary with the entire suite green.
				...vodOutcomeForReport(verified.report, s.name),
				jobId,
				...(terminal.encodingId ? { encodingId: terminal.encodingId } : {}),
				checks: counts,
				elapsedMs: Date.now() - startedScenario,
			};
		} catch (err) {
			// Harness failure, not product failure. INVALID keeps the two apart, which
			// matters: a flaky network must never read as "the encoder is broken".
			const message = `harness error: ${err instanceof Error ? err.message.slice(0, 250) : String(err)}`;
			if (!jobId) {
				return {
					...base,
					...identity,
					verdict: "INVALID" as const,
					reason: message,
					elapsedMs: Date.now() - startedScenario,
				};
			}
			//  (BLOCKER-4): a job the run abandons is still billing.
			// Cancel it through the product and wait for a terminal state; say
			// which state it reached, or that it did not — never walk away from
			// a RUNNING encoding with a report that does not name it.
			const abandoned = jobId;
			const cleanup = await ensureTerminal({
				...cleanupDeps(abandoned),
				budgetMs: ABANDON_CLEANUP_BUDGET_MS,
			});
			// The provider's word, durably (GO 11): the log line below says it
			// once to a terminal, and the terminal is exactly what the audit
			// could not read back afterwards.
			await recordCleanup(s.name, abandoned, cleanup);
			await closeIntent(abandoned, cleanup);
			const word = providerWord(cleanup);
			log(
				`${s.name}: job ${abandoned} after cancel (HTTP ${cleanup.cancelHttp}): ${cleanup.status} [${word}]${cleanup.terminal ? "" : " — NOT terminal"}`,
			);
			return {
				...base,
				...identity,
				verdict: "INVALID" as const,
				reason: cleanup.terminal
					? `${message} — job ${abandoned} driven to ${cleanup.status} (cancel HTTP ${cleanup.cancelHttp}; provider ${word})`
					: `${message} — job ${abandoned} is NOT terminal after cancel (HTTP ${cleanup.cancelHttp}) and a 5-minute wait: local ${cleanup.status}, ${word} — stop it by hand, it may still be billing`,
				jobId: abandoned,
				elapsedMs: Date.now() - startedScenario,
			};
		}
	};

	const outcomes = await pooled(runnable, config.concurrency, async (s) => {
		const outcome = await runOne(s);
		// I-03: EVERY path trips the breaker uniformly — invalid, failed
		// start, live, VOD, harness error alike.
		const trip = breakerTripReason(outcome);
		if (trip && !breaker.tripped) {
			breaker.tripped = true;
			breaker.reason = trip;
			log(`[verify] CIRCUIT BREAKER OPEN — ${trip}`);
		}
		// Written as it finishes, not at the end: a run killed mid-corpus
		// (a breaker trip, a lost host, an operator's ^C) then leaves the
		// verdicts it DID reach — including the encoding ids it spent on —
		// instead of an empty row and a report that was never written.
		await recorder.outcome(outcome);
		return outcome;
	});

	// Scenarios preflight blocked are reported too — the population is never narrowed.
	const skipped: ScenarioOutcome[] = pre.scenarios
		.filter((s) => !runnable.some((r) => r.name === s.name))
		.map((s) => {
			// Every SKIP must name its own cause. The first version printed
			// "blocked by " — with nothing after it — for scenarios excluded by
			// `--only`, which is both useless and untrue: a filter is not a missing
			// resource, and the design's promise is that a SKIP says what would open it.
			const reason = s.invalid
				? s.invalid
				: s.kind === "LIVE" && !wantsLive
					? "live scenarios are opt-in: pass --live-feed-seconds, since each costs encoder minutes"
					: s.blockedBy.length > 0
						? `blocked by ${s.blockedBy.join("+")}`
						: `not selected by --only ${[...selected].join(",")}`;
			return {
				scenario: s.name,
				verdict: s.invalid ? ("INVALID" as const) : ("SKIP" as const),
				reason,
			};
		});

	const all = [...outcomes, ...skipped].sort((a, b) =>
		a.scenario.localeCompare(b.scenario),
	);
	/**
	 * The partition must be TOTAL: every scenario preflight loaded gets exactly one
	 * outcome. It is total by construction — `skipped` is the complement of `runnable` over
	 * the same list — but nothing asserted it, and the failure mode is the one this
	 * project keeps rediscovering: `formatRunReport` prints `total ${outcomes.length}`, so
	 * a partition that stopped being total would print a smaller, entirely plausible
	 * number over a population that had quietly shrunk. A review suggested pinning it and
	 * it costs one comparison.
	 */
	if (all.length !== pre.scenarios.length) {
		throw new Error(
			`run report covers ${all.length} scenarios but preflight loaded ${pre.scenarios.length} — ` +
				"every scenario must get exactly one outcome, so this is a harness bug, not a result",
		);
	}
	const counts: Record<ScenarioVerdict, number> = {
		PASS: 0,
		WARN: 0,
		FAIL: 0,
		SKIP: 0,
		INVALID: 0,
	};
	for (const o of all) {
		counts[o.verdict] += 1;
	}
	const report: RunReport = {
		runId: config.runId,
		startedAt,
		finishedAt: new Date().toISOString(),
		fingerprint,
		preflight: pre.capabilities,
		outcomes: all,
		counts,
	};
	let reportJson = `${JSON.stringify(report, null, "\t")}\n`;
	/**
	 * EV-01 (§14.4 change 6): the intent teardown, BEFORE any seal. Every
	 * intent of this run is enumerated from the database; anything not yet
	 * TERMINAL is resolved through its kind's resolver (a VOD job is driven
	 * terminal through the product and read back at the provider; a live
	 * channel is stopped, confirmed and cleanup-sealed). The run seals ONLY
	 * when `possibly-created == terminal-readback-and-cleaned`. Otherwise:
	 * report.incomplete.json / .md stay on disk as evidence, while no canonical
	 * report or seal is published. The throw marks the row INCOMPLETE — a
	 * nonzero exit and 0 SEALED rows.
	 */
	const teardown = await intents.teardown({
		VOD_JOB: async (row) => {
			const cleanup = await ensureTerminal({
				...cleanupDeps(row.localId),
				budgetMs: ABANDON_CLEANUP_BUDGET_MS,
			});
			await recordCleanup(row.scenario, row.localId, cleanup);
			const resources = vodIntentResourceSets(
				row.localId,
				cleanup.provider,
				cleanup.localTerminal,
			);
			return {
				terminal: cleanup.terminal && cleanup.providerTerminal === true,
				readback: { jobId: row.localId, ...cleanup },
				providerId: cleanup.provider?.[0]?.encodingId ?? null,
				...resources,
				...(cleanup.terminal && cleanup.providerTerminal === true
					? {}
					: {
							error: `job ${row.localId}: local ${cleanup.status}, provider ${providerWord(cleanup)}`,
						}),
			};
		},
		LIVE_CHANNEL: async (row) => {
			return resolveLiveVerificationIntent(
				config,
				liveApiFor(config, session),
				row.localId,
				{
					now: Date.now,
					sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
					log,
				},
			);
		},
	});
	for (const line of teardown.lines) {
		log(`[verify] intent ${line}`);
	}
	// The eventual sealed bytes include the DB-authoritative intent dossier.
	report.resourceIntents = teardown.dossier;
	const responseLossCanary = responseLossCanaryFor.get(config);
	const canaryIntent = responseLossCanary
		? teardown.dossier.find(
				(row) =>
					row.scenario === responseLossCanary.scenario &&
					row.kind === responseLossCanary.resourceKind,
			)
		: undefined;
	const canaryIntentSeal = canaryIntent
		? verificationIntentsSealable([canaryIntent])
		: undefined;
	const canaryCandidates = canaryIntent?.candidates ?? [];
	const canaryExactCandidates = canaryIntent
		? canaryCandidates.filter(
				(candidate) =>
					candidate.matchedBy.includes("key") &&
					candidate.requestSha256 === canaryIntent.requestSha256,
			)
		: [];
	const canaryError = responseLossCanary
		? (canaryCompletionError(responseLossCanary) ??
			(!canaryIntent
				? "the canary has no matching durable resource intent"
				: canaryExactCandidates.length !== 1 ||
						canaryExactCandidates[0]?.localId !==
							responseLossCanary.adoptedLocalId
					? `intent lookup found ${canaryExactCandidates.length} exact key+request-SHA candidate(s), not exactly the adopted resource`
					: !canaryIntentSeal?.sealable
						? "the adopted canary resource did not reach TERMINAL/CLEANED with exact resource-set equality"
						: undefined))
		: undefined;
	if (responseLossCanary) {
		report.faultInjection = {
			...postCreateResponseLossEvidence(responseLossCanary),
			lookupCandidates: canaryCandidates.length,
			exactLookupCandidates: canaryExactCandidates.length,
			intentState: canaryIntent?.state ?? null,
			cleanupState: canaryIntent?.cleanupState ?? null,
			exactResourceSet: canaryIntentSeal?.sealable === true,
		};
	}
	reportJson = `${JSON.stringify(report, null, "\t")}\n`;
	const intentSection = `\n## Paid-resource intents (EV-01)\n\n${
		teardown.lines.length === 0
			? "_none — nothing was submitted_\n"
			: `${teardown.dossier
					.map(
						(row) =>
							`- ${row.verificationKey}: ${row.state}/${row.cleanupState}; request ${row.requestSha256}; possible [${row.possiblyCreatedKeys.join(", ")}]; cleaned [${row.cleanedResourceKeys.join(", ")}]; closure ${row.closureDigest ?? "missing"}; events ${row.events?.length ?? 0}`,
					)
					.join("\n")}\n`
	}`;
	if (!teardown.sealable || canaryError) {
		await writeFile(join(config.runDir, "report.incomplete.json"), reportJson);
		await writeFile(
			join(config.runDir, "report.incomplete.md"),
			`${formatRunReport(report)}${intentSection}\n**NOT SEALED** — ${canaryError ?? `${teardown.unresolved.length} unresolved intent(s); operator action required`}.\n`,
		);
		if (canaryError) {
			throw new Error(
				`post-CREATE response-loss canary is incomplete: ${canaryError} — the run is NOT sealed`,
			);
		}
		throw new Error(
			`${teardown.unresolved.length} paid-resource intent(s) could not be resolved to a terminal, cleaned resource (${teardown.unresolved
				.map(
					(row) =>
						`${row.verificationKey}${row.localId ? ` → ${row.localId}` : ""}`,
				)
				.join(
					", ",
				)}) — the run is NOT sealed; check the product and provider for a billing resource before re-running`,
		);
	}
	if (config.dryRun && config.releaseMode === true) {
		await writeFile(join(config.runDir, "report.dry-run.json"), reportJson);
		await writeFile(
			join(config.runDir, "report.dry-run.md"),
			`${formatRunReport(report)}${intentSection}\n**DRY RUN — NOT RELEASE SEALED**\n`,
		);
		throw new Error(
			"release dry run completed validation but is intentionally not sealable release evidence; run without --dry-run to collect durable live tuples",
		);
	}
	const evidenceManifest = await buildEvidenceManifest({
		runDir: config.runDir,
		outcomes: report.outcomes,
		readText: (path) => readFile(path, "utf8"),
		...(config.dryRun ? { allowMissing: true } : {}),
	});
	// Markdown is derived before the evidence envelope. formatRunReport does not
	// render evidence metadata, so its exact digest can be embedded in JSON
	// without a circular representation; the JSON HMAC then binds both exports.
	const reportMarkdown = `${formatRunReport(report)}${intentSection}`;
	report.evidence = {
		version: EVIDENCE_VERSION,
		algorithm: sealPolicy.algorithm,
		keyId: sealPolicy.keyId,
		retentionUntil: sealPolicy.retentionUntil,
		manifest: evidenceManifest,
		reportMarkdownSha256: createHash("sha256")
			.update(reportMarkdown)
			.digest("hex"),
	};
	// The evidence envelope itself must be inside the sealed bytes.
	reportJson = `${JSON.stringify(report, null, "\t")}\n`;
	// Sealed at the end : release mode is named HMAC only;
	// SHA remains available solely for local corruption detection.
	const seal = sealReport(reportJson, sealPolicy.key);
	const sealRecord = {
		reportJson,
		reportMarkdown,
		seal,
		sealAlgorithm: sealPolicy.algorithm,
		sealKeyId: sealPolicy.keyId,
		...(sealPolicy.key ? { sealKey: sealPolicy.key } : {}),
		evidenceVersion: EVIDENCE_VERSION,
		evidenceManifest: evidenceManifest as unknown as Record<string, unknown>,
		retentionUntil: sealPolicy.retentionUntil,
		outcomes: report.outcomes,
		counts: report.counts,
		resourceIntents: report.resourceIntents,
		finishedAt: report.finishedAt,
	};
	const publication = await publishSealedRunReport({
		runDir: config.runDir,
		reportJson,
		reportMarkdown,
		seal,
		// Both callbacks receive the same immutable-by-convention value, so DB
		// validation and the final row commit name the bytes staged for export.
		validateDurably: () => recorder.preseal(sealRecord),
		sealDurably: () => recorder.sealed(sealRecord),
	});
	log(`[verify] report sealed: ${seal.slice(0, 18)}…`);
	if (!publication.exported) {
		log(
			`[verify] DB report authority is SEALED, but local exports remain pending: ${publication.error ?? "unknown filesystem failure"}; run verify recover --run-id ${config.runId} to rebuild them`,
		);
	}
	return report;
}

export function formatRunReport(report: RunReport): string {
	const fp = report.fingerprint;
	const lines = [
		`# verify run ${report.runId}`,
		"",
		`${report.startedAt} → ${report.finishedAt}`,
		"",
		`commit \`${fp.commit}\` · checkout migration \`${fp.checkoutLatestMigration}\` · DB migration \`${fp.dbLatestMigration}\`${
			fp.drift
				? " · **DRIFT — the DB and the checkout disagree; this run's results describe a hybrid**"
				: ""
		}`,
		"",
		"| scenario | verdict | detail |",
		"|---|---|---|",
	];
	for (const o of report.outcomes) {
		lines.push(
			`| ${o.scenario} | ${o.verdict} | ${o.reason.replace(/\|/g, "\\|")} |`,
		);
	}
	const c = report.counts;
	lines.push(
		"",
		`PASS ${c.PASS} · WARN ${c.WARN} · FAIL ${c.FAIL} · SKIP ${c.SKIP} · INVALID ${c.INVALID} · total ${report.outcomes.length}`,
		"",
		"Every scenario in the corpus appears above. A SKIP names the resource that",
		"would open it; an INVALID is a harness fault and is never product-green.",
	);
	lines.push(...leastTrustworthyGreens(report));
	lines.push(...originLatency(report));
	lines.push(...wizardPaths(report));
	return `${lines.join("\n")}\n`;
}

/**
 * Which of the wizard's two submit paths each scenario used.
 *
 * "Verified" means something different depending on the answer: the FORM path exercises
 * `buildPlan`, i.e. what an operator filling in the wizard produces; the IMPORT path exercises
 * `buildSubmissionPlan`, i.e. what an operator pasting a plan produces. Both are real, and a
 * report that does not distinguish them lets the reader assume the first when it was the second.
 *
 * Only the exceptions are listed. All-form is the expected state and a table of 65 identical
 * rows would bury the two that matter.
 */
function wizardPaths(report: RunReport): string[] {
	const viaImport = report.outcomes.filter(
		(o) => o.submittedVia === "wizard-import",
	);
	if (viaImport.length === 0) {
		return [];
	}
	const out = [
		"",
		"## Submitted through the wizard's IMPORT path, not the form",
		"",
		"These scenarios exercise `buildSubmissionPlan` (paste-a-plan), not `buildPlan`",
		"(fill-in-the-form), because the form cannot author them. The reason names the field.",
		"",
		"| scenario | what the form cannot author |",
		"|---|---|",
	];
	for (const o of viaImport) {
		out.push(
			`| ${o.scenario} | ${(o.wizardDivergence ?? "a different wizard (live channels have their own form)").replace(/\|/g, "\\|")} |`,
		);
	}
	return out;
}

/**
 * What the real origin measured, printed next to the constant it justifies.
 *
 * `MIN_SAMPLE_GAP_SEC = 10` decides whether the live movement checks can mean anything, and it
 * was a reasoned guess. A reviewer asked for a measurement, so the runner takes one — and it is
 * printed HERE rather than only in report.json, because a measurement nobody reads cannot
 * justify anything. Nothing branches on it: a slow origin must not become a FAIL.
 */
function originLatency(report: RunReport): string[] {
	const measured = report.outcomes.filter(
		(o) => o.firstPublishNote !== undefined,
	);
	if (measured.length === 0) {
		return [];
	}
	const out = [
		"",
		"## Origin publish latency (live)",
		"",
		"Time from the feed being up to the first playable segment appearing in the media",
		"playlist. Recorded, never gated on. Compare with MIN_SAMPLE_GAP_SEC in engine-live.ts:",
		"a sample gap below this cannot show movement.",
		"",
		"| channel | first segment after | note |",
		"|---|---|---|",
	];
	for (const o of measured) {
		out.push(
			`| ${o.scenario} | ${o.firstPublishMs !== undefined ? `${(o.firstPublishMs / 1000).toFixed(1)}s` : "not observed"} | ${(o.firstPublishNote ?? "").replace(/\|/g, "\\|")} |`,
		);
	}
	return out;
}

/**
 * The greens that verified the least, worst first — because a PASS is not a quantity.
 *
 * A scenario whose checks came back `PASS 2 · SKIP 30` is reported in exactly the same word as
 * one that came back `PASS 34 · SKIP 0`, and the first has barely touched the product. Every
 * "green over a population it could not reach" defect this harness has shipped would have shown
 * up here as a skew, so the skew is now printed next to the verdict instead of being derivable
 * only by opening report.json.
 *
 * Ranked by skipped ÷ evaluated rather than by skip count, so a big scenario with a few
 * legitimate SKIPs does not crowd out a small one that verified almost nothing.
 */
function leastTrustworthyGreens(report: RunReport): string[] {
	const ranked = report.outcomes
		.filter((o) => o.verdict === "PASS" || o.verdict === "WARN")
		.flatMap((o) => {
			const k = o.checks;
			if (!k) {
				return [];
			}
			const evaluated = k.PASS + k.WARN + k.FAIL;
			const skipped = k.SKIP;
			/**
			 * The guard is for `0 / 0`, and only that.
			 *
			 * I first wrote that dividing by zero "produces NaN" — it does not: `12 / 0` is
			 * `Infinity`, which already sorts first and already prints as ∞, so a mutation to
			 * plain division survived the test I wrote to catch it. The case that genuinely needs
			 * this is a green carrying check counts that are ALL zero — nothing evaluated and
			 * nothing skipped, which `live:measured-something` exists because the engine has
			 * really produced. `0 / 0` is NaN, a NaN comparator leaves the array in whatever order
			 * it was already in, and the most worthless green in the run lands wherever chance
			 * put it.
			 */
			const ratio =
				evaluated === 0 ? Number.POSITIVE_INFINITY : skipped / evaluated;
			return [{ scenario: o.scenario, evaluated, skipped, ratio }];
		})
		.sort((a, b) => b.ratio - a.ratio)
		.slice(0, 10);
	if (ranked.length === 0) {
		return [];
	}
	const out = [
		"",
		"## Greens that verified the least",
		"",
		"Ranked by skipped ÷ evaluated. A PASS high on this list is a scenario the harness",
		"could barely see — treat it as unverified rather than as working.",
		"",
		"| scenario | evaluated | skipped | skipped/evaluated |",
		"|---|---|---|---|",
	];
	for (const r of ranked) {
		out.push(
			`| ${r.scenario} | ${r.evaluated} | ${r.skipped} | ${r.ratio === Number.POSITIVE_INFINITY ? "∞ (nothing evaluated)" : r.ratio.toFixed(2)} |`,
		);
	}
	return out;
}

/**
 * Day count for `verify clean`, from either documented spelling.
 *
 * The doc says `verify clean --older-than <d>`; the CLI read `rest[0]`
 * positionally, so the documented form parsed to NaN and pruned everything
 * Both spellings are accepted now — the flag because
 * it is what the doc promises, the bare number because that is what the nightly
 * job and existing muscle memory use — and anything else is REFUSED rather than
 * coerced. `Number` turning a typo into NaN is exactly how this got shipped.
 */
export function parseCleanDays(
	argv: string[],
): { ok: true; days: number } | { ok: false; reason: string } {
	const DEFAULT_DAYS = 7;
	if (argv.length === 0) {
		return { ok: true, days: DEFAULT_DAYS };
	}
	const raw =
		argv[0] === "--older-than"
			? argv[1]
			: argv[0]?.startsWith("--older-than=")
				? argv[0].slice("--older-than=".length)
				: argv[0];
	if (raw === undefined) {
		return { ok: false, reason: "verify clean: --older-than needs a value" };
	}
	/**
	 * A LITERAL check, before `Number` ever sees the string.
	 *
	 * The first cut of this fix refused NaN and negatives and called itself
	 * "parsed, not coerced" — it was neither. `Number(" ")`, `Number("\t")`,
	 * `Number("\n")` and `Number("-0")` are all `0`, which is finite and not
	 * negative, so every one of them walked straight through and pruned the
	 * whole tree: `RETENTION_DAYS=" "` from a stray space in a .env is the
	 * realistic route (found in review of this very fix). `Number` also
	 * accepts `0x10` as 16 and `.5` as half a day.
	 *
	 * Whitespace is trimmed first because a shell can legitimately hand us
	 * `" 7 "`; what is refused is a string that is not a whole number of days.
	 */
	if (!/^\d+$/.test(raw.trim())) {
		return {
			ok: false,
			reason: `verify clean: "${raw}" is not a whole number of days. Use \`verify clean --older-than 7\` or \`verify clean 7\`.`,
		};
	}
	const days = Number(raw.trim());
	/**
	 * Zero is refused, not accepted as "everything older than now".
	 *
	 * Nothing in the tree passes it (the only invocation is
	 * `docker/verify-nightly.sh`, `verify clean 7`), the doc gives it no
	 * meaning, and "pruned N artefact path(s) from runs older than 0 day(s)"
	 * reads like an ordinary prune rather than the total purge it performs.
	 * These artefacts are the forensic record of PAID encodes, so a full purge
	 * should be an explicit act with its own spelling — not the value a typo
	 * lands on. No such spelling exists today; that is deliberate, and ledger
	 * #90 owns the remote-cleanup tail if one is ever wanted.
	 */
	if (days < 1) {
		return {
			ok: false,
			reason:
				"verify clean: 0 days would delete every local run, including one finished a second ago. There is no purge spelling on purpose — pass the number of days to KEEP.",
		};
	}
	return { ok: true, days };
}

/**
 * The whole `verify clean` command, argv in / effect out.
 *
 * Extracted because the CLI half of the DOC-015 fix was pinned by NOTHING: a
 * reviewer reverted `verify.ts` to the pre-fix `Number(rest[0] ?? 7)` and the
 * entire worker suite stayed green (78 files, 1249 tests), because
 * `parseCleanDays` was unit-tested hard while the one line that CALLS it was
 * not covered at all. That is the same shape as the original defect — a rule
 * that is right and a wiring that is wrong.
 *
 * Returns rather than exits so a test can assert the exit code and the message
 * without spawning a process; `verify.ts` is now a two-line adapter over it.
 */
export async function runCleanCommand(
	argv: string[],
	env: {
		VERIFY_RUN_ROOT?: string;
		VERIFY_EVIDENCE_RETENTION_DAYS?: string;
	} = {},
): Promise<{ code: number; message: string }> {
	const parsed = parseCleanDays(argv);
	if (!parsed.ok) {
		return { code: 2, message: parsed.reason };
	}
	const retentionRaw = env.VERIFY_EVIDENCE_RETENTION_DAYS?.trim() ?? "90";
	if (!/^[1-9]\d*$/.test(retentionRaw)) {
		return {
			code: 2,
			message:
				"verify clean: VERIFY_EVIDENCE_RETENTION_DAYS must be 1..3650 whole days",
		};
	}
	const evidenceRetentionDays = Number(retentionRaw);
	if (
		!Number.isSafeInteger(evidenceRetentionDays) ||
		evidenceRetentionDays > 3650
	) {
		return {
			code: 2,
			message:
				"verify clean: VERIFY_EVIDENCE_RETENTION_DAYS must be 1..3650 whole days",
		};
	}
	const removed = await cleanRuns(
		env.VERIFY_RUN_ROOT ?? "verify-runs",
		parsed.days,
		Date.now(),
		evidenceRetentionDays,
	);
	return {
		code: 0,
		message: `pruned ${removed.length} artefact path(s) from runs older than ${parsed.days} day(s); resumable evidence kept for ${evidenceRetentionDays} day(s), reports kept`,
	};
}

export async function cleanRuns(
	rootDir: string,
	days: number,
	now: number = Date.now(),
	evidenceRetentionDays = 90,
): Promise<string[]> {
	/**
	 * A nonsense bound must delete NOTHING — DOC-015.
	 *
	 * `verify.ts` read the day count positionally, so the documented form
	 * `verify clean --older-than 7` handed `Number("--older-than")` = NaN
	 * straight through. `cutoff` became NaN, `info.mtimeMs >= NaN` is FALSE for
	 * every directory, and the keep-guard below inverted into a delete-guard: an
	 * operator asking to prune runs older than seven days pruned EVERY local run,
	 * including the one from a minute ago, and got `exit 0` with a plausible
	 * count. Verify-run artefacts are the forensic record of paid encodes.
	 *
	 * The parse is fixed at the CLI (`parseCleanDays`), but the rail belongs HERE
	 * too, at the function that actually removes files: no caller — a script, a
	 * future flag, a bad env — should be able to express "delete everything" by
	 * accident. Negative is refused for the same reason: it is a cutoff in the
	 * future, which also matches everything.
	 *
	 * The bound is `< 1`, not `< 0`. The first cut of this rail wrote `< 0` and
	 * this comment already claimed the invariant above — but ZERO passed it, and
	 * zero is what `Number(" ")` and `Number("\t")` produce, so a stray space in
	 * an env var expressed exactly the accident the paragraph forbids (found in
	 * review). It also runs BEFORE the readdir, so a bad bound over a missing
	 * root refuses rather than returning an empty list.
	 */
	if (!Number.isFinite(days) || days < 1) {
		throw new Error(
			`verify clean: refusing to prune with an age bound of ${days}. A bound below 1 day matches EVERY run — including one that finished a second ago — and a non-finite one matches every run too.`,
		);
	}
	if (
		!Number.isSafeInteger(evidenceRetentionDays) ||
		evidenceRetentionDays < 1 ||
		evidenceRetentionDays > 3650
	) {
		throw new Error(
			`verify clean: refusing evidence retention of ${evidenceRetentionDays}; expected 1..3650 whole days`,
		);
	}
	const { readFile, readdir, stat } = await import("node:fs/promises");
	let entries: string[];
	try {
		entries = await readdir(rootDir);
	} catch {
		return [];
	}
	const cutoff = now - days * 24 * 60 * 60 * 1000;
	const removed: string[] = [];
	for (const entry of entries) {
		const path = join(rootDir, entry);
		const info = await stat(path).catch(() => undefined);
		if (!info?.isDirectory()) {
			continue;
		}
		// Reports are small and are the forensic record: keep them, drop the plans and
		// downloaded artefacts (design D5 — prune runs at 7 days, keep reports 90).
		if (info.mtimeMs >= cutoff) {
			continue;
		}
		let retentionUntil =
			info.mtimeMs + evidenceRetentionDays * 24 * 60 * 60 * 1000;
		try {
			const report = JSON.parse(
				await readFile(join(path, "report.json"), "utf8"),
			) as { evidence?: { retentionUntil?: unknown } };
			if (typeof report.evidence?.retentionUntil === "string") {
				const declared = Date.parse(report.evidence.retentionUntil);
				// The report is read before its HMAC is verified here, so it may extend
				// preservation but can never shorten the configured safety floor.
				if (Number.isFinite(declared)) {
					retentionUntil = Math.max(retentionUntil, declared);
				}
			}
		} catch {
			// Legacy reports have no evidence envelope; the configured default applies.
		}
		const keepResumeEvidence = now < retentionUntil;
		for (const name of await readdir(path).catch(() => [])) {
			if (name === "report.json" || name === "report.md") {
				continue;
			}
			if (
				keepResumeEvidence &&
				(name === "report.seal" ||
					/^report\.(?:json|md|seal)\.pending\.[a-f0-9]{24}$/.test(name) ||
					name.endsWith(".plan.json") ||
					name.endsWith(".report.json"))
			) {
				continue;
			}
			await rm(join(path, name), { recursive: true, force: true });
			removed.push(join(entry, name));
		}
	}
	return removed;
}

/** CLI adapter for explicit post-crash reconciliation; it never submits. */
export function formatRecoveryCommandResult(
	result: VerificationRecoveryResult,
): { code: number; message: string } {
	const details = result.lines.length > 0 ? `\n${result.lines.join("\n")}` : "";
	if (!result.authorityFenced) {
		return {
			code: 1,
			message: `verify recover: ${result.runId} performed paid-resource teardown, but could not durably fence the original producer; DB authority is unsafe${details}`,
		};
	}
	if (!result.sealable) {
		return {
			code: 1,
			message: `verify recover: ${result.runId} still has unresolved intents: ${result.unresolvedKeys.join(", ")}${details}`,
		};
	}
	if (result.reportExports === "FAILED") {
		return {
			code: 1,
			message: `verify recover: ${result.runId} closed its paid-resource intents, but canonical report export repair failed${details}`,
		};
	}
	return {
		code: 0,
		message:
			result.reportExports === "RESTORED"
				? `verify recover: ${result.runId} has no unresolved paid-resource intents and its validated SEALED report exports were restored${details}`
				: `verify recover: ${result.runId} has no unresolved paid-resource intents; original run remains INCOMPLETE${details}`,
	};
}

export async function runRecoveryCommand(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; message: string }> {
	const at = argv.indexOf("--run-id");
	const raw = at >= 0 ? argv[at + 1] : argv[0];
	if (!raw) {
		return {
			code: 2,
			message: "verify recover requires --run-id <existing-run-id>",
		};
	}
	let runId: string;
	let baseUrl: string;
	let releaseMode: boolean;
	try {
		runId = validateRunId(raw);
		const policy = resolveBaseUrl(env);
		if (!policy.ok) throw new Error(policy.reason);
		baseUrl = policy.url;
		releaseMode =
			argv.includes("--release") || env.VERIFY_RELEASE_MODE === "true";
	} catch (err) {
		return {
			code: 2,
			message: `verify recover: ${recordableError(err)}`,
		};
	}
	const prisma = createPrismaClient(env.DATABASE_URL);
	try {
		const result = await recoverVerificationRun(
			{
				prisma,
				baseUrl,
				...(env.VERIFY_PASSWORD ? { password: env.VERIFY_PASSWORD } : {}),
				...(env.VERIFY_API_TOKEN ? { apiToken: env.VERIFY_API_TOKEN } : {}),
				releaseMode,
				loadSealKeyring: () => sealKeyringFromEnv(env),
				log: (line) => console.log(`[verify:recover] ${line}`),
			},
			runId,
		);
		return formatRecoveryCommandResult(result);
	} catch (err) {
		return {
			code: 1,
			message: `verify recover failed: ${recordableError(err)}`,
		};
	} finally {
		await prisma.$disconnect();
	}
}

/**
 * `--live-msl-edge-base-url`, else `VERIFY_LIVE_MSL_EDGE_BASE_URL`
. Absent ⇒ undefined, and every MSL mirror
 * leg stays UNOBSERVED (the honest default). Present ⇒ validated by core's
 * `parseEdgeBaseUrl`: HTTPS only, no userinfo, no query or fragment, and a
 * host on the delivery allowlist (Akamai's media hostnames by default;
 * `VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS` names others on purpose). Throws on a
 * bad value so `main` refuses before anything is spent.
 */
export function resolveLiveMslEdgeBaseUrl(
	flagValue: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const raw = flagValue ?? env.VERIFY_LIVE_MSL_EDGE_BASE_URL?.trim();
	if (raw === undefined || raw === "") {
		return undefined;
	}
	const parsed = parseEdgeBaseUrl(raw, {
		allowedHosts: [
			...DEFAULT_MSL_EDGE_HOST_SUFFIXES,
			...liveMslEdgeAllowedHosts(env),
		],
	});
	if (!parsed.ok) {
		throw new Error(`--live-msl-edge-base-url: ${parsed.reason}`);
	}
	return parsed.url;
}

/** The operator's extra delivery hosts, `VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS`. */
export function liveMslEdgeAllowedHosts(env: NodeJS.ProcessEnv): string[] {
	return (env.VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Where an MSL scenario's edge base comes from (2026-09-02): the CLI flag /
 * env override when one was given, else the credential's own `edgeBaseUrl`.
 * The credential value receives the SAME pre-spend validation the flag does
 * — HTTPS, no userinfo, no query or fragment, and the delivery-host
 * allowlist — because the credential schema validated it for VIEWERS (public
 * host, shape), not for the harness's egress rail: a customer CNAME in front
 * of the stream is a fine playback link and still not somewhere this harness
 * reads unless `VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS` names it. Neither ⇒ no
 * edge base, and the mirror leg stays UNOBSERVED as it always did.
 */
export function liveMslEdgeBaseUrlForRun(args: {
	override: string | undefined;
	credentialEdgeBaseUrl: unknown;
	allowedHosts: readonly string[] | undefined;
}):
	| { ok: true; url: string; source: "flag" | "credential" }
	| { ok: true; url: undefined; source: "none" }
	| { ok: false; reason: string } {
	if (args.override !== undefined && args.override !== "") {
		return { ok: true, url: args.override, source: "flag" };
	}
	const declared =
		typeof args.credentialEdgeBaseUrl === "string"
			? args.credentialEdgeBaseUrl.trim()
			: "";
	if (declared === "") {
		return { ok: true, url: undefined, source: "none" };
	}
	const parsed = parseEdgeBaseUrl(declared, {
		allowedHosts: [
			...DEFAULT_MSL_EDGE_HOST_SUFFIXES,
			...(args.allowedHosts ?? []),
		],
	});
	if (!parsed.ok) {
		return {
			ok: false,
			reason: `the credential's edgeBaseUrl cannot be read by this harness — ${parsed.reason}; pass --live-msl-edge-base-url to override it`,
		};
	}
	return { ok: true, url: parsed.url, source: "credential" };
}

/**
 * `--live-msl-edge-allowed-roots`, else
 * `VERIFY_LIVE_MSL_EDGE_ALLOWED_ROOTS`. These are the only cross-origin URL
 * prefixes a manifest walk may follow. Each comma-separated entry receives
 * the same pre-spend validation as the primary edge base; the resolver then
 * enforces the root boundary after normal URL resolution.
 */
export function resolveLiveMslEdgeAllowedRoots(
	flagValue: string | undefined,
	env: NodeJS.ProcessEnv,
): string[] {
	const raw = flagValue ?? env.VERIFY_LIVE_MSL_EDGE_ALLOWED_ROOTS?.trim();
	if (raw === undefined || raw === "") {
		return [];
	}
	const extra = liveMslEdgeAllowedHosts(env);
	const roots = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const parsed = parseEdgeBaseUrl(entry, {
				allowedHosts: [...DEFAULT_MSL_EDGE_HOST_SUFFIXES, ...extra],
			});
			if (!parsed.ok) {
				throw new Error(`--live-msl-edge-allowed-roots: ${parsed.reason}`);
			}
			return parsed.url;
		});
	return [...new Set(roots)];
}

/** Exact worker image identity for the versioned live evidence tuple. */
export function resolveLiveEvidenceImage(
	flagValue: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const raw =
		flagValue ??
		env.VERIFY_LIVE_EVIDENCE_IMAGE?.trim() ??
		env.BITOVP_IMAGE?.trim();
	if (raw === undefined || raw === "") {
		return undefined;
	}
	if (!/(?:^|@)sha256:[0-9a-f]{64}$/i.test(raw)) {
		throw new Error(
			"--live-evidence-image must be an immutable sha256 digest (sha256:<64 hex> or image@sha256:<64 hex>)",
		);
	}
	return raw;
}

/** CLI: `verify run [--dry-run] [--only a,b] [--concurrency N]`. */
export async function main(argv: string[]): Promise<number> {
	const flag = (name: string): string | undefined => {
		const at = argv.indexOf(`--${name}`);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	/**
	 * Every argument is validated BEFORE anything is spent (* HIGH-11): a run id that is not a path segment, a cap or timeout that does
	 * not parse, a base URL that would carry the credential in the clear — each
	 * used to fail OPEN (`Number("x")` is NaN, and NaN caps nothing).
	 */
	let runId: string;
	let baseUrl: string;
	let concurrency: number;
	let perScenarioTimeoutMs: number;
	let maxSubmits: number | undefined;
	let liveFeedSeconds: number | undefined;
	let liveStartTimeoutSec: number | undefined;
	let liveEncoderVersion: string | undefined;
	let liveMslEdgeBaseUrl: string | undefined;
	let liveMslEdgeAllowedRoots: string[];
	let liveEvidenceImage: string | undefined;
	let sealKeyring: ReturnType<typeof sealKeyringFromEnv>;
	let evidenceRetentionDays: number;
	let releaseMode: boolean;
	let only: string[] | undefined;
	const dryRun = argv.includes("--dry-run");
	const injectPostCreateResponseLoss = argv.includes(
		"--inject-post-create-response-loss",
	);
	try {
		runId = validateRunId(
			flag("run-id") ??
				defaultRunId(new Date(), () => randomBytes(3).toString("hex")),
		);
		// Shared with `verify smoke` (review of this PR): the policy and the env
		// reads it depends on live in ONE function, so no command can grow its
		// own copy of "where may this credential go".
		const policy = resolveBaseUrl(process.env);
		if (!policy.ok) {
			throw new Error(policy.reason);
		}
		baseUrl = policy.url;
		concurrency = positiveInt("concurrency", flag("concurrency"), 3);
		perScenarioTimeoutMs = positiveInt(
			"timeout-ms",
			flag("timeout-ms"),
			15 * 60 * 1000,
		);
		maxSubmits = flag("max-submits")
			? positiveInt("max-submits", flag("max-submits"), 0)
			: undefined;
		only = flag("only") ? (flag("only") as string).split(",") : undefined;
		liveFeedSeconds = flag("live-feed-seconds")
			? positiveInt("live-feed-seconds", flag("live-feed-seconds"), 0)
			: undefined;
		liveStartTimeoutSec = flag("live-start-timeout")
			? positiveInt("live-start-timeout", flag("live-start-timeout"), 0)
			: undefined;
		if (argv.includes("--live-encoder-version")) {
			liveEncoderVersion = validateLiveEncoderVersion(
				flag("live-encoder-version") ?? "",
			);
		}
		// The MSL delivery edge: the flag,
		// else the dedicated env; validated — HTTPS, no query/userinfo, an
		// allowed host — before anything is spent, like every other argument.
		liveMslEdgeBaseUrl = resolveLiveMslEdgeBaseUrl(
			flag("live-msl-edge-base-url"),
			process.env,
		);
		liveMslEdgeAllowedRoots = resolveLiveMslEdgeAllowedRoots(
			flag("live-msl-edge-allowed-roots"),
			process.env,
		);
		liveEvidenceImage = resolveLiveEvidenceImage(
			flag("live-evidence-image"),
			process.env,
		);
		releaseMode =
			argv.includes("--release") || process.env.VERIFY_RELEASE_MODE === "true";
		sealKeyring = sealKeyringFromEnv(process.env);
		evidenceRetentionDays = positiveInt(
			"evidence-retention-days",
			flag("evidence-retention-days") ??
				process.env.VERIFY_EVIDENCE_RETENTION_DAYS,
			90,
		);
		// Force the HMAC/key-id validation into the pre-spend CLI phase too.
		evidenceSealPolicy({
			releaseMode,
			keyring: sealKeyring,
			retentionDays: evidenceRetentionDays,
		});
		validatePostCreateResponseLossCanary({
			enabled: injectPostCreateResponseLoss,
			only,
			maxSubmits,
			dryRun,
			resumeFrom: flag("resume-from"),
		});
	} catch (err) {
		console.error(
			`[verify] refusing to start: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 2;
	}
	const prisma = createPrismaClient(process.env.DATABASE_URL);
	try {
		const report = await runVerification({
			prisma,
			baseUrl,
			...(process.env.VERIFY_BITMOVIN_ACCOUNT_ID
				? { bitmovinAccountId: process.env.VERIFY_BITMOVIN_ACCOUNT_ID }
				: {}),
			...(process.env.VERIFY_PASSWORD
				? { password: process.env.VERIFY_PASSWORD }
				: {}),
			...(process.env.VERIFY_API_TOKEN
				? { apiToken: process.env.VERIFY_API_TOKEN }
				: {}),
			...storageEnv(),
			runDir: join(process.env.VERIFY_RUN_ROOT ?? "verify-runs", runId),
			runId,
			ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
			concurrency,
			perScenarioTimeoutMs,
			...(only ? { only } : {}),
			...(maxSubmits !== undefined ? { maxSubmits } : {}),
			...(flag("resume-from")
				? { resumeFrom: flag("resume-from") as string }
				: {}),
			releaseMode,
			sealKeyring,
			evidenceRetentionDays,
			dryRun,
			injectPostCreateResponseLoss,
			livePublicRead: argv.includes("--live-public-read"),
			...(flag("vmaf-model") ? { vmafModel: flag("vmaf-model") } : {}),
			// Live is opt-in: each scenario costs encoder minutes, so an ad-hoc run does not
			// get it by accident and the nightly job asks for it explicitly.
			...(liveFeedSeconds !== undefined ? { liveFeedSeconds } : {}),
			...(liveStartTimeoutSec !== undefined ? { liveStartTimeoutSec } : {}),
			...(liveEncoderVersion !== undefined ? { liveEncoderVersion } : {}),
			...(liveMslEdgeBaseUrl !== undefined ? { liveMslEdgeBaseUrl } : {}),
			// The same extra hosts the flag was checked against, for the
			// credential-declared edge base that is only known per scenario.
			liveMslEdgeAllowedHosts: liveMslEdgeAllowedHosts(process.env),
			...(liveMslEdgeAllowedRoots.length > 0
				? { liveMslEdgeAllowedRoots }
				: {}),
			...(liveEvidenceImage !== undefined ? { liveEvidenceImage } : {}),
			log: (line) => console.log(`[verify] ${line}`),
		});
		console.log("");
		console.log(formatRunReport(report));
		// FAIL is a product defect; INVALID is ours. Both must fail the run.
		return report.counts.FAIL + report.counts.INVALID;
	} finally {
		await prisma.$disconnect();
	}
}

export type { Capability };
/** Exposed for the tests: the scenario corpus without touching a database. */
export { loadScenarios };
