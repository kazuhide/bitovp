/**
 * `verify live` — drive a live scenario end to end, through the product's own API.
 *
 * Same principle as the VOD runner and for the same reason: it POSTs to
 * `/api/live-channels` and `/api/feeder-sessions`, the endpoints the wizard uses, because
 * calling the live orchestrator directly would verify Bitmovin rather than this product —
 * and it is the product's compiler, queue and step log that keep breaking.
 *
 * The live loop is longer than the VOD one and every stage can legitimately take minutes:
 *
 *   create      POST the plan, get a channel id
 *   start       queue the start action; the worker provisions and awaits RUNNING
 *   coordinates read back the stream key / encoder ip the channel handed out
 *   feed        POST a feeder session pointed at those coordinates (RTMP or SRT-caller)
 *   sample      at least twice, at least MIN_SAMPLE_GAP_SEC apart — the movement checks
 *               are the point of the whole tier and a single sample cannot make them
 *   stop        stop the feeder, then the channel
 *   roll        POST live-to-VOD and await its own terminal state
 *   verify      hand everything to `verifyLiveChannel`
 *
 * Two things this deliberately does NOT do:
 *
 * It does not clean up on a FAIL. A channel left RUNNING costs money, so it stops the
 * channel in a `finally` — but it leaves the OUTPUT in place, because the artefacts are
 * the evidence and deleting them on failure would make the report unreproducible.
 *
 * It does not treat an unfeedable ingest as a skip of the whole scenario. SRT-listener and
 * Zixi channels still provision, still hand back coordinates and still emit heartbeats,
 * and those are real checks worth running — `fed: false` reaches the engine, which turns
 * only the movement assertions into named SKIPs ( §4, live row).
 */

import {
	compileExpectedLiveArtefacts,
	type ExpectedLiveArtefacts,
	edgeUrlPolicy,
	type LiveChannelPlan,
	type LiveEvidenceLeg,
	liveChannelPlanSchema,
	mapDestinations,
	mslPlaybackEventPath,
	redactUrl,
	STATIC_INGEST_URL,
	VERIFICATION_KEY_SHA_CONFLICT,
	type VerificationDispatchFence,
	verificationCreateErrorCode,
	verificationKeyLabel,
	verificationRequestSha256,
} from "@bitovp/core";
import {
	type EdgeRead,
	type LiveEdgeClosure,
	type LiveEdgeRequirements,
	observeEdgeLeg,
	sha256Hex,
} from "./edge-resolver";
import type { Check } from "./engine";
import { resolveReferencedKey, type VerificationReport } from "./engine";
import {
	type LiveAfterStop,
	type LiveSample,
	MIN_SAMPLE_GAP_SEC,
	verifyLiveChannel,
} from "./engine-live";
import { awaitStatus } from "./harness-rails";
import type { ArchiveCheckInput } from "./live-archive-runtime";
import {
	finalizeLiveCleanupSeal,
	type LiveCleanupFeeder,
	type LiveCleanupSeal,
	liveCleanupSeal,
} from "./live-cleanup-seal";
import {
	assembleLiveEvidence,
	providerTerminalFromIntentDossier,
} from "./live-evidence-assembly";
import {
	classifySendFailure,
	type IntentHandle,
	type IntentTerminalInput,
	mergeIntentTerminalInputs,
	verificationLocalResourceKey,
	verificationProviderEncodingKey,
} from "./resource-intent";
import {
	noteCanaryAdoption,
	noteCanaryCreatePost,
	type PostCreateResponseLossCanaryState,
	shouldInjectPostCreateResponseLoss,
} from "./response-loss-canary";

/** Everything the runner needs from the outside world. */
export type LiveRunnerDeps = {
	verifyArchives?: (input: ArchiveCheckInput) => Promise<Check[]>;
	/** Authenticated fetch against the product, as an operator would. */
	api: (
		path: string,
		init?: { method?: string; body?: unknown },
	) => Promise<{ status: number; json: unknown }>;
	/** Read an object's text from storage — the live playlist. */
	readText: (outputKey: string, key: string) => Promise<string>;
	/** List objects under a prefix. */
	listAll: (
		outputKey: string,
		prefix: string,
	) => Promise<{ key: string; size?: number }[]>;
	/** Sleep, injected so tests do not wait minutes of wall clock. */
	sleep: (ms: number) => Promise<void>;
	/** Now, injected for the same reason. */
	now: () => number;
	/** Progress, so a long run is not a silent one. */
	log?: (line: string) => void;
	/**
	 * GET a URL from the Akamai delivery EDGE, for MSL delivery-leg closure
	 * . Distinct from `readText`: MSL is
	 * Akamai's INGEST, not readable storage, so the mirror is observed on the
	 * public delivery URL instead. Absent = no HTTP reader wired, so every MSL
	 * mirror leg stays UNOBSERVED (a SKIP that cannot pass the run).
	 */
	readEdge?: (url: string) => Promise<EdgeRead>;
	/** Extra absolute roots a manifest reference may resolve into (policy). */
	edgeAllowedRoots?: readonly string[];
};

/**
 * The subset a teardown needs — the product API and a clock, no storage
 * readers — so the run-level intent teardown (EV-01) can stop and seal an
 * adopted channel without constructing artefact readers it will never use.
 */
export type LiveApiDeps = Pick<LiveRunnerDeps, "api" | "sleep" | "now" | "log">;

export type LiveRunOptions = {
	/** The plan to run, as authored in a fixture. */
	plan: unknown;
	/** Scenario name, for the report. */
	scenario: string;
	/** Source object the feeder pushes, when this ingest is feedable. */
	feed?: {
		credentialId: string;
		bucket: string;
		key: string;
	};
	/** How long to keep feeding before stopping. Must clear the sample gap. */
	feedSeconds: number;
	/** How long to wait for RUNNING before giving up. */
	startTimeoutSec: number;
	/**
	 * Where to point the fixture. Required, because a fixture submitted verbatim is a
	 * guaranteed HTTP 400 — no live fixture carries `bitmovin.accountId` and the API
	 * demands one — and because unrewritten outputs write somewhere this file does not read.
	 */
	rewrite: {
		bitmovinAccountId: string;
		credentialId: string;
		outputBucket: string;
		prefix: string;
		// The optional halves used to ride in via spreads, which dodge TS's
		// excess-property check — the type claimed a narrower contract than
		// the calls used (found when channelName was added directly, 2026-08-23).
		publicRead?: boolean;
		akamaiStorage?: { credentialId: string; bucket: string };
		/**
		 * `edgeBaseUrl` : the Akamai DELIVERY
		 * base URL the MSL stream is served from — the read-back address for the
		 * mirror-leg closure. It is NOT the ingest the output writes to, and it is
		 * NOT in the plan (a CDN property is account/config, not a plan literal).
		 * Absent ⇒ the mirror stays UNOBSERVED and the run cannot pass on the
		 * origin alone.
		 */
		akamaiMsl?: LiveMslCredentialTarget;
		channelName?: string;
	};
	/**
	 * The durable-intent hooks. When
	 * wired, the runner commits PREPARED and SUBMITTED BEFORE the create POST,
	 * sends the key with the request, classifies a create-time failure
	 * (before-send vs ambiguous), adopts a channel the product created by its
	 * key when the response was lost, and closes the intent with the cleanup
	 * seal in `finally`. Absent only in tests of the pre-existing loop.
	 */
	intent?: LiveIntentHooks;
	/**
	 * What the evidence tuple binds the run TO
	 * the exact commit / image, and the fed source's version identity.
	 * Absent (unit tests) ⇒ the tuple names them as missing, never guesses.
	 */
	evidence?: { commit: string; image?: string };
	/** Public, one-shot audit canary; CLI rails guarantee one selected paid scenario. */
	postCreateResponseLossCanary?: PostCreateResponseLossCanaryState;
};

export type LiveIntentHooks = {
	/** `verify:<runId>:<scenario>:LIVE_CHANNEL`, derived by the caller. */
	key: string;
	/** Commit PREPARED — HARD: a throw means the runner does NOT POST. */
	prepare: (input: {
		requestSha256: string;
		resourceName: string;
	}) => Promise<IntentHandle>;
	/**
	 * Resolve the complete provider marker set after product teardown. Production
	 * always wires this to the shared normal/restart resolver; optional only for
	 * focused runner-loop tests that have no provider account seam.
	 */
	resolveTerminal: (
		channelId: string,
		product: {
			stopFailures: readonly string[];
			cleanup: LiveCleanupSeal;
			providerId?: string;
		},
	) => Promise<Parameters<IntentHandle["terminal"]>[0]>;
};

export type LiveRunResult = {
	scenario: string;
	channelId?: string;
	report?: VerificationReport;
	/** Exact plan sent to the product, retained for EV-03 evidence binding. */
	submittedPlan?: LiveChannelPlan;
	/** Set when the run could not get far enough to verify anything. */
	invalid?: string;
	/**
	 * How long the real origin took to publish its first playable segment.
	 *
	 * Recorded because `MIN_SAMPLE_GAP_SEC` was a reasoned guess and a reviewer asked the right
	 * question: it decides whether the movement checks can mean anything, so it should be a
	 * measurement. `ms` is absent when nothing published within the cap — deliberately not the
	 * cap and not zero, because "we never saw it" is not a latency.
	 */
	firstPublish?: { ms?: number; polls: number; note: string };
	/**
	 * The durable teardown seal: provider
	 * terminal, local terminal, feeder `processGoneAt`, host process gone and
	 * queue drained, in one artefact. `clean` false ⇒ the run is NOT a success
	 * (`outcomeFromLiveResult` seals it INVALID). Present whenever a channel was
	 * created; absent only on a create-time fault.
	 */
	cleanup?: LiveCleanupSeal;
	/**
	 * The evidence TUPLE, one leg per (manifest, delivery target)
	 * build → source → channel → output → master →
	 * children → media → two probes → progression → provider terminal →
	 * cleanup, each leg sealed by core's completeness rule. Present whenever
	 * the run reached its samples; `outcomeFromLiveResult` refuses a PASS whose
	 * legs are not all complete.
	 */
	evidence?: LiveEvidenceLeg[];
};

export type PreparedLiveScenario = {
	submitted: LiveChannelPlan;
	expected: ExpectedLiveArtefacts;
	mslOutputs: BoundLiveMslOutput[];
};

/**
 * Credential-safe identity of one AKAMAI_MSL output before the provider
 * resource exists. The Digest publishing secret is deliberately absent.
 */
export type BoundLiveMslOutput = {
	outputKey: string;
	credentialId: string;
	streamId: number;
	eventName: string;
	streamFormat: "HLS" | "DASH" | "CMAF";
	mslVersion: string;
	/** Exact delivery event root, when edge verification was configured. */
	eventRoot?: string;
};

export type LiveMslCredentialTarget = {
	credentialId: string;
	streamId: number;
	eventName: string;
	edgeBaseUrl?: string;
};

/**
 * Join the selected vault credential to every exact MSL output in the
 * rewritten plan. A supplied delivery URL must name THIS credential's event
 * root; an old event, another stream id, or the wrong format is refused before
 * the channel POST can spend provider minutes.
 */
export function bindLiveMslOutputs(
	plan: LiveChannelPlan,
	target: LiveMslCredentialTarget | undefined,
): BoundLiveMslOutput[] {
	const outputs = plan.outputs.filter((output) => output.kind === "AKAMAI_MSL");
	if (outputs.length === 0) {
		return [];
	}
	if (!target) {
		return [];
	}
	return outputs.map((output) => {
		if (output.credentialId !== target.credentialId) {
			throw new Error(
				`MSL output ${output.key} names credential ${output.credentialId}, not selected credential ${target.credentialId}`,
			);
		}
		const expectedPath = mslPlaybackEventPath(
			output.streamFormat,
			target.streamId,
			target.eventName,
		);
		let eventRoot: string | undefined;
		if (target.edgeBaseUrl) {
			const parsed = new URL(target.edgeBaseUrl);
			if (parsed.pathname !== expectedPath) {
				throw new Error(
					`MSL edge root ${parsed.origin}${parsed.pathname} does not match credential streamId ${target.streamId}, eventName ${target.eventName}, streamFormat ${output.streamFormat}; expected ${parsed.origin}${expectedPath}`,
				);
			}
			eventRoot = `${parsed.origin}${expectedPath}`;
		}
		return {
			outputKey: output.key,
			credentialId: target.credentialId,
			streamId: target.streamId,
			eventName: target.eventName,
			streamFormat: output.streamFormat,
			mslVersion: output.mslVersion,
			...(eventRoot ? { eventRoot } : {}),
		};
	});
}

/** Poll interval while awaiting a terminal or running state. */
/** How long a channel may sit in STOPPING before the run calls it a leak. */
const STOP_CONFIRM_MS = 5 * 60 * 1000;

/**
 * How long the cleanup seal waits for its elements to become POSITIVELY true
 * before it gives up and seals INVALID.
 *
 * The channel-stop confirmation and the feeder stop's kill ladder run before
 * this — the feeder stop is enqueued at the top of teardown and the channel
 * stop polls STOPPED for minutes — so `processGoneAt` and a drained queue are
 * usually already true when the seal is first read. This is the backstop for
 * the residual gap between "channel STOPPED" and "the pid was proven gone",
 * and re-reading is what makes a partial teardown resumable into a clean seal.
 */
const CLEANUP_SEAL_BUDGET_MS = 90 * 1000;
const POLL_MS = 5_000;

/**
 * Read `#EXT-X-MEDIA-SEQUENCE` and the segment count from a live media playlist.
 *
 * Returns `undefined` for either field it cannot find rather than guessing a zero: a
 * missing sequence number and a sequence number of zero are different facts, and the
 * engine's SKIP arm depends on being able to tell them apart.
 */
export function readLivePlaylist(text: string): {
	mediaSequence?: number;
	segments?: number;
} {
	const seq = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
	const segments = text.match(/^#EXTINF:/gm)?.length;
	return {
		...(seq?.[1] !== undefined ? { mediaSequence: Number(seq[1]) } : {}),
		...(segments !== undefined ? { segments } : {}),
	};
}

/**
 * Point a live fixture at the harness's own account, credential, bucket and namespace.
 *
 * Without this every live scenario is guaranteed HTTP 400: **no live fixture carries
 * `bitmovin.accountId`**, and `/api/live-channels` requires it. The phase-B runner rewrote
 * VOD plans and the live branch returned before reaching that code, so the tier could never
 * have created a single channel — a review found it before the first real run, which is the
 * whole argument for reviewing a runner rather than running it.
 *
 * The output rewrite matters for the same reason it does on the VOD side: fixtures point at
 * `sample-output-bucket` with a placeholder credential, and the reads in this file go to
 * `config.outputBucket`. Left unrewritten, the channel would write one place and the
 * verifier would look in another.
 *
 * And the per-run prefix is not cosmetic. Live output paths are static, the runner
 * deliberately never cleans up, and `live:segments` compares two listings — so without a
 * namespace the prefix accumulates across nightly runs until every count is identical and
 * the check fails on a healthy channel.
 */

/**
 * Is this destination an AKAMAI_MSL manifest path — the event-root shape the
 * run-prefix must NOT touch ?
 *
 * The MSL contract (LIVE_MSL_MANIFEST_PATH, C31, row 220) constrains only
 * the MANIFEST path on an MSL output: EMPTY, or a leading-and-trailing slash.
 * The muxing (segment) destinations on the same output carry real folders and
 * DO get the prefix; this exempts exactly the manifest-path shape so a direct
 * MSL fixture stays valid instead of dying on the harness's own rewrite. The
 * regex mirrors the validator's `p === "" || /^\/.+\/$/` byte-for-byte, so the
 * two cannot drift.
 */
function isMslManifestPathDest(
	dest: { outputKey: string; path: string },
	mslOutputKeys: ReadonlySet<string>,
): boolean {
	return (
		mslOutputKeys.has(dest.outputKey) &&
		(dest.path === "" || /^\/.+\/$/.test(dest.path))
	);
}

export function validateLiveEncoderVersion(version: string): string {
	if (!/^(STABLE|BETA|\d+\.\d+\.\d+)$/.test(version)) {
		throw new Error("live encoder version must be STABLE, BETA or x.y.z");
	}
	return version;
}

export function rewriteLiveForRun(
	plan: LiveChannelPlan,
	options: {
		bitmovinAccountId: string;
		/** Explicit version for a provider capability canary; fixtures stay immutable. */
		encoderVersion?: string;
		credentialId: string;
		outputBucket: string;
		/**
		 * The GENERIC_S3 family's live target (Akamai/OCI object storage) —
		 * credential + ITS OWN bucket. Absent ⇒ GENERIC_S3 outputs stay as
		 * authored and the AKAMAI capability gate reports them.
		 */
		akamaiStorage?: { credentialId: string; bucket: string };
		/**
		 * The AKAMAI_MSL family's live target — provisioning-config credential
		 * (streamId + eventName live in its config). Absent ⇒ MSL outputs stay
		 * as authored and the AKAMAI_MSL capability gate reports them.
		 * `edgeBaseUrl` is unused by the rewrite; the runner reads it to verify
		 * delivery-mirror legs on the edge.
		 */
		akamaiMsl?: LiveMslCredentialTarget;
		/** UC-numbered channel name (uc{NN}-{scenario}); overrides the fixture name. */
		channelName?: string;
		/** `verify/<runId>/<scenario>/` — every artefact goes under it. */
		prefix: string;
		/** The run's own budget, which the forced auto-shutdown is computed from. */
		startTimeoutSec: number;
		feedSeconds: number;
		/**
		 * Force `acl: PUBLIC_READ` on every destination, so the run's output is
		 * playable in a browser .
		 *
		 * Opt-in and off by default: the live FIXTURES carry no ACL, deliberately —
		 * they mirror encoding examples, where publishing is the operator's decision.
		 * A verification run of a *player* needs the opposite, so it asks. The
		 * bucket it writes to is the harness's own output bucket under
		 * `verify/<runId>/`, never a production origin.
		 */
		publicRead?: boolean;
	},
): LiveChannelPlan {
	const next = structuredClone(plan) as Record<string, unknown>;

	(next.bitmovin as Record<string, unknown>).accountId =
		options.bitmovinAccountId;
	if (options.encoderVersion !== undefined) {
		(next.bitmovin as Record<string, unknown>).encoderVersion =
			validateLiveEncoderVersion(options.encoderVersion);
	}

	// Test-channel naming (owner item 3): UC-numbered, lowercase, consistent
	// with the VOD jobs. Absent (unit tests) keeps the fixture name.
	if (options.channelName) {
		next.name = options.channelName;
	}

	/**
	 * Family-scoped repoint (review-290 I3, closed 2026-08-23 the night MSL was
	 * first provisioned — exactly the trigger that review predicted). The old
	 * loop overwrote EVERY output's credentialId with the S3 credential and
	 * every bucket with the S3 bucket, which clobbers an AKAMAI_MSL output's
	 * credential (provider assert kills it at exec-io) and points a GENERIC_S3
	 * output at a bucket its credential cannot sign for. Same rule as the VOD
	 * rewrite: a repoint may only point a credential at one of the SAME
	 * provider family; a family with no registered target stays as authored
	 * and its capability gate reports it.
	 */
	for (const output of (next.outputs ?? []) as Record<string, unknown>[]) {
		const kind = output.kind as string;
		if (kind === "S3" || kind === "S3_ROLE") {
			if ("credentialId" in output) {
				output.credentialId = options.credentialId;
			}
			if ("bucket" in output) {
				output.bucket = options.outputBucket;
			}
			continue;
		}
		if (kind === "GENERIC_S3" && options.akamaiStorage) {
			output.credentialId = options.akamaiStorage.credentialId;
			if ("bucket" in output) {
				output.bucket = options.akamaiStorage.bucket;
			}
			continue;
		}
		if (kind === "AKAMAI_MSL" && options.akamaiMsl) {
			output.credentialId = options.akamaiMsl.credentialId;
		}
		// Any other family (or a family with no target): as authored.
	}

	/**
	 * Owner-namespaced ids on the INPUT, which the first version left entirely.
	 *
	 * A review enumerated them and two are on runnable scenarios, so all of these would have
	 * failed tonight for reasons that are not the product's:
	 *
	 *   SRT `credentialId`   the ingest passphrase. Stripped WITH `keyLength`, because
	 *                        `refineSrtConnection` requires them together — and the
	 *                        passphrase is not what an SRT scenario verifies, SRT ingest is.
	 *   `inputId`            a pinned input that does not exist in the harness account.
	 *                        Stripped so the executor falls back to its documented
	 *                        resolve-by-list contract.
	 *   ESAM POIS ids        stripped for the same reason; the scenario is gated on CAP_POIS
	 *                        anyway, so this only stops it failing for the wrong reason if a
	 *                        POIS is ever registered.
	 *
	 * `staticIpId` and `infrastructure` are deliberately NOT stripped. Removing them turns
	 * `live-static-ip` into a byte-identical duplicate of `live-rtmp-simple` — a scenario
	 * that verifies static IP by not using static IP, which is the named-slot pattern in a
	 * new costume. C18 also binds them to `cloudRegion: "EXTERNAL"` in both directions, so
	 * stripping one means rewriting the region too. It is gated on `LIVE_INFRA` instead: a
	 * named SKIP is honest, a green run that tested nothing is not.
	 */
	const input = next.liveInput as Record<string, unknown>;
	if (input.kind === "SRT") {
		// SRT only. Zixi's `credentialId` is REQUIRED by its schema, so stripping it makes
		// the plan invalid — which my own re-parse caught immediately, and which is the
		// argument for re-parsing rather than trusting a rewrite. Zixi is gated on CAP_ZIXI
		// regardless, so the owner's real credential is what would open it.
		delete input.credentialId;
		delete input.keyLength;
	}
	delete input.inputId;
	const start = (next.start ?? {}) as Record<string, unknown>;
	next.start = start;
	if (start.esam !== undefined) {
		const esam = start.esam as Record<string, unknown>;
		delete esam.poisCredentialId;
	}

	/**
	 * FORCE a short auto-shutdown on every verification channel. The owner's idea, and the
	 * evidence is unambiguous.
	 *
	 * Four live encodings billed for up to 7h19m after our teardown reported STOPPED, and what
	 * each fixture declared predicted exactly how long each one survived:
	 *
	 *   live-redundant-rtmp   no autoShutdown at all                      → 7h01m and 7h19m
	 *   live-srt-listener     waitingForFirstConnectTimeoutMinutes only   → 7h19m
	 *   live-rtmp-simple      bytesRead 3600s + streamTimeout 720min      → 2h31m
	 *
	 * A 12-hour cap is a production value. A verification channel is alive for provisioning plus a
	 * feed plus sampling — twenty minutes at the outside — so the cap is computed from the run's
	 * OWN budget and overrides whatever the fixture says. Fixtures keep their production values;
	 * only the run is capped, because this is about the harness not leaking, not about changing
	 * what the scenarios describe.
	 *
	 * It is a NET, not the mechanism: teardown still stops every encoding it knows about and
	 * confirms each one. Two independent things now have to fail before a channel outlives its run,
	 * and the second one costs minutes instead of hours.
	 */
	const budgetSec = options.startTimeoutSec + options.feedSeconds;
	start.autoShutdown = {
		// +5 minutes of slack for sampling, the stop, and the live-to-VOD roll.
		streamTimeoutMinutes: Math.max(5, Math.ceil(budgetSec / 60) + 5),
		/**
		 * A channel that never gets its first connect must not sit waiting.
		 *
		 * Derived from the same start timeout the runner gives up on, +1 so the runner's own
		 * verdict is what a reader sees rather than a Bitmovin-side shutdown racing it.
		 * The provider requires at least five minutes; the runner's wait remains independently
		 * bounded by startTimeoutSec when that budget is shorter.
		 */
		waitingForFirstConnectTimeoutMinutes: Math.max(
			5,
			Math.ceil(options.startTimeoutSec / 60) + 1,
		),
		/**
		 * And a data-silence cap, deliberately generous.
		 *
		 * The feed starts right after RUNNING and the origin's first segment was measured at
		 * 31.8s–131.3s, so a short value here would kill a healthy channel mid-provisioning. Five
		 * minutes is far below the 3600s the fixtures carry and far above anything a working run
		 * produces.
		 */
		bytesReadTimeoutSeconds: 300,
	};

	/**
	 * The AKAMAI_MSL output keys, so the MSL manifest-path exemption below knows
	 * which destinations carry the empty/slash contract
	 * . Read AFTER the credential rewrite, which leaves every
	 * output's `kind` intact.
	 */
	const mslOutputKeys = new Set(
		((next.outputs ?? []) as { key?: unknown; kind?: unknown }[])
			.filter((o) => o.kind === "AKAMAI_MSL")
			.map((o) => o.key)
			.filter((k): k is string => typeof k === "string"),
	);

	// A PREFIX, not a replacement: the internal structure — per-rendition folders, the
	// `video/`/`audio/` split, the manifest's own directory — has to survive, or the
	// expectations and the artefacts stop describing the same tree. Expressed over the
	// shared structural walk (review-284 N1): the hand-listed muxings+liveManifests loop
	// this replaces was blind to any destination site off its list.
	const rebased = mapDestinations(next, (dest) => ({
		...dest,
		// an AKAMAI_MSL manifest path is the
		// EVENT ROOT — EMPTY, or leading-and-trailing slash (LIVE_MSL_MANIFEST_PATH,
		// C31, row 220). Prepending the run prefix turned `""` into a non-empty,
		// non-slash path the validator rejects, so a DIRECT MSL fixture died on the
		// harness's own invalid path before the product ever ran. Segments (muxing
		// dests) still get the prefix — only the MSL manifest-path shape is exempt.
		path: isMslManifestPathDest(dest, mslOutputKeys)
			? dest.path
			: `${options.prefix}${dest.path.replace(/^\/+/, "")}`,
		// Manifests AND segments: a public manifest over private segments fails
		// after the manifest loads, which is the confusing half of the problem.
		...(options.publicRead ? { acl: "PUBLIC_READ" } : {}),
	}));

	// Re-parsed, so a rewrite that produced an invalid plan fails here rather than as an
	// opaque 400 from the API.
	return liveChannelPlanSchema.parse(rebased);
}

/**
 * The first variant URI in an HLS master, or `undefined` when there is none.
 *
 * The line AFTER an `#EXT-X-STREAM-INF` tag, skipping blanks and comments — which is how
 * the format defines it. `undefined` rather than a guessed name, because a master with no
 * variants is a finding and inventing one would hide it.
 */
export function firstVariantUri(master: string): string | undefined {
	const lines = master.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i]?.startsWith("#EXT-X-STREAM-INF")) {
			continue;
		}
		for (let j = i + 1; j < lines.length; j++) {
			const candidate = lines[j]?.trim();
			if (candidate === undefined || candidate === "") {
				continue;
			}
			if (candidate.startsWith("#")) {
				break;
			}
			return candidate;
		}
	}
	return undefined;
}

/** One observation of the running channel. */
/**
 * How long the real origin takes to publish its first playable segment.
 *
 * `MIN_SAMPLE_GAP_SEC = 10` was a reasoned guess, and a reviewer's ask was the right one: it
 * governs whether the movement checks can mean anything, so it should be a measurement. This
 * polls the media playlist from the moment the feed is up until a segment appears, and the
 * number lands in the run report next to the constant it justifies.
 *
 * Returns `undefined` when nothing published within the cap — deliberately not zero and not the
 * cap itself, because "we never saw it" and "it took 120s" are different facts and only one of
 * them is a latency.
 */
/**
 * Read every declared manifest FILE and parse what it enumerates.
 *
 * The engine reads only the HLS media playlist through `samples`, which is right for movement and
 * left the manifests themselves unchecked — `live-srt-listener` writes a `stream.mpd` that a
 * bucket listing plainly shows, and nothing verified it. "Live DASH works" rested on my having
 * seen a filename.
 *
 * Parsed with the same `mpd-parser` / `m3u8-parser` the VOD side uses (D1), so a manifest a real
 * player would reject fails here too. A read or parse failure is RECORDED, never swallowed — that
 * mistake has cost this round four separate misdiagnoses.
 */
async function collectManifestFiles(
	deps: LiveRunnerDeps,
	expected: ExpectedLiveArtefacts,
): Promise<
	{
		manifestKey: string;
		kind: "HLS" | "DASH" | "SMOOTH";
		key: string;
		bytes?: number;
		entries?: number;
		error?: string;
	}[]
> {
	const out: {
		manifestKey: string;
		kind: "HLS" | "DASH" | "SMOOTH";
		key: string;
		bytes?: number;
		/** SHA-256 of the master's bytes — the origin leg's master identity (EV-02). */
		sha256?: string;
		entries?: number;
		/** DASH: the codecs of each VIDEO AdaptationSet the parser found . */
		videoCodecSets?: string[][];
		error?: string;
	}[] = [];
	for (const m of expected.manifests) {
		const file = m.files[0];
		if (!file) {
			out.push({
				manifestKey: m.manifestKey,
				kind: m.kind,
				key: `${m.dir.prefix}(unnamed)`,
				error: "the expectation names no manifest file",
			});
			continue;
		}
		const key = `${m.dir.prefix}${file}`;
		try {
			const text = await deps.readText(m.outputKey, key);
			let entries: number | undefined;
			let videoCodecSets: string[][] | undefined;
			if (m.kind === "DASH") {
				const { parseDashText } = await import("./adapters");
				const parsed = await parseDashText(text);
				entries = parsed.representations.length;
				videoCodecSets = parsed.adaptationSets
					?.filter((set) => set.kind === "video")
					.map((set) => set.codecs);
			} else if (m.kind === "HLS") {
				const { parseHlsText } = await import("./adapters");
				const parsed = await parseHlsText(text);
				entries = parsed.variants.length + parsed.media.length;
			}
			out.push({
				manifestKey: m.manifestKey,
				kind: m.kind,
				key,
				bytes: Buffer.byteLength(text),
				sha256: sha256Hex(text),
				...(entries !== undefined ? { entries } : {}),
				...(videoCodecSets !== undefined ? { videoCodecSets } : {}),
			});
		} catch (err) {
			out.push({
				manifestKey: m.manifestKey,
				kind: m.kind,
				key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return out;
}

/**
 * Read every declared manifest back on the Akamai delivery EDGE for each MSL
 * delivery-mirror leg

 *
 * One closure per (manifest, MSL mirror output), built by `observeEdgeLeg`
 * (edge-resolver.ts): master → every child → init + a bounded spread of media,
 * every reference resolved with `new URL(reference, parent)` semantics under
 * the edge URL policy (same-origin under the base root, or an explicitly
 * allowed root), every fetched object hashed. Returns `[]` — every leg
 * UNOBSERVED — when there is no MSL mirror, no `edgeBaseUrl`, or no `readEdge`
 * wired; the engine then SKIPs each leg and `runner.ts`'s mirror floor refuses
 * to pass the run on the origin alone. A readable (S3-family) mirror is a
 * different observation and is not walked here.
 *
 * Called from `sample` for the two IN-RUN probes (progression is witnessed
 * between them) and once more after the stop for the report's final closure.
 */
export async function collectEdgeClosures(
	deps: LiveRunnerDeps,
	expected: ExpectedLiveArtefacts,
	mslOutputs: readonly BoundLiveMslOutput[],
	providerOutputIds: Readonly<Record<string, string>>,
	currentRunPrefix: string,
	/** The airing's `runningSince` (ISO-8601) — the freshness reference (WP-C6b). */
	runningSince?: string,
): Promise<LiveEdgeClosure[]> {
	const edgeOutputs = expected.mslEdgeOutputs ?? [];
	if (edgeOutputs.length === 0) {
		return [];
	}
	const out: LiveEdgeClosure[] = [];
	for (const target of edgeOutputs) {
		const binding = mslOutputs.find(
			(candidate) => candidate.outputKey === target.outputKey,
		);
		const providerOutputId = providerOutputIds[target.outputKey];
		for (const manifest of expected.manifests) {
			if (
				target.role === "PRIMARY" &&
				manifest.outputKey !== target.outputKey
			) {
				continue;
			}
			if (!binding?.eventRoot || deps.readEdge === undefined) {
				continue;
			}
			if (!providerOutputId) {
				out.push({
					manifestKey: manifest.manifestKey,
					outputKey: target.outputKey,
					masterUrl: binding.eventRoot,
					closed: false,
					at: deps.now(),
					error: `provider output id for MSL output ${target.outputKey} is missing — refusing to read an edge root that cannot be joined to this airing`,
				});
				continue;
			}
			const policy = edgeUrlPolicy(
				binding.eventRoot,
				deps.edgeAllowedRoots ?? [],
			);
			const selected = expected.muxings.filter(
				(muxing) =>
					muxing.outputKey === manifest.outputKey &&
					(manifest.kind === "HLS" || muxing.container === "FMP4_SEGMENTED"),
			);
			const freshness = runningSince !== undefined ? { runningSince } : {};
			const requirements: LiveEdgeRequirements =
				manifest.kind === "HLS"
					? {
							...freshness,
							currentRunPrefix,
							expectedChildCount: manifest.mediaPlaylists.length,
							expectedChildIds: manifest.mediaPlaylists,
							requireInitChildIds: manifest.mediaPlaylists.filter(
								(_id, index) =>
									selected[index]?.initSegment !== undefined ||
									selected[index]?.initSegmentNameTemplate !== undefined,
							),
						}
					: {
							...freshness,
							currentRunPrefix,
							expectedChildCount: selected.length,
						};
			// MSL4 delivery is not a byte-for-byte exposure of the submitted
			// destination directory: Akamai publishes the master (and HLS child
			// playlists) directly at the event root, while their media URIs point
			// into the run-unique destination prefix. Preserve the authored
			// filenames/topology, but resolve the delivery master at that event root.
			const edgeManifest = {
				...manifest,
				dir: { pattern: "", prefix: "", templated: false as const },
			};
			const observed = await observeEdgeLeg(
				deps.readEdge,
				policy,
				edgeManifest,
				target.outputKey,
				deps.now(),
				requirements,
			);
			out.push({
				...observed,
				msl: {
					outputKey: binding.outputKey,
					credentialId: binding.credentialId,
					providerOutputId,
					streamId: binding.streamId,
					eventName: binding.eventName,
					streamFormat: binding.streamFormat,
					mslVersion: binding.mslVersion,
					eventRoot: redactUrl(binding.eventRoot, sha256Hex),
				},
			});
		}
	}
	return out;
}

async function measureFirstPublish(
	deps: LiveRunnerDeps,
	expected: ExpectedLiveArtefacts,
	capSec: number,
): Promise<{ ms?: number; polls: number; note: string }> {
	const hls = expected.manifests.find((m) => m.kind === "HLS");
	const mediaKey = hls?.mediaPlaylists[0];
	if (!hls || !mediaKey) {
		return {
			polls: 0,
			note: "no HLS media playlist to poll — DASH-only channels publish on a path this cannot read, so the latency is unmeasured rather than zero",
		};
	}
	const key = `${hls.dir.prefix}${mediaKey}`;
	const startedAt = deps.now();
	let polls = 0;
	/**
	 * The LAST read error, and how many reads failed — because swallowing them lied.
	 *
	 * The first version caught every read error silently, on the reasoning that a missing
	 * playlist early in a feed is normal. It is. But a read that fails for EVERY poll is not a
	 * missing playlist, and reporting it as "no segment appeared" states something about the
	 * origin that was never observed. REAL-LIVE-5 did exactly that: it reported
	 * `no segment appeared in video_3000000.m3u8 within 160s` while the bucket's copy of that
	 * playlist holds 22 `#EXTINF` lines, and the parser reads it correctly. The note was
	 * describing a read failure in the language of an encoder problem.
	 */
	let lastError: string | undefined;
	let failedReads = 0;
	for (;;) {
		polls++;
		try {
			const parsed = readLivePlaylist(await deps.readText(hls.outputKey, key));
			if ((parsed.segments ?? 0) > 0) {
				const ms = deps.now() - startedAt;
				return {
					ms,
					polls,
					note: `first segment visible in ${mediaKey} after ${(ms / 1000).toFixed(1)}s (${polls} poll(s))`,
				};
			}
		} catch (err) {
			failedReads++;
			lastError = err instanceof Error ? err.message : String(err);
		}
		if (deps.now() - startedAt >= capSec * 1000) {
			// Three different facts, three different sentences. Conflating them is what made
			// the previous version dishonest.
			if (failedReads === polls) {
				return {
					polls,
					note: `could not READ ${key} on any of ${polls} attempts within ${capSec}s, so the publish latency was never measured — last error: ${lastError ?? "unknown"}. This is a harness/storage fault, NOT a statement about the origin`,
				};
			}
			return {
				polls,
				note: `${key} was readable but listed no segment within ${capSec}s (${polls} poll(s), ${failedReads} read failure(s)) — the latency is unknown, not high`,
			};
		}
		await deps.sleep(2_000);
	}
}

/** Exact provider resources written by the current airing's step log. */
function providerResourcesFromStepLog(stepLog: unknown): {
	streamIds: Record<string, string>;
	outputIds: Record<string, string>;
} {
	const entries = Array.isArray(stepLog) ? stepLog : [];
	const resources = (prefix: "stream:" | "output:") =>
		Object.fromEntries(
			entries.flatMap((entry) => {
				if (typeof entry !== "object" || entry === null) {
					return [];
				}
				const step = (entry as { step?: unknown }).step;
				const resourceId = (entry as { resourceId?: unknown }).resourceId;
				return typeof step === "string" &&
					step.startsWith(prefix) &&
					typeof resourceId === "string" &&
					resourceId !== ""
					? [[step.slice(prefix.length), resourceId] as const]
					: [];
			}),
		);
	return {
		streamIds: resources("stream:"),
		outputIds: resources("output:"),
	};
}

async function sample(
	deps: LiveRunnerDeps,
	expected: ExpectedLiveArtefacts,
	channelId: string,
	mslOutputs: readonly BoundLiveMslOutput[],
	currentRunPrefix: string,
): Promise<LiveSample> {
	const at = deps.now();
	const channel = await deps.api(`/api/live-channels/${channelId}`);
	const channelBody =
		typeof channel.json === "object" && channel.json !== null
			? (channel.json as {
					currentRun?: {
						stepLog?: unknown;
						runningSince?: string | null;
					} | null;
					stepLog?: unknown;
				})
			: {};
	const providerOutputIds = providerResourcesFromStepLog(
		channelBody.currentRun?.stepLog ?? channelBody.stepLog,
	).outputIds;
	// The airing's own start, from the product's run row — the reference every
	// served object's Last-Modified is judged against (WP-C6b). Absent means
	// the freshness verdict is UNVERIFIED; the harness clock is not substituted.
	const runningSince =
		typeof channelBody.currentRun?.runningSince === "string"
			? channelBody.currentRun.runningSince
			: undefined;
	const status =
		typeof channel.json === "object" &&
		channel.json !== null &&
		"status" in channel.json
			? String((channel.json as { status: unknown }).status)
			: "unknown";

	let heartbeatError: string | undefined;
	const beats = await deps
		.api(`/api/live-channels/${channelId}/heartbeats`)
		.catch((err) => {
			heartbeatError = `heartbeats: ${err instanceof Error ? err.message : String(err)}`;
			return undefined;
		});
	if (beats !== undefined && beats.status >= 300) {
		// A 500 here is the THIRD case `live:readable`'s own docstring names as its
		// motivation — and it was the one that still slipped, because only playlist and
		// listing errors were recorded. A review found my own example unguarded.
		heartbeatError = `heartbeats: HTTP ${beats.status}`;
	}
	/**
	 * `points`, which is what the route returns — not `items`, which is what I read.
	 *
	 * `GET /api/live-channels/:id/heartbeats` answers
	 * `{"windowMinutes":120,"points":[{"at":…,"ingestStatus":"CONNECTED","bitrate":6610944,…}]}`
	 * and this looked for `items`. So `live:heartbeat` SKIPped with "the heartbeat series could
	 * not be read" on every live run, including the green ones, while the data was right there —
	 * a field-name mismatch reported as an unreadable series.
	 *
	 * And when neither shape is present, the KEYS ARE NAMED. Returning `undefined` is what let a
	 * mismatch masquerade as an empty series for the whole life of this check; a reader who sees
	 * the keys the response actually had cannot make the same mistake twice.
	 */
	const body = beats?.json as Record<string, unknown> | undefined;
	const series = Array.isArray(body?.points)
		? (body?.points as unknown[])
		: Array.isArray(body?.items)
			? (body?.items as unknown[])
			: undefined;
	const heartbeatRows = series?.length;
	if (
		series === undefined &&
		beats !== undefined &&
		beats.status < 300 &&
		heartbeatError === undefined
	) {
		heartbeatError = `heartbeats: HTTP ${beats.status} but no array in the body — keys were [${body ? Object.keys(body).join(", ") : "(not an object)"}]`;
	}

	/**
	 * A MEDIA playlist, not the master.
	 *
	 * The first version read `manifest.files[0]`, which is the master — and a master carries
	 * no `EXT-X-MEDIA-SEQUENCE`, no `EXTINF` and never an `EXT-X-ENDLIST`. So five checks
	 * could only ever SKIP and `live:to-vod:endlist` would have FAILED a perfectly good
	 * recording. The repo already pinned the distinction two ways — the VOD engine's
	 * `isMaster` guard, and a test in this very file asserting a master yields no segments —
	 * and the live side reproduced the confusion without either (review catch).
	 */
	const hls = expected.manifests.find((m) => m.kind === "HLS");
	let playlist: { mediaSequence?: number; segments?: number } = {};
	let playlistError: string | undefined;
	const mediaKey = hls?.mediaPlaylists[0];
	if (hls && mediaKey) {
		const key = `${hls.dir.prefix}${mediaKey}`;
		try {
			playlist = readLivePlaylist(await deps.readText(hls.outputKey, key));
		} catch (err) {
			// Named, not swallowed: a storage fault and a stalled channel look identical from
			// an empty result, and conflating them is how a harness reports green over a
			// bucket it could not read.
			/**
			 * NOT-FOUND on an early sample is expected, not a finding.
			 *
			 * Sample 1 is taken at t=0 of the feed: handshake, first GOP, first segment and
			 * first manifest write are all still ahead, so a real channel has published
			 * nothing yet. Recording that as a read failure made `live:readable` FAIL on
			 * every healthy channel — the normal case, not the edge, and it would have read
			 * as "the I5 fix works" on the first nightly. A review caught it before it cost
			 * a night of noise.
			 *
			 * An auth, network or bucket error is a finding at ANY sample. A missing object
			 * is a finding only on the LAST one, where 45s in that playlist should exist.
			 */
			const message = err instanceof Error ? err.message : String(err);
			const notFound =
				/NoSuchKey|NotFound|404|does not exist|no object at/i.test(message);
			playlistError = notFound
				? `NOTFOUND ${key}: ${message}`
				: `${key}: ${message}`;
		}
	}

	// EVERY muxing prefix, not just the first: a ladder where one rendition stalls while the
	// others keep writing is invisible to a single-prefix count.
	let objects: { key: string; size?: number }[] | undefined;
	let listError: string | undefined;
	try {
		const listed = await Promise.all(
			expected.muxings.map((m) => deps.listAll(m.outputKey, m.dir.prefix)),
		);
		objects = listed.flat();
	} catch (err) {
		listError = err instanceof Error ? err.message : String(err);
	}

	/**
	 * The MSL delivery-mirror legs on the EDGE at THIS sample
	 * master → every child → init + media with bytes and
	 * hashes, IN-RUN. Two of these, a sample gap apart, are what let the
	 * engine and the evidence tuple witness media ADVANCING on the edge — the
	 * post-stop closure alone cannot. Empty (no `edge` key) when no edge base
	 * or reader is wired, which the engine reads as UNOBSERVED.
	 */
	const edge = await collectEdgeClosures(
		deps,
		expected,
		mslOutputs,
		providerOutputIds,
		currentRunPrefix,
		runningSince,
	);

	return {
		at,
		status,
		...(edge.length > 0 ? { edge } : {}),
		...(playlist.mediaSequence !== undefined
			? { mediaSequence: playlist.mediaSequence }
			: {}),
		...(playlist.segments !== undefined
			? { playlistSegments: playlist.segments }
			: {}),
		...(heartbeatRows !== undefined ? { heartbeatRows } : {}),
		...(objects !== undefined ? { objects } : {}),
		...(playlistError !== undefined ||
		listError !== undefined ||
		heartbeatError !== undefined
			? {
					readErrors: [playlistError, listError, heartbeatError].filter(
						(x): x is string => x !== undefined,
					),
				}
			: {}),
	};
}

/** Wait until the channel reports RUNNING, or the timeout expires. */
async function awaitRunning(
	deps: LiveRunnerDeps,
	channelId: string,
	timeoutSec: number,
): Promise<string> {
	const deadline = deps.now() + timeoutSec * 1000;
	let last = "unknown";
	while (deps.now() < deadline) {
		const res = await deps.api(`/api/live-channels/${channelId}`);
		const status = (res.json as { status?: string } | null)?.status;
		last = status ?? "unknown";
		if (last === "RUNNING" || last === "ERROR") {
			return last;
		}
		await deps.sleep(POLL_MS);
	}
	return last;
}

/**
 * Read the raw cleanup facts once, over the product's own API

 *
 * Two reads: the channel detail for the local STOPPED projection, and the
 * channel's feeder sessions (with `queue=1`, so each carries whether the feeder
 * queue still holds a job for it) for the process and queue words. STOPPED +
 * null error remains explicitly local here; EV-01 supplies the independent,
 * exact provider-set terminal readback later.
 *
 * The channel row's terminal state is read currentRun-first (the canonical
 * reader) and falls back to the dual-written channel columns.
 */
async function readCleanupFacts(
	deps: LiveApiDeps,
	channelId: string,
	temporaryStreamKey: { id: string; bitmovinAccountId: string } | undefined,
): Promise<{
	channelId: string;
	liveChannelRunId?: string;
	providerEncodingId?: string;
	providerStreamIds: Record<string, string>;
	providerOutputIds: Record<string, string>;
	tokenCleanup: { required: boolean; confirmed: boolean; detail: string };
	channelStatus: string | undefined;
	channelError: string | null | undefined;
	feederListRead: boolean;
	feeders: LiveCleanupFeeder[];
}> {
	const detail = await deps
		.api(`/api/live-channels/${channelId}`)
		.catch(() => undefined);
	const channel = (detail?.json ?? {}) as {
		status?: string;
		error?: string | null;
		bitmovinEncodingId?: string | null;
		currentRun?: {
			id?: string;
			status?: string;
			error?: string | null;
			bitmovinEncodingId?: string | null;
			stepLog?: unknown;
		} | null;
	};
	const run = channel.currentRun ?? undefined;
	const channelStatus = run?.status ?? channel.status;
	const channelError = run ? run.error : channel.error;
	// The airing and the provider encoding, for the evidence tuple (EV-02):
	// currentRun-first (the canonical reader), the dual-written column as the
	// fallback. Absent when the detail could not be read — named, not guessed.
	const liveChannelRunId =
		typeof run?.id === "string" && run.id !== "" ? run.id : undefined;
	const providerEncodingId =
		typeof run?.bitmovinEncodingId === "string" && run.bitmovinEncodingId !== ""
			? run.bitmovinEncodingId
			: typeof channel.bitmovinEncodingId === "string" &&
					channel.bitmovinEncodingId !== ""
				? channel.bitmovinEncodingId
				: undefined;
	const resources = providerResourcesFromStepLog(run?.stepLog);
	const providerStreamIds = resources.streamIds;
	const providerOutputIds = resources.outputIds;

	const list = await deps
		.api(`/api/feeder-sessions?liveChannelId=${channelId}&queue=1`)
		.catch(() => undefined);
	const items =
		list && list.status < 300
			? ((list.json as { items?: unknown } | null)?.items ?? undefined)
			: undefined;
	const feederListRead = Array.isArray(items);
	const feeders: LiveCleanupFeeder[] = feederListRead
		? (items as Record<string, unknown>[]).map((row) => ({
				id: String(row.id),
				pid: typeof row.pid === "number" ? row.pid : null,
				processGoneAt:
					typeof row.processGoneAt === "string" ||
					row.processGoneAt instanceof Date
						? (row.processGoneAt as string | Date)
						: null,
				startedAt:
					typeof row.startedAt === "string" || row.startedAt instanceof Date
						? (row.startedAt as string | Date)
						: null,
				// A missing `queued` is UNKNOWN, not drained — the route omits it
				// only when the queue could not be read, which cannot prove 0 jobs.
				queued: typeof row.queued === "boolean" ? row.queued : null,
			}))
		: [];
	let tokenCleanup = {
		required: false,
		confirmed: true,
		detail: "this ingest created no temporary stream key",
	};
	if (temporaryStreamKey) {
		const token = await deps
			.api(
				`/api/live/stream-keys/${temporaryStreamKey.id}?bitmovinAccountId=${temporaryStreamKey.bitmovinAccountId}`,
			)
			.catch(() => undefined);
		tokenCleanup = {
			required: true,
			confirmed: token?.status === 404,
			detail:
				token?.status === 404
					? `temporary stream key ${temporaryStreamKey.id} is no longer readable (HTTP 404)`
					: token
						? `temporary stream key ${temporaryStreamKey.id} is still readable or unconfirmed (HTTP ${token.status})`
						: `temporary stream key ${temporaryStreamKey.id} cleanup could not be read`,
		};
	}

	return {
		channelId,
		...(liveChannelRunId !== undefined ? { liveChannelRunId } : {}),
		...(providerEncodingId !== undefined ? { providerEncodingId } : {}),
		providerStreamIds,
		providerOutputIds,
		tokenCleanup,
		channelStatus,
		channelError,
		feederListRead,
		feeders,
	};
}

/**
 * The local half of the durable teardown seal, re-read until every local
 * element is POSITIVELY true or the budget runs out
 * . EV-01 joins provider proof after this loop.
 *
 * The loop IS the idempotent resume: each pass is a pure read of current state,
 * so a teardown that was partial when first read (the feeder stop's kill ladder
 * had not stamped `processGoneAt` yet, a stop job was still draining) completes
 * into a locally clean seal on a later pass, and re-running it on an already
 * locally clean run returns on the first pass with no side effect. When the
 * budget expires with an element still unproven, `localClean` stays false.
 */
async function sealCleanup(
	deps: LiveApiDeps,
	channelId: string,
	temporaryStreamKey: { id: string; bitmovinAccountId: string } | undefined,
): Promise<LiveCleanupSeal> {
	const deadline = deps.now() + CLEANUP_SEAL_BUDGET_MS;
	let seal = liveCleanupSeal(
		await readCleanupFacts(deps, channelId, temporaryStreamKey),
	);
	while (!seal.localClean && deps.now() < deadline) {
		await deps.sleep(POLL_MS);
		seal = liveCleanupSeal(
			await readCleanupFacts(deps, channelId, temporaryStreamKey),
		);
	}
	return seal;
}

async function readFedSourceEvidence(
	deps: LiveRunnerDeps,
	feederId: string | undefined,
	feed: LiveRunOptions["feed"],
): Promise<
	| {
			location: string;
			etag?: string;
			versionId?: string;
			generation?: string;
			size?: number;
			sha256?: string;
	  }
	| undefined
> {
	if (!feed) {
		return undefined;
	}
	const source = { location: `${feed.bucket}/${feed.key}` };
	if (!feederId) {
		return source;
	}
	const detail = await deps
		.api(`/api/feeder-sessions/${feederId}`)
		.catch(() => undefined);
	if (!detail || detail.status >= 300 || typeof detail.json !== "object") {
		return source;
	}
	const row = detail.json as Record<string, unknown>;
	const size =
		typeof row.sourceSize === "string" && /^\d+$/.test(row.sourceSize)
			? Number(row.sourceSize)
			: typeof row.sourceSize === "number"
				? row.sourceSize
				: undefined;
	return {
		...source,
		...(typeof row.sourceEtag === "string" && row.sourceEtag !== ""
			? { etag: row.sourceEtag }
			: {}),
		...(typeof row.sourceVersionId === "string" && row.sourceVersionId !== ""
			? { versionId: row.sourceVersionId }
			: {}),
		...(typeof row.sourceGeneration === "string" && row.sourceGeneration !== ""
			? { generation: row.sourceGeneration }
			: {}),
		...(size !== undefined && Number.isSafeInteger(size) ? { size } : {}),
		...(typeof row.sourceSha256 === "string" && row.sourceSha256 !== ""
			? { sha256: row.sourceSha256 }
			: {}),
	};
}

/**
 * The no-side-effect half of a Live verification run: validate the authored
 * plan, apply the exact run rewrite, compile the artefact contract, and bind
 * any MSL output to its selected credential. Both paid runs and dry runs use
 * this function so a rehearsal cannot claim work that only the paid path did.
 */
export function prepareLiveScenarioForRun(input: {
	plan: unknown;
	rewrite: LiveRunOptions["rewrite"];
	startTimeoutSec: number;
	feedSeconds: number;
	verificationKey?: string;
}): PreparedLiveScenario {
	const parsed = liveChannelPlanSchema.safeParse(input.plan);
	if (!parsed.success) {
		throw new Error(
			`plan does not satisfy the live schema: ${parsed.error.issues
				.slice(0, 3)
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	let submitted = rewriteLiveForRun(parsed.data, {
		...input.rewrite,
		startTimeoutSec: input.startTimeoutSec,
		feedSeconds: input.feedSeconds,
	});
	if (input.verificationKey) {
		const label = verificationKeyLabel(input.verificationKey);
		submitted = {
			...submitted,
			bitmovin: {
				...submitted.bitmovin,
				labels: Array.from(
					new Set([...(submitted.bitmovin.labels ?? []), label]),
				),
			},
		};
	}
	const expected = compileExpectedLiveArtefacts(submitted);
	if (expected.muxings.length + expected.manifests.length === 0) {
		throw new Error(
			"rewritten live plan compiles to no muxing or manifest artefact group",
		);
	}
	return {
		submitted,
		expected,
		mslOutputs: bindLiveMslOutputs(submitted, input.rewrite.akamaiMsl),
	};
}

/**
 * Run one live scenario.
 *
 * Never throws for a product-side failure — that is a report with FAILs. It returns
 * `invalid` only for a HARNESS fault, which design §5 keeps distinct from a product
 * failure and never counts as green.
 */
export async function runLiveScenario(
	deps: LiveRunnerDeps,
	options: LiveRunOptions,
): Promise<LiveRunResult> {
	const log = deps.log ?? (() => {});
	// The sample gap is a floor the ENGINE enforces, so a feed shorter than it would
	// produce a run whose movement checks can only SKIP. Refuse up front rather than
	// spend minutes to report nothing.
	if (options.feedSeconds < MIN_SAMPLE_GAP_SEC + 5) {
		return {
			scenario: options.scenario,
			invalid: `feedSeconds ${options.feedSeconds} is too short: the engine needs two samples ${MIN_SAMPLE_GAP_SEC}s apart, so a feed under ${MIN_SAMPLE_GAP_SEC + 5}s could only ever produce SKIPs`,
		};
	}

	let prepared: PreparedLiveScenario;
	try {
		prepared = prepareLiveScenarioForRun({
			plan: options.plan,
			rewrite: options.rewrite,
			startTimeoutSec: options.startTimeoutSec,
			feedSeconds: options.feedSeconds,
			...(options.intent ? { verificationKey: options.intent.key } : {}),
		});
	} catch (err) {
		return {
			scenario: options.scenario,
			invalid: `the run could not prepare the rewritten live plan: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const { submitted, expected: expectedForRun, mslOutputs } = prepared;

	/**
	 * EV-01: the durable intent, BEFORE the POST.
	 *
	 * The create used to sit above the `try/finally`, so a throw from the POST
	 * a timeout after the server had created the channel, a reset, a body
	 * that would not parse — ran no teardown at all, and a channel that bills
	 * from creation was nobody's. Now: PREPARED lands first (a
	 * failed write means nothing is sent), the key rides the request so the
	 * product can answer a repeat with the same channel, and every exit from
	 * the `try` below — the ambiguous-create adoption included — reaches the
	 * `finally` that stops the channel and closes the intent.
	 */
	const createBody = {
		plan: submitted,
		...(options.intent ? { verificationKey: options.intent.key } : {}),
	};
	let intent: IntentHandle | undefined;
	if (options.intent) {
		try {
			intent = await options.intent.prepare({
				requestSha256: verificationRequestSha256(createBody),
				resourceName: submitted.name,
			});
		} catch (err) {
			return {
				scenario: options.scenario,
				invalid: `durable intent could not be recorded (${err instanceof Error ? err.message : String(err)}) — nothing was created`,
			};
		}
	}

	let channelId: string | undefined;
	let providerId: string | undefined;
	let stopped = false;
	let feederId: string | undefined;
	let temporaryStreamKey: { id: string; bitmovinAccountId: string } | undefined;
	/** Stop failures, surfaced as INVALID — an unstopped channel bills by the minute. */
	const stopFailures: string[] = [];
	/** The seal the happy path already read, so `finally` does not read it twice. */
	let sealedCleanup: LiveCleanupSeal | undefined;
	let intentClosed = false;
	let intentTerminal: Parameters<IntentHandle["terminal"]>[0] | undefined;
	const additionalCanaryClosures: IntentTerminalInput[] = [];

	const stopEverything = async () => {
		if (stopped || !channelId) {
			return;
		}
		stopped = true;
		// The FEEDER first, and in the same place as the channel. It used to be stopped
		// inside the `try`, so an exception between the feed and the stop left a live ffmpeg
		// push process running (review catch, reproduced).
		if (feederId) {
			await stopWithRetry(
				deps,
				`/api/feeder-sessions/${feederId}/actions`,
				`feeder ${feederId}`,
				stopFailures,
			);
		}
		// A channel left RUNNING costs money, so this runs even when the run failed. The
		// OUTPUT is deliberately left in place: the artefacts are the evidence, and deleting
		// them on failure would make the report unreproducible.
		await stopChannelConfirmed(deps, channelId, stopFailures);
	};

	const closeIntent = async (
		seal: LiveCleanupSeal,
	): Promise<Parameters<IntentHandle["terminal"]>[0] | undefined> => {
		if (!intent || !channelId || intentClosed) {
			return intentTerminal;
		}
		let primary: IntentTerminalInput;
		if (options.intent?.resolveTerminal) {
			primary = await options.intent.resolveTerminal(channelId, {
				cleanup: seal,
				stopFailures,
				...(providerId ? { providerId } : {}),
			});
		} else {
			// Runtime defense in addition to the required type: a JS caller or a
			// future unsafe cast must not silently regain the historical single-id
			// CLEANED path. Without exact provider-set discovery, closure is
			// necessarily unresolved even when the product projection looks clean.
			const localKey = verificationLocalResourceKey("LIVE_CHANNEL", channelId);
			const providerKey = providerId
				? verificationProviderEncodingKey(providerId)
				: undefined;
			primary = {
				cleanupState: "UNRESOLVED",
				readback: { channelId, cleanup: seal, stopFailures },
				providerId: providerId ?? null,
				providerIds: providerId ? [providerId] : [],
				possiblyCreatedKeys: [localKey, ...(providerKey ? [providerKey] : [])],
				cleanedResourceKeys: [
					...(seal.localTerminal.established ? [localKey] : []),
				],
				error:
					stopFailures.join("; ") ||
					"exact live provider-set resolver is missing; single provider projection cannot close the intent",
			};
		}
		intentTerminal = mergeIntentTerminalInputs(
			primary,
			additionalCanaryClosures,
		);
		await intent.terminal(intentTerminal);
		intentClosed = true;
		return intentTerminal;
	};

	let verificationDispatch: VerificationDispatchFence | undefined;
	try {
		if (intent) {
			try {
				// HARD: SUBMITTED is what lets teardown tell "never sent" from
				// "sent, response lost". If it does not land, nothing is sent.
				verificationDispatch = await intent.submitted();
			} catch (err) {
				return {
					scenario: options.scenario,
					invalid: `durable intent could not be marked SUBMITTED (${err instanceof Error ? err.message : String(err)}) — nothing was sent`,
				};
			}
		}
		let created: { status: number; json: unknown };
		try {
			noteCanaryCreatePost(
				options.postCreateResponseLossCanary,
				"LIVE_CHANNEL",
				options.scenario,
			);
			created = await deps.api("/api/live-channels", {
				method: "POST",
				body: intent
					? {
							...createBody,
							requestSha256: intent.requestSha256,
							verificationDispatch,
						}
					: createBody,
			});
		} catch (err) {
			if (!intent) {
				throw err;
			}
			const message = err instanceof Error ? err.message : String(err);
			if (classifySendFailure(err) === "BEFORE_SEND") {
				await intent.neverSent(message);
				return {
					scenario: options.scenario,
					invalid: `could not create the channel: ${message} (the request never left — nothing was created)`,
				};
			}
			// AMBIGUOUS — never a blind re-POST. The channel may exist and bill;
			// find it by its key and marker, adopt exactly one, tear it down.
			await intent.ambiguous(message);
			const found = await intent.resolve();
			if (!found.adopted) {
				return {
					scenario: options.scenario,
					invalid: `the create response was lost (${message}) and ${found.reason}; intent ${intent.key} is UNRESOLVED and the run will not seal — operator action required`,
				};
			}
			channelId = found.localId;
			providerId = found.providerId ?? undefined;
			log(
				`${options.scenario}: create response lost (${message}); adopted channel ${channelId} by its verification key — tearing it down`,
			);
			return {
				scenario: options.scenario,
				channelId,
				invalid: `the create response was lost (${message}); channel ${channelId} was found by its verification key and torn down`,
			};
		}
		const createdId = (created.json as { id?: string } | null)?.id;
		if (created.status >= 300 || !createdId) {
			if (!intent) {
				return {
					scenario: options.scenario,
					invalid: `could not create the channel: HTTP ${created.status}`,
				};
			}
			const refusal = `HTTP ${created.status}${createdId ? "" : " with no channel id"}`;
			const errorCode = verificationCreateErrorCode(created.json);
			if (
				errorCode !== undefined &&
				errorCode !== VERIFICATION_KEY_SHA_CONFLICT
			) {
				// These bounded route codes reject before a paid row can be created.
				// A different-SHA conflict is deliberately excluded: it proves the key
				// already names a local resource, whose terminal/cleanup state must be
				// resolved instead of being erased as NEVER_CREATED.
				await intent.refused(refusal);
				return {
					scenario: options.scenario,
					invalid: `could not create the channel: ${refusal}`,
				};
			}
			// A 5xx (the route marks the row ERROR after an enqueue failure and
			// rethrows — the row exists), a 409, or a 2xx with no id: ambiguous.
			await intent.ambiguous(refusal);
			const found = await intent.resolve();
			if (!found.adopted) {
				return {
					scenario: options.scenario,
					invalid: `could not create the channel: ${refusal}, and ${found.reason}; intent ${intent.key} is UNRESOLVED and the run will not seal — operator action required`,
				};
			}
			channelId = found.localId;
			providerId = found.providerId ?? undefined;
			return {
				scenario: options.scenario,
				channelId,
				invalid: `could not create the channel cleanly (${refusal}); channel ${channelId} was found by its verification key and torn down`,
			};
		}
		channelId = createdId;
		if (intent) {
			// The exact-key/SHA route is idempotent. Keep the dispatch lease until
			// this response id is durable so response loss cannot create an unowned
			// billable channel.
			await intent.recordCreateResponseId(createdId);
		}
		const replayed = (created.json as { replayed?: boolean }).replayed === true;
		const injectResponseLoss = shouldInjectPostCreateResponseLoss(
			options.postCreateResponseLossCanary,
			{
				resourceKind: "LIVE_CHANNEL",
				scenario: options.scenario,
				localId: createdId,
				replayed,
			},
		);
		if (injectResponseLoss) {
			// Own the known-created id for finally BEFORE an intent write/lookup
			// can throw. The simulated loss removes response authority only; it
			// must never remove our ability to stop the billing channel.
			if (!intent) {
				return {
					scenario: options.scenario,
					channelId,
					invalid:
						"fault injection reached a successful channel CREATE without a durable intent — the channel will be stopped but the canary cannot pass",
				};
			}
			const reason =
				"fault injection: discarded the successful fresh channel product HTTP CREATE response after the product API returned an id";
			await intent.ambiguous(reason);
			const found = await intent.resolve();
			if (!found.adopted) {
				// The canary knows this id solely to make the fault safe. It is not
				// allowed to use it as adoption evidence, but finally must stop it.
				channelId = createdId;
				return {
					scenario: options.scenario,
					channelId,
					invalid: `fault injection lost the successful CREATE response and ${found.reason}; the known canary resource will be stopped, but intent adoption failed`,
				};
			}
			channelId = found.localId;
			providerId = found.providerId ?? undefined;
			noteCanaryAdoption(options.postCreateResponseLossCanary, found.localId);
			if (found.localId !== createdId) {
				const mismatched = await teardownAdoptedChannel(deps, found.localId);
				if (options.intent?.resolveTerminal) {
					additionalCanaryClosures.push(
						await options.intent.resolveTerminal(found.localId, mismatched),
					);
				} else {
					const localKey = verificationLocalResourceKey(
						"LIVE_CHANNEL",
						found.localId,
					);
					additionalCanaryClosures.push({
						cleanupState: "UNRESOLVED",
						readback: mismatched,
						providerId: mismatched.providerId ?? null,
						providerIds: mismatched.providerId ? [mismatched.providerId] : [],
						possiblyCreatedKeys: [localKey],
						cleanedResourceKeys: mismatched.cleanup.localTerminal.established
							? [localKey]
							: [],
						error:
							"exact provider-set resolver is missing for the mismatched adopted channel",
					});
				}
				// Finally owns the successful response id. The mismatched candidate
				// was just stopped and is merged into the same intent closure.
				channelId = createdId;
				return {
					scenario: options.scenario,
					channelId,
					invalid: `fault injection adopted ${found.localId}, not the known successfully created channel ${createdId}; both resources are included in bounded cleanup`,
				};
			}
			log(
				`${options.scenario}: injected product-HTTP post-CREATE response loss; adopted channel ${channelId} by durable intent and continuing without another create`,
			);
		}
		if (replayed) {
			log(
				`${options.scenario}: the product returned the EXISTING channel ${channelId} for verification key ${intent?.key ?? "?"}`,
			);
		}
		if (!injectResponseLoss) {
			await intent?.confirmed(channelId);
		}
		log(`${options.scenario}: channel ${channelId} created`);

		await deps.api(`/api/live-channels/${channelId}/actions`, {
			method: "POST",
			body: { action: "start" },
		});
		const status = await awaitRunning(deps, channelId, options.startTimeoutSec);
		log(`${options.scenario}: channel is ${status}`);

		const detail = await deps.api(`/api/live-channels/${channelId}`);
		const channel = (detail.json ?? {}) as {
			streamKey?: string;
			encoderIp?: string;
			bitmovinEncodingId?: string;
		};
		providerId = channel.bitmovinEncodingId;
		if (providerId) {
			// The create response contains only the local id. Persist the provider
			// identity as soon as the product exposes it; a later process death can
			// then recover by exact id rather than by a name heuristic.
			await intent?.confirmed(channelId, providerId);
		}
		const coordinates = {
			...(channel.streamKey ? { streamKey: channel.streamKey } : {}),
			...(channel.encoderIp ? { encoderIp: channel.encoderIp } : {}),
		};

		// Feed only what the feeder can drive, and only if the channel is actually up:
		// pushing at a channel that never reached RUNNING would produce a feeder error
		// that reads like a media defect.
		let fed = false;
		const canFeed =
			expectedForRun.ingest.feedable &&
			status === "RUNNING" &&
			options.feed !== undefined &&
			coordinates.encoderIp !== undefined;
		if (canFeed && options.feed) {
			// The SRT port comes from the PLAN, not from a hardcoded 2088: a channel listening
			// on 2089 could never be reached, and a connection failure would have read as a
			// media defect (review catch).
			/**
			 * Static-GENERATE ingest (harness half —
			 * 2026-08-23): a static redundant point pushes to the FIXED FQDN,
			 * never the encoder IP, and its key is the TEMPORARY StreamKey
			 * Bitmovin mints for GENERATE — a 22-char value reachable only via
			 * the per-key reveal GET. The plan's own start.streamKey is never
			 * accepted there (measured on the product side, ; the
			 * harness reproduced the exact refusal tonight: ffmpeg I/O error
			 * against rtmp://<encoderIp>/live with the plan key, three
			 * channels in a row). Resolve the assigned key through the app's
			 * own API — list by assignedEncodingId, reveal the first.
			 */
			let staticTarget: { url: string; streamKey: string } | undefined;
			const isStaticIngest =
				(expectedForRun.ingest.staticIngestPoints?.length ?? 0) > 0;
			if (isStaticIngest && channel.bitmovinEncodingId) {
				// The list REQUIRES bitmovinAccountId — the first version
				// omitted it and every call died in validation, so all three
				// channels "had no key" while the key existed (measured, run
				// akamai-e2e-2026-08-24). If the server-side filter answers
				// empty mid-assignment, fall back to an unfiltered page and
				// match client-side rather than concluding "no key".
				const account = options.rewrite.bitmovinAccountId;
				const enc = channel.bitmovinEncodingId;
				type KeyRow = { id?: string; assignedEncodingId?: string };
				const filtered = await deps.api(
					`/api/live/stream-keys?bitmovinAccountId=${account}&limit=100&assignedEncodingId=${enc}`,
				);
				let rows = (filtered.json as { items?: KeyRow[] } | null)?.items ?? [];
				if (rows.length === 0) {
					const all = await deps.api(
						`/api/live/stream-keys?bitmovinAccountId=${account}&limit=100`,
					);
					rows = (
						(all.json as { items?: KeyRow[] } | null)?.items ?? []
					).filter((k) => k.assignedEncodingId === enc);
				}
				const first = rows[0];
				if (first?.id) {
					temporaryStreamKey = { id: first.id, bitmovinAccountId: account };
					const revealed = await deps.api(
						`/api/live/stream-keys/${first.id}?bitmovinAccountId=${account}`,
					);
					const value = (revealed.json as { value?: string } | null)?.value;
					if (value) {
						staticTarget = { url: STATIC_INGEST_URL, streamKey: value };
					}
				}
			}
			// HONOR the refusal (the first version logged "not feeding" and then
			// fed with the plan key anyway — the feeder targets in the DB proved
			// it): a static-GENERATE channel with no revealed key is NOT fed.
			if (isStaticIngest && !staticTarget) {
				log(
					`${options.scenario}: static-GENERATE ingest, but no assigned stream key could be revealed — feeding with the plan key would be refused, so NOT feeding`,
				);
			}
			const target =
				expectedForRun.ingest.kind === "SRT"
					? {
							host: coordinates.encoderIp as string,
							port: expectedForRun.ingest.srtPort ?? 2088,
						}
					: (staticTarget ?? {
							/**
							 * The application and key the PLAN declares, not the `/live` convention.
							 *
							 * `live-redundant-rtmp` declares `liveA/primaryFeed` and
							 * `liveB/backupFeed`; pushing to `rtmp://<ip>/live` with the
							 * channel-level key reached nothing, and the channel reported RUNNING
							 * while writing ZERO objects for three separate runs. The plan said
							 * where to push the whole time.
							 */
							url: `rtmp://${coordinates.encoderIp}/${expectedForRun.ingest.rtmpApplication ?? "live"}`,
							streamKey:
								expectedForRun.ingest.rtmpStreamKey ??
								coordinates.streamKey ??
								"",
						});
			const feeder = !(isStaticIngest && !staticTarget)
				? await deps.api("/api/feeder-sessions", {
						method: "POST",
						body: {
							liveChannelId: channelId,
							source: options.feed,
							protocol:
								expectedForRun.ingest.kind === "SRT" ? "SRT_CALLER" : "RTMP",
							target,
						},
					})
				: undefined;
			if (feeder) {
				feederId = (feeder.json as { id?: string } | null)?.id;
				fed = feeder.status < 300 && feederId !== undefined;
				log(
					`${options.scenario}: feeder ${fed ? `${feederId} pushing` : `refused (HTTP ${feeder.status})`}`,
				);
			}
		} else if (!expectedForRun.ingest.feedable) {
			log(
				`${options.scenario}: ${expectedForRun.ingest.kind} is not feedable by our feeder — provisioning and heartbeat are still verified`,
			);
		}

		/**
		 * Feed for the duration that was ASKED for, and sample at both ends of it.
		 *
		 * The first version slept a fixed 12s and ignored `options.feedSeconds` entirely,
		 * then reported the sample gap as the fed duration — which made `live:recorded`
		 * compare a recording against a number that was never the feed length. Its own
		 * test caught it: a 30s request produced a 12s "feed" and an 18s recording, i.e. a
		 * 1.5× ratio on a channel that was behaving perfectly.
		 *
		 * `fedAt` is taken when the feed is actually up, not when the run began, because the
		 * provisioning wait is not feed time and counting it would understate the ratio.
		 */
		const fedAt = deps.now();
		/**
		 * Measure the origin BEFORE the first sample, and let it inform nothing.
		 *
		 * This is a recorded observation, not a gate: nothing branches on it, so a slow origin
		 * cannot turn into a FAIL and a fast one cannot excuse a check. It is here so
		 * `MIN_SAMPLE_GAP_SEC = 10` stops being a guess — the number lands in the run report
		 * next to the constant it is supposed to justify.
		 *
		 * Capped at two minutes: past that the channel has a problem the movement checks will
		 * report anyway, and waiting longer only spends the feed.
		 */
		/**
		 * Bounded by the FEED WINDOW, because the first version broke the experiment.
		 *
		 * I capped this at 120s inside a 45s feed. The measurement therefore ran until long
		 * after the feeder had stopped, and both samples were taken against a dead channel:
		 * `live-redundant-rtmp` and `live-srt-listener` FAILed with
		 * `live:segments: segments must keep being written while the channel runs — 0 → 0` and
		 * `live:media-sequence: … 0 → 0`. `live-rtmp-simple` had PASSed 13 checks before this
		 * was added. An instrument that consumes the thing it measures is the one failure this
		 * file's own header forbids, and I built it in.
		 *
		 * So the cap leaves the engine the two samples it needs, and when the feed is too short
		 * to spare any time the measurement is SKIPPED with a note saying so — never reported as
		 * "not observed", which would blame the origin for a window it was never given.
		 */
		const publishCapSec = Math.floor(
			options.feedSeconds - 2 * MIN_SAMPLE_GAP_SEC,
		);
		const firstPublish =
			publishCapSec >= 5
				? await measureFirstPublish(deps, expectedForRun, publishCapSec)
				: {
						polls: 0,
						note: `not measured: a ${options.feedSeconds}s feed leaves nothing to spare after the ${2 * MIN_SAMPLE_GAP_SEC}s the two movement samples need — measuring anyway would consume the feed it is measuring`,
					};
		deps.log?.(`[verify] ${options.scenario}: ${firstPublish.note}`);
		const first = await sample(
			deps,
			expectedForRun,
			channelId,
			mslOutputs,
			options.rewrite.prefix,
		);
		const remaining = options.feedSeconds * 1000 - (deps.now() - fedAt);
		await deps.sleep(Math.max(remaining, MIN_SAMPLE_GAP_SEC * 1000));
		const second = await sample(
			deps,
			expectedForRun,
			channelId,
			mslOutputs,
			options.rewrite.prefix,
		);
		const fedSeconds = (deps.now() - fedAt) / 1000;

		await stopEverything();

		const liveToVod = liveToVodApplicability(submitted);
		const afterStop =
			"outputKey" in liveToVod
				? await rollToVod(deps, channelId, fedSeconds, liveToVod.outputKey)
				: {
						liveToVodNotApplicable: liveToVod.reason,
						fedSeconds,
					};

		// Collected BEFORE the teardown, while the channel is still writing them.
		const manifestFiles = await collectManifestFiles(deps, expectedForRun);
		// The MSL delivery-mirror legs, read back on the Akamai edge.
		// Empty when there is no edge base URL to
		// read them on — each leg then SKIPs as UNOBSERVED and the run cannot pass
		// on the origin alone.
		const providerOutputIds = Object.fromEntries(
			(second.edge ?? []).flatMap((closure) =>
				closure.msl?.providerOutputId
					? [[closure.outputKey, closure.msl.providerOutputId] as const]
					: [],
			),
		);
		const edgeClosures = await collectEdgeClosures(
			deps,
			expectedForRun,
			mslOutputs,
			providerOutputIds,
			options.rewrite.prefix,
		);
		const report = await verifyLiveChannel(expectedForRun, {
			...(deps.verifyArchives && providerId && expectedForRun.archives?.length
				? {
						archiveChecks: await deps.verifyArchives({
							channelId,
							encodingId: providerId,
							plan: submitted,
						}),
					}
				: {}),
			coordinates,
			samples: [first, second],
			manifestFiles,
			...(edgeClosures.length > 0 ? { edgeClosures } : {}),
			fed,
			...(afterStop ? { afterStop } : {}),
		});
		// First read the local half of the durable teardown seal:
		// local projection, feeder `processGoneAt`, host
		// process and queue. Provider proof is joined only after EV-01 below.
		const localCleanup = await sealCleanup(deps, channelId, temporaryStreamKey);
		// EV-01 owns provider discovery, exact-set teardown and terminal
		// readback. Close it now, after product teardown, before EV-02 assembles
		// any tuple. The local STOPPED projection is never provider evidence.
		const terminalDossier = await closeIntent(localCleanup);
		const providerTerminal = providerTerminalFromIntentDossier(
			terminalDossier,
			{
				channelId,
				...(localCleanup.liveChannelRunId
					? { liveChannelRunId: localCleanup.liveChannelRunId }
					: {}),
				...((localCleanup.providerEncodingId ?? channel.bitmovinEncodingId)
					? {
							providerEncodingId:
								localCleanup.providerEncodingId ?? channel.bitmovinEncodingId,
						}
					: {}),
				providerStreamIds: localCleanup.providerStreamIds,
				providerOutputIds: localCleanup.providerOutputIds,
			},
		);
		const cleanup = finalizeLiveCleanupSeal(localCleanup, {
			established: providerTerminal.confirmed,
			detail: providerTerminal.detail,
		});
		sealedCleanup = cleanup;
		const source = await readFedSourceEvidence(deps, feederId, options.feed);
		// The evidence TUPLE: everything this
		// PASS would be a pass OF, one leg per (manifest, delivery target),
		// sealed by core's completeness rule — assembled here because only this
		// scope holds the submitted plan, both samples, the manifests, the
		// channel detail and the cleanup seal together.
		const evidence = assembleLiveEvidence({
			scenario: options.scenario,
			expected: expectedForRun,
			plan: submitted,
			build: {
				commit: options.evidence?.commit ?? "unknown",
				...(options.evidence?.image ? { image: options.evidence.image } : {}),
				planSha256: sha256Hex(JSON.stringify(submitted)),
			},
			...(source ? { source } : {}),
			channel: {
				channelId,
				...(cleanup.liveChannelRunId
					? { liveChannelRunId: cleanup.liveChannelRunId }
					: {}),
				...((cleanup.providerEncodingId ?? channel.bitmovinEncodingId)
					? {
							providerEncodingId:
								cleanup.providerEncodingId ?? channel.bitmovinEncodingId,
						}
					: {}),
				providerStreamIds: cleanup.providerStreamIds,
				providerOutputIds: cleanup.providerOutputIds,
			},
			outputPrefix: options.rewrite.prefix,
			samples: [first, second],
			manifestFiles,
			mslOutputs,
			cleanup,
			...(terminalDossier ? { intentTerminal: terminalDossier } : {}),
		});
		if (
			stopFailures.length > 0 &&
			terminalDossier?.cleanupState !== "CLEANED"
		) {
			// A leaked channel is a bill, not a test result — INVALID, loudly, whatever the
			// report said. (An unclean seal reaches the same verdict through
			// `outcomeFromLiveResult`, so the two teardown signals are independent.)
			return {
				scenario: options.scenario,
				channelId,
				report,
				submittedPlan: submitted,
				firstPublish,
				cleanup,
				evidence,
				invalid: `the run could not be torn down: ${stopFailures.join("; ")} — check for a RUNNING channel`,
			};
		}
		return {
			scenario: options.scenario,
			channelId,
			report,
			submittedPlan: submitted,
			firstPublish,
			cleanup,
			evidence,
		};
	} catch (err) {
		return {
			scenario: options.scenario,
			...(channelId ? { channelId } : {}),
			invalid: `harness error: ${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		if (intent && channelId && !providerId) {
			// Ambiguous-create paths return before the normal detail read. Recover
			// the exact provider id from the adopted local row before stopping it.
			const detail = await deps
				.api(`/api/live-channels/${channelId}`)
				.catch(() => undefined);
			const observed =
				detail && detail.status < 300
					? (detail.json as { bitmovinEncodingId?: unknown } | null)
							?.bitmovinEncodingId
					: undefined;
			if (typeof observed === "string") {
				providerId = observed;
				await intent.confirmed(channelId, providerId).catch((err) => {
					stopFailures.push(
						`could not persist provider identity before teardown: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
			}
		}
		await stopEverything();
		if (intent && channelId && !intentClosed) {
			// EV-01: close the intent from EVERY exit — the happy path, the
			// ambiguous-create adoption, an exception — with the cleanup seal
			// as its terminal readback. CLEANED only when the seal proved clean
			// and no stop was refused; anything less is UNRESOLVED and the run
			// will not seal. Read after the stop so the seal sees the teardown.
			const seal =
				sealedCleanup ??
				(await sealCleanup(deps, channelId, temporaryStreamKey));
			await closeIntent(seal);
		}
	}
}

type TerminalVodRecord = {
	status?: string;
	attemptId?: string;
	liveChannelRunId?: string;
	outputKey?: string;
	manifests?: unknown[];
	families?: unknown[];
};

type TerminalVodManifest = {
	type: "HLS" | "DASH";
	manifestId: string;
	url: string;
};

function terminalManifest(raw: unknown): TerminalVodManifest | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const candidate = raw as Record<string, unknown>;
	return (candidate.type === "HLS" || candidate.type === "DASH") &&
		typeof candidate.manifestId === "string" &&
		candidate.manifestId.length > 0 &&
		typeof candidate.url === "string" &&
		candidate.url.length > 0
		? {
				type: candidate.type,
				manifestId: candidate.manifestId,
				url: candidate.url,
			}
		: undefined;
}

function malformedTerminalClosure(
	raw: unknown,
	error: string,
): VodClosureResult {
	const candidate =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	return {
		type:
			candidate.type === "HLS" || candidate.type === "DASH"
				? candidate.type
				: "UNKNOWN",
		manifestId:
			typeof candidate.manifestId === "string" && candidate.manifestId
				? candidate.manifestId
				: "(missing-manifest-id)",
		url:
			typeof candidate.url === "string" && candidate.url
				? candidate.url
				: "(missing-manifest-url)",
		closed: false,
		childCount: 0,
		segmentCount: 0,
		error,
	};
}

type VodLocation =
	| { kind: "storage"; key: string }
	| { kind: "edge"; url: string };

const vodLocation = (url: string): VodLocation =>
	/^https?:\/\//i.test(url)
		? { kind: "edge", url }
		: { kind: "storage", key: url.replace(/^\/+/, "") };

/** Directory portion of a storage key, including its trailing slash. */
function dirOfKey(key: string): string {
	const slash = key.lastIndexOf("/");
	return slash < 0 ? "" : key.slice(0, slash + 1);
}

function resolveVodLocation(parent: VodLocation, uri: string): VodLocation {
	if (/^https?:\/\//i.test(uri)) return { kind: "edge", url: uri };
	if (parent.kind === "edge") {
		return { kind: "edge", url: new URL(uri, parent.url).toString() };
	}
	return {
		kind: "storage",
		key: uri.startsWith("/")
			? uri.replace(/^\/+/, "")
			: resolveReferencedKey(dirOfKey(parent.key), uri),
	};
}

async function readVodLocation(
	deps: LiveRunnerDeps,
	outputKey: string,
	location: VodLocation,
): Promise<string> {
	if (location.kind === "edge") {
		if (!deps.readEdge) {
			throw new Error(`no HTTP reader is configured for ${location.url}`);
		}
		const response = await deps.readEdge(location.url);
		if (response.status >= 300 || response.bytes === 0) {
			throw new Error(
				`${location.url} returned HTTP ${response.status} with ${response.bytes} bytes`,
			);
		}
		return response.text;
	}
	const text = await deps.readText(outputKey, location.key);
	if (Buffer.byteLength(text) === 0) {
		throw new Error(`${location.key} is empty`);
	}
	return text;
}

function locationLabel(location: VodLocation): string {
	return location.kind === "edge" ? location.url : location.key;
}

type VodClosureResult = NonNullable<LiveAfterStop["vodClosures"]>[number];

async function closeTerminalHls(
	deps: LiveRunnerDeps,
	outputKey: string,
	manifest: { type: "HLS"; manifestId: string; url: string },
): Promise<{
	closure: VodClosureResult;
	mediaText?: string;
	duration?: number;
}> {
	const root = vodLocation(manifest.url);
	const missing: string[] = [];
	let rootText: string;
	try {
		rootText = await readVodLocation(deps, outputKey, root);
	} catch (err) {
		return {
			closure: {
				...manifest,
				closed: false,
				childCount: 0,
				segmentCount: 0,
				error: err instanceof Error ? err.message : String(err),
			},
		};
	}
	const { parseHlsText } = await import("./adapters");
	let parsedRoot: Awaited<ReturnType<typeof parseHlsText>>;
	try {
		parsedRoot = await parseHlsText(rootText);
	} catch (err) {
		return {
			closure: {
				...manifest,
				closed: false,
				childCount: 0,
				segmentCount: 0,
				error: `root parse failed: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}
	const childUris = [
		...parsedRoot.variants.map((variant) => variant.uri),
		...parsedRoot.media.flatMap((media) => (media.uri ? [media.uri] : [])),
	].filter((uri) => uri.length > 0);
	const children: Array<{ location: VodLocation; text: string }> = [];
	if (childUris.length === 0 && (parsedRoot.segments ?? 0) > 0) {
		children.push({ location: root, text: rootText });
	} else {
		for (const uri of [...new Set(childUris)]) {
			const location = resolveVodLocation(root, uri);
			try {
				children.push({
					location,
					text: await readVodLocation(deps, outputKey, location),
				});
			} catch (err) {
				missing.push(
					`${locationLabel(location)}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	let segmentCount = 0;
	let everyEndlist = children.length > 0;
	let duration = 0;
	let firstMediaText: string | undefined;
	for (const child of children) {
		let parsed: Awaited<ReturnType<typeof parseHlsText>>;
		try {
			parsed = await parseHlsText(child.text);
		} catch (err) {
			missing.push(
				`${locationLabel(child.location)}: parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}
		if (parsed.variants.length > 0 || parsed.media.some((media) => media.uri)) {
			missing.push(`${locationLabel(child.location)}: child is another master`);
			continue;
		}
		if ((parsed.segmentUris?.length ?? 0) === 0) {
			missing.push(`${locationLabel(child.location)}: no media segments`);
		}
		const endlist = /^#EXT-X-ENDLIST\s*$/m.test(child.text);
		everyEndlist &&= endlist;
		firstMediaText ??= child.text;
		const childDuration = [...child.text.matchAll(/#EXTINF:([\d.]+)/g)].reduce(
			(sum, match) => sum + Number(match[1] ?? 0),
			0,
		);
		duration = Math.max(duration, childDuration);
		const rawMaps = [
			...child.text.matchAll(/^#EXT-X-MAP:.*URI="([^"]+)"/gm),
		].map((match) => match[1] as string);
		const references = [
			...rawMaps,
			...(parsed.mapUri ? [parsed.mapUri] : []),
			...(parsed.segmentUris ?? []),
		];
		for (const uri of [...new Set(references)]) {
			const location = resolveVodLocation(child.location, uri);
			segmentCount += 1;
			try {
				await readVodLocation(deps, outputKey, location);
			} catch (err) {
				missing.push(
					`${locationLabel(location)}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	return {
		closure: {
			...manifest,
			closed:
				children.length > 0 &&
				segmentCount > 0 &&
				everyEndlist &&
				missing.length === 0,
			childCount: children.length,
			segmentCount,
			endlist: everyEndlist,
			...(missing.length > 0 ? { missing } : {}),
		},
		...(firstMediaText ? { mediaText: firstMediaText } : {}),
		...(duration > 0 ? { duration } : {}),
	};
}

async function closeTerminalDash(
	deps: LiveRunnerDeps,
	outputKey: string,
	manifest: { type: "DASH"; manifestId: string; url: string },
): Promise<VodClosureResult> {
	const root = vodLocation(manifest.url);
	let text: string;
	try {
		text = await readVodLocation(deps, outputKey, root);
	} catch (err) {
		return {
			...manifest,
			closed: false,
			childCount: 0,
			segmentCount: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	}
	const { parseDashText } = await import("./adapters");
	let parsed: Awaited<ReturnType<typeof parseDashText>>;
	try {
		parsed = await parseDashText(text);
	} catch (err) {
		return {
			...manifest,
			closed: false,
			childCount: 0,
			segmentCount: 0,
			error: `MPD parse failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const playlists = parsed.playlists ?? [];
	const missing: string[] = [];
	if (/\btype\s*=\s*["']dynamic["']/i.test(text)) {
		missing.push("MPD is explicitly dynamic, not a closed VOD presentation");
	}
	let segmentCount = 0;
	for (const playlist of playlists) {
		const refs = [
			...(playlist.mapUri ? [playlist.mapUri] : []),
			...playlist.segmentUris,
		];
		if (refs.length === 0) {
			missing.push(
				`${playlist.kind} ${playlist.id ?? "representation"}: no referenced media`,
			);
			continue;
		}
		for (const uri of [...new Set(refs)]) {
			const location = resolveVodLocation(root, uri);
			segmentCount += 1;
			try {
				await readVodLocation(deps, outputKey, location);
			} catch (err) {
				missing.push(
					`${locationLabel(location)}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	return {
		...manifest,
		closed:
			parsed.representations.length > 0 &&
			playlists.length > 0 &&
			segmentCount > 0 &&
			missing.length === 0,
		childCount: playlists.length,
		segmentCount,
		...(missing.length > 0 ? { missing } : {}),
	};
}

/** Close only the exact URLs and ids exposed by the terminal workflow record. */
export async function collectVodClosures(
	deps: LiveRunnerDeps,
	record: TerminalVodRecord,
): Promise<{
	closures: NonNullable<LiveAfterStop["vodClosures"]>;
	vodManifestText?: string;
	recordedSeconds?: number;
	readError?: string;
}> {
	const outputKey = record.outputKey;
	const raw: unknown[] = Array.isArray(record.manifests)
		? record.manifests
		: [];
	if (!outputKey) {
		return {
			closures: [],
			readError: "terminal live-to-VOD record has no outputKey",
		};
	}
	const closures: NonNullable<LiveAfterStop["vodClosures"]> = [];
	let vodManifestText: string | undefined;
	let recordedSeconds: number | undefined;
	const seen = new Set<string>();
	const seenFamilies = new Set<"HLS" | "DASH">();
	const rawFamilies = Array.isArray(record.families)
		? record.families
		: undefined;
	for (const rawCandidate of raw) {
		const candidate = terminalManifest(rawCandidate);
		if (!candidate) {
			closures.push(
				malformedTerminalClosure(
					rawCandidate,
					"terminal manifests[] contains an invalid identity",
				),
			);
			continue;
		}
		const identity = `${candidate.type}\0${candidate.manifestId}\0${candidate.url}`;
		if (seen.has(identity) || seenFamilies.has(candidate.type)) {
			closures.push({
				type: candidate.type,
				manifestId: candidate.manifestId,
				url: candidate.url,
				closed: false,
				childCount: 0,
				segmentCount: 0,
				error: seenFamilies.has(candidate.type)
					? `duplicate terminal ${candidate.type} family identity`
					: "duplicate terminal manifest identity",
			});
			continue;
		}
		seen.add(identity);
		seenFamilies.add(candidate.type);
		const matchingFamilies = (rawFamilies ?? []).filter(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				(entry as Record<string, unknown>).type === candidate.type,
		);
		const family = matchingFamilies[0] as Record<string, unknown> | undefined;
		if (
			rawFamilies !== undefined &&
			(matchingFamilies.length !== 1 ||
				family?.status !== "FINISHED" ||
				family.manifestId !== candidate.manifestId ||
				family.url !== candidate.url)
		) {
			closures.push({
				type: candidate.type,
				manifestId: candidate.manifestId,
				url: candidate.url,
				closed: false,
				childCount: 0,
				segmentCount: 0,
				error:
					"terminal manifests[] identity does not match its FINISHED family",
			});
			continue;
		}
		if (candidate.type === "HLS") {
			const result = await closeTerminalHls(deps, outputKey, {
				type: "HLS",
				manifestId: candidate.manifestId,
				url: candidate.url,
			});
			closures.push(result.closure);
			vodManifestText ??= result.mediaText;
			if (result.duration !== undefined) {
				recordedSeconds = Math.max(recordedSeconds ?? 0, result.duration);
			}
		} else {
			closures.push(
				await closeTerminalDash(deps, outputKey, {
					type: "DASH",
					manifestId: candidate.manifestId,
					url: candidate.url,
				}),
			);
		}
	}
	if (rawFamilies !== undefined) {
		for (const rawFamily of rawFamilies) {
			if (typeof rawFamily !== "object" || rawFamily === null) {
				closures.push(
					malformedTerminalClosure(
						rawFamily,
						"terminal families[] contains an invalid entry",
					),
				);
				continue;
			}
			const family = rawFamily as Record<string, unknown>;
			if (family.status !== "FINISHED") continue;
			const projected = terminalManifest(family);
			if (!projected) {
				closures.push(
					malformedTerminalClosure(
						rawFamily,
						"FINISHED terminal family has no complete manifest identity",
					),
				);
				continue;
			}
			if (
				!raw.some((candidate) => {
					const manifest = terminalManifest(candidate);
					return (
						manifest?.type === projected.type &&
						manifest.manifestId === projected.manifestId &&
						manifest.url === projected.url
					);
				})
			) {
				closures.push({
					...projected,
					closed: false,
					childCount: 0,
					segmentCount: 0,
					error:
						"FINISHED family is missing from terminal manifests[] projection",
				});
			}
		}
	}
	const failed = closures.filter((closure) => !closure.closed);
	return {
		closures,
		...(vodManifestText ? { vodManifestText } : {}),
		...(recordedSeconds !== undefined && recordedSeconds > 0
			? { recordedSeconds }
			: {}),
		...(failed.length > 0
			? {
					readError: `${failed.length} terminal manifest closure(s) failed: ${failed
						.slice(0, 3)
						.map((closure) => `${closure.type} ${closure.url}`)
						.join(", ")}`,
				}
			: {}),
	};
}

/**
 * Stop a resource, and NOTICE when the product refuses.
 *
 * The first version only `.catch`d, which catches a throw and ignores a returned
 * `{status: 500}` entirely — so a stop the product refused was completely silent and the
 * run reported normally while a channel kept billing. Two attempts, because a transient
 * 5xx on a stop is worth one retry and an unstopped channel is not worth being polite
 * about (review catch). Module-level since EV-01 so the run-level intent teardown
 * can stop an adopted channel with the same rule.
 */
async function stopWithRetry(
	deps: LiveApiDeps,
	path: string,
	what: string,
	stopFailures: string[],
): Promise<boolean> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const res = await deps.api(path, {
				method: "POST",
				body: { action: "stop" },
			});
			if (res.status < 300) {
				return true;
			}
			if (attempt === 2) {
				stopFailures.push(`${what} refused the stop: HTTP ${res.status}`);
			}
		} catch (err) {
			if (attempt === 2) {
				stopFailures.push(
					`${what} stop threw: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		await deps.sleep(1_000);
	}
	return false;
}

/** Stop the channel and wait for the worker's CONFIRMATION, or record the leak. */
async function stopChannelConfirmed(
	deps: LiveApiDeps,
	channelId: string,
	stopFailures: string[],
): Promise<void> {
	const acknowledged = await stopWithRetry(
		deps,
		`/api/live-channels/${channelId}/actions`,
		`channel ${channelId}`,
		stopFailures,
	);
	if (!acknowledged) {
		return;
	}
	// A 2xx is an ACKNOWLEDGEMENT: the route answers STOPPING and the
	// worker confirms STOPPED later .
	// `stopped = true` on the 2xx alone is how a run reported a clean
	// teardown over an encoder that kept billing. Wait for the
	// confirmation, and treat its absence as the leak it is.
	const confirmed = await awaitStatus({
		read: async () => {
			const res = await deps.api(`/api/live-channels/${channelId}`);
			return (res.json as { status?: string } | null)?.status;
		},
		wanted: ["STOPPED", "ERROR"],
		sleep: () => deps.sleep(POLL_MS),
		now: deps.now,
		budgetMs: STOP_CONFIRM_MS,
	});
	if (!confirmed.reached) {
		stopFailures.push(
			`channel ${channelId} stop was acknowledged but never CONFIRMED — status ${confirmed.status} after ${STOP_CONFIRM_MS / 1000}s; the encoder may still be billing`,
		);
	} else if (confirmed.status === "ERROR") {
		stopFailures.push(
			`channel ${channelId} reported ERROR after the stop — the stop did not confirm at the provider`,
		);
	}
}

/**
 * EV-01: the run-level teardown of a live intent the scenario loop did not
 * close — a channel adopted by its key after this process lost the response,
 * or a CONFIRMED channel whose TERMINAL write never landed. Stops every
 * active feeder the product lists for the channel, stops the channel,
 * waits for the confirmation, and reads the durable cleanup seal. The
 * caller decides CLEANED vs UNRESOLVED from what comes back.
 */
export async function teardownAdoptedChannel(
	deps: LiveApiDeps,
	channelId: string,
): Promise<{
	stopFailures: string[];
	cleanup: LiveCleanupSeal;
	providerId?: string;
}> {
	const stopFailures: string[] = [];
	// Identity readback happens before STOP. A channel can remain locally
	// addressable after stop, but recovery must not depend on that provider
	// projection surviving provider teardown or a later reset.
	const detail = await deps
		.api(`/api/live-channels/${channelId}`)
		.catch(() => undefined);
	const providerId =
		detail && detail.status < 300
			? (detail.json as { bitmovinEncodingId?: unknown } | null)
					?.bitmovinEncodingId
			: undefined;
	const list = await deps
		.api(`/api/feeder-sessions?liveChannelId=${channelId}&queue=1`)
		.catch(() => undefined);
	const items =
		list && list.status < 300
			? ((list.json as { items?: unknown } | null)?.items ?? [])
			: [];
	for (const row of Array.isArray(items) ? items : []) {
		const feeder = row as { id?: unknown; status?: unknown };
		if (
			typeof feeder.id === "string" &&
			(feeder.status === "CREATED" ||
				feeder.status === "DOWNLOADING" ||
				feeder.status === "PUSHING")
		) {
			await stopWithRetry(
				deps,
				`/api/feeder-sessions/${feeder.id}/actions`,
				`feeder ${feeder.id}`,
				stopFailures,
			);
		}
	}
	await stopChannelConfirmed(deps, channelId, stopFailures);
	return {
		stopFailures,
		cleanup: await sealCleanup(deps, channelId, undefined),
		...(typeof providerId === "string" ? { providerId } : {}),
	};
}

/**
 * Roll the stopped channel to VOD and read back what it produced.
 *
 * Returns `undefined` rather than a half-filled object when the roll could not even be
 * requested, so the engine SKIPs the post-stop checks with its own reason instead of
 * failing them on our behalf.
 */
async function rollToVod(
	deps: LiveRunnerDeps,
	channelId: string,
	fedSeconds: number,
	outputKey: string,
): Promise<LiveAfterStop | undefined> {
	const requested = await deps
		.api(`/api/live-channels/${channelId}/live-to-vod`, {
			method: "POST",
			body: { outputKey },
		})
		.catch((err: unknown) => ({
			threw: err instanceof Error ? err.message : String(err),
		}));
	if ("threw" in requested) {
		// A harness-side fault: the request never reached the product.
		return { readError: `live-to-VOD request threw: ${requested.threw}` };
	}
	if (requested.status >= 300) {
		// The PRODUCT refused the roll. Returning `undefined` here made the
		// engine SKIP every post-stop check "because the channel was not
		// stopped" — and a scenario whose recording was refused scored PASS
		// . A refusal is a status the
		// `live:to-vod` check can fail on.
		return { liveToVodStatus: `REFUSED (HTTP ${requested.status})` };
	}
	const requestedIdentity = requested.json as {
		attemptId?: unknown;
		liveChannelRunId?: unknown;
	} | null;
	const requestedAttemptId =
		typeof requestedIdentity?.attemptId === "string"
			? requestedIdentity.attemptId
			: "";
	const requestedRunId =
		typeof requestedIdentity?.liveChannelRunId === "string"
			? requestedIdentity.liveChannelRunId
			: "";
	if (requestedAttemptId === "" || requestedRunId === "") {
		return {
			liveToVodStatus: "UNATTRIBUTED",
			vodClosures: [],
			readError:
				"live-to-VOD request succeeded without an exact attemptId/liveChannelRunId identity, so no terminal record can be attributed to this run",
			fedSeconds,
		};
	}

	// Bitmovin has no live-to-VOD API — this is our own workflow — so the terminal state
	// is ours to poll. The request above carries NO body on purpose: the product's
	// default is "every family the recorded muxings support" ( — a TS-only
	// recording rolls HLS alone, never a DASH the provider refuses), and the harness
	// must exercise that default rather than name families itself. PARTIAL is
	// terminal too (one family finished, another failed); the `live:to-vod` check
	// still requires FINISHED, so a partial roll fails it with its own status.
	const deadline = deps.now() + 10 * 60 * 1000;
	let liveToVodStatus: string | undefined;
	let terminalRecord: TerminalVodRecord | undefined;
	let terminalIdentityError: string | undefined;
	while (deps.now() < deadline) {
		const res = await deps
			.api(`/api/live-channels/${channelId}`)
			.catch(() => undefined);
		const record = (res?.json as { liveToVod?: TerminalVodRecord } | null)
			?.liveToVod;
		liveToVodStatus = record?.status;
		if (
			liveToVodStatus === "FINISHED" ||
			liveToVodStatus === "PARTIAL" ||
			liveToVodStatus === "ERROR"
		) {
			if (
				record?.attemptId !== requestedAttemptId ||
				record.liveChannelRunId !== requestedRunId
			) {
				terminalIdentityError = `terminal live-to-VOD identity ${record?.attemptId ?? "missing"}/${record?.liveChannelRunId ?? "missing"} does not match requested ${requestedAttemptId}/${requestedRunId}`;
				liveToVodStatus = `UNATTRIBUTED ${liveToVodStatus}`;
			} else {
				terminalRecord = record;
			}
			break;
		}
		await deps.sleep(POLL_MS);
	}

	const closure = terminalRecord
		? await collectVodClosures(deps, terminalRecord)
		: {
				closures: [],
				readError:
					terminalIdentityError ??
					`live-to-VOD never exposed a terminal record (last status ${liveToVodStatus ?? "none"})`,
			};

	return {
		...(liveToVodStatus !== undefined ? { liveToVodStatus } : {}),
		vodClosures: closure.closures,
		...(closure.vodManifestText !== undefined
			? { vodManifestText: closure.vodManifestText }
			: {}),
		...(closure.readError !== undefined
			? { readError: closure.readError }
			: {}),
		fedSeconds,
		...(closure.recordedSeconds !== undefined && closure.recordedSeconds > 0
			? { recordedSeconds: closure.recordedSeconds }
			: {}),
	};
}

/**
 * Select one concrete storage output that contains every recorded muxing.
 *
 * A shared primary qualifies when every muxing targets it. A delivery mirror
 * also qualifies because the compiler writes every muxing to every mirror.
 * AKAMAI_MSL never qualifies: it is a live ingest destination, not readable
 * storage for a VOD manifest. Returning a reason keeps an intentional skip
 * distinct from a channel that was never stopped.
 */
function liveToVodApplicability(
	plan: LiveChannelPlan,
): { outputKey: string } | { reason: string } {
	const outputs = new Map(plan.outputs.map((output) => [output.key, output]));
	if (
		plan.muxings.length === 0 ||
		plan.muxings.some((muxing) => !muxing.destination)
	) {
		return {
			reason:
				"live-to-VOD is not applicable because the recording has no complete storage destination",
		};
	}
	const primaryKeys = new Set(
		plan.muxings.map((muxing) => muxing.destination?.outputKey),
	);
	if (primaryKeys.size === 1) {
		const primaryKey = [...primaryKeys][0];
		const primary = primaryKey ? outputs.get(primaryKey) : undefined;
		if (primary && primary.kind !== "AKAMAI_MSL") {
			return { outputKey: primary.key };
		}
	}
	for (const mirror of plan.deliveryMirrors ?? []) {
		const output = outputs.get(mirror.outputKey);
		if (output && output.kind !== "AKAMAI_MSL") {
			return { outputKey: output.key };
		}
	}
	return {
		reason:
			"live-to-VOD is not applicable because this recording exists only on Akamai MSL; MSL delivery is verified on the edge instead",
	};
}
