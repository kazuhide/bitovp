/**
 * `verify preflight` — measure what can actually be verified, and name what cannot.
 *
 * The guarantee this harness makes is exact : every scenario is
 * either machine-verified green, or a SKIP with the specific resource that would open
 * it. There is no third state, and preflight is what keeps that honest — it is the only
 * place allowed to decide a scenario is out of reach, and it must say why.
 *
 * A commitment does not open a gate; a registered, reachable credential does. That
 * distinction is deliberate: "the owner will provide Azure" and "Azure works" are
 * different facts, and a harness that conflates them reports coverage it does not have.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EncodingPlan, LiveChannelPlan } from "@bitovp/core";
import {
	cipherFromEnv,
	encodingPlanSchema,
	liveChannelPlanSchema,
} from "@bitovp/core";
import {
	buildPlan,
	buildSubmissionPlan,
	planToWizardState,
} from "@bitovp/core/wizard";

/**
 * The account id `buildSubmissionPlan` stamps here is irrelevant and deliberately obvious.
 *
 * `rewriteForRun` replaces `bitmovin.accountId` with the registered account before anything is
 * submitted, so what matters at this stage is only that the plan is well-formed. A recognisable
 * placeholder makes it unmistakable if it ever reaches Bitmovin.
 */
const PLACEHOLDER_ACCOUNT = "00000000-0000-4000-8000-00000000acc7";

import type { AppPrismaClient, CredentialProvider } from "@bitovp/db";
import { createCredentialStore } from "@bitovp/db";
import { createBrowserForCredential } from "@bitovp/storage";

/** A capability a scenario may depend on. */
export type Capability =
	| "S3"
	| "AZURE"
	/** GCS reached with an HMAC key pair — what the S3-compatible driver uses. */
	| "GCS"
	/**
	 * GCS reached with a service-account JSON. A SEPARATE capability from `GCS`, and
	 * that separation was a review catch with a real cost: collapsing the two made
	 * `gcs-service-account-io` count as runnable on the registered HMAC credentials,
	 * which cannot satisfy it — one scenario that would have failed opaquely mid-run
	 * instead of being a named SKIP, and the whole point of preflight is that the
	 * second thing never happens. §3a reserved this decision for the owner; until a
	 * service-account credential is registered the scenario says what it needs.
	 */
	| "GCS_SERVICE_ACCOUNT"
	| "AKAMAI"
	/**
	 * An Akamai MSL delivery target: a stream PROVISIONED at Akamai, identified
	 * by `streamId` + `eventName` . Distinct from `AKAMAI`, which
	 * is Akamai/Linode object storage reached over GenericS3 — MSL has no
	 * bucket and nothing to BROWSE, and no storage driver can read back its
	 * artefacts.
	 *
	 * It IS satisfiable, though: since 2026-08-23 an `AKAMAI_MSL` credential
	 * carrying `streamId` + `eventName` evidences this capability through the
	 * KANTAR-style decrypt arm rather than the browse path — see
	 * `capabilityOfIoKind`'s AKAMAI_MSL case below, which records the incident
	 * where it returned undefined and left `live-akamai-msl` in the never-run
	 * column while a complete MSL credential was registered.
	 *
	 * (This docblock said "no credential… no stored credential can ever satisfy
	 * it" and called it "a capability nobody can currently satisfy" until
	 * 2026-08-25 — false in two ways at once, in the comment that explains which
	 * scenarios are runnable. Found in review of AA972-CONTRACT-002; the
	 * phrase-grep sweep for "MSL has no credential" could not see it because it
	 * is the same claim in different words.)
	 *
	 * Declared because the alternative is what shipped for one commit:
	 * `capabilityOfIoKind` ends in `default: return undefined` — "needs nothing
	 * registered" — so an MSL channel was counted RUNNABLE and would have been
	 * provisioned against a stream id belonging to nobody.
	 */
	| "AKAMAI_MSL"
	/** Origin receiver acceptance is not measured by the storage harness. */
	| "LIVE_MEDIA_INGEST"
	/**
	 * An Akamai NetStorage upload account: host + username + password (ledger
	 * #138). A vault credential like SFTP's, and like SFTP nothing in this repo
	 * can browse it — NetStorage speaks its own HTTP API, not S3 — so a run can
	 * prove the encoder accepted the output but not that the files arrived.
	 *
	 * Separate from `AKAMAI`, which is Akamai/Linode OBJECT storage over
	 * GenericS3 and is satisfied today. Collapsing them would count NetStorage
	 * scenarios as runnable on a key pair that cannot authenticate to them.
	 */
	| "AKAMAI_NETSTORAGE"
	/**
	 * An SFTP host. Declared even though `job.ts` cannot browse SFTP, because the
	 * alternative — which is what shipped — was that the two `dash-hls-sftp-output-*`
	 * fixtures counted as runnable on their S3 INPUT alone and then failed opaquely
	 * with nothing to fetch. A capability nobody can currently satisfy is the honest
	 * encoding of "not verifiable yet".
	 */
	| "SFTP"
	/**
	 * A generic mezzanine the bootstrap can synthesize from the BBB master (audio-only
	 * WAV, video-only MP4, the two concatenation parts…). Separate from `S3` because
	 * the first run of preflight reported 42 scenarios "blocked by S3" while S3 was
	 * demonstrably working — the blocker was a placeholder SOURCE, and calling that a
	 * cloud problem sent the reader to the wrong place entirely.
	 */
	| "GENERIC_ASSETS"
	| "DOLBY_ASSETS"
	/**
	 * A source whose ROLE the single staged mezzanine cannot fill.
	 *
	 * `rewriteForRun` collapses every source path in a plan to the one object the run stages,
	 * and its comment asserted that "a scenario that genuinely needs several distinct sources
	 * … is gated by preflight, so it never reaches here with the wrong asset". That premise was
	 * false, and nothing enforced it: the gate matched only literal placeholders like
	 * `<INSERT…>`, so every plan naming a REAL upstream path — `sintel/subtitles_en.vtt`,
	 * `netflix-opencontent/SolLevante/…atmos` — sailed through needing nothing but `S3`.
	 *
	 * A real corpus run then submitted seven doomed encodings and billed for them: five Dolby
	 * scenarios reading an H.264 `.mov` as an Atmos master ("Could not find audio file
	 * reference in Dolby Atmos Master File big_buck_bunny_1080p_h264_short.mov") and two VTT
	 * scenarios reading it as WebVTT ("Problem with processing input"). Each was then reported
	 * as a product FAIL.
	 *
	 * Derived from the plan's STRUCTURE, never from a filename: a `fileStreams` entry declares
	 * its `fileType`, so a WEBVTT stream demonstrably needs a WebVTT file. Extension sniffing
	 * would have been a third guess in a chain of guesses.
	 */
	| "TYPED_SOURCE_ASSETS"
	| "HDR10_ASSET"
	| "KANTAR"
	| "ZIXI"
	| "POIS"
	/**
	 * A reserved static IP and/or a Cloud Connect infrastructure, both owner-specific.
	 *
	 * `live-static-ip` carries placeholder ids (`…-0000000000d1`, `…-0000000000c1`) that do
	 * not exist in the verify account. Submitting it would provision a channel against a
	 * static IP that is not ours — and the schema notes an already-USED IP puts the encoding
	 * in ERROR — so the scenario would fail for a reason that is not the product's. A named
	 * SKIP is the honest verdict until real ids are registered (review catch: the run
	 * rewrite repoints the account, credential and bucket and cannot repoint these, because
	 * there is nothing to repoint them TO).
	 */
	/**
	 * A DRM key-provider credential (CENC/FairPlay), which the run rewrite cannot repoint.
	 *
	 * It repoints storage credentials at the harness's own; a DRM row's `credentialId` names a
	 * key provider, and there is nothing to repoint it TO. Five fixtures carry placeholder ids,
	 * and their first real run failed with `Storage credential no longer exists` — a product
	 * error message for a harness omission, which is the worst kind of failure to read.
	 */
	| "DRM_CREDENTIAL"
	/** A NexGuard watermarking credential — same shape, same reason. */
	| "NEXGUARD"
	| "LIVE_INFRA"
	/**
	 * A reachable external SRT sender for a CALLER-mode input.
	 *
	 * SRT CALLER means BITMOVIN dials out to a host:port to pull — so it needs a source
	 * listening out there, and the fixture points at `203.0.113.10`, a documentation-range
	 * address that answers nothing. Our feeder cannot substitute: it pushes, and a CALLER
	 * input does not accept a push. Gated for the same reason ZIXI is, and found because a
	 * distinctness test showed `live-srt-caller` and `live-zixi` verifying identically —
	 * both can only be provisioned, never fed.
	 */
	| "SRT_SOURCE"
	/**
	 * A SPECIFIC encoder-version pin ( Track 2a / Track 1's
	 * premise). `live-pinned-encoder` pins a literal version; whether that
	 * build exists on the account is environmental fact nobody has verified
	 * — running it unregistered would fail for environment reasons and read
	 * as a product FAIL. Track 1's protocol supplies the real tag and
	 * registers this capability; until then the fixture is a named SKIP
	 * whose compile-time value (the golden pins the literal into
	 * CREATE_ENCODING) already stands.
	 */
	| "PINNED_ENCODER_VERSION";

export type CapabilityState = {
	capability: Capability;
	satisfied: boolean;
	/** How it was established — a measurement, never an assumption. */
	evidence: string;
};

export type ScenarioPlan = {
	name: string;
	kind: "VOD" | "LIVE";
	plan: EncodingPlan | null;
	/**
	 * The parsed LIVE plan, for `kind: "LIVE"`.
	 *
	 * A live channel is a different schema, so it cannot ride in `plan` — and the phase-B
	 * runner would try to rewrite it as a VOD plan if it did. Carried here so phase C's
	 * runner has something to run: before this, live scenarios reached the runner with
	 * `plan: null` and the only honest thing it could say was "phase C".
	 */
	livePlan?: LiveChannelPlan;
	/** Capabilities this scenario cannot run without. */
	needs: Capability[];
	/** Source objects the plan reads, so the asset bootstrap knows its work. */
	sources: string[];
	/** Set when the plan itself could not be parsed — never silently dropped. */
	invalid?: string;
	/**
	 * Which of the wizard's TWO submit paths produced the plan being verified.
	 *
	 * `wizard.tsx` submits `imported ? buildSubmissionPlan(imported, accountId) : buildPlan(state)`.
	 * Both are real product paths, so the corpus uses whichever an operator would have to use:
	 * the FORM path wherever the form can author the scenario (67 of 68), and the IMPORT path for
	 * the one it cannot. Reported per scenario, because "verified" means less if the reader
	 * cannot tell which half of the product was exercised.
	 */
	submittedVia: "wizard-form" | "wizard-import";
	/**
	 * Set when the FORM path could not reproduce the fixture, with the exact field.
	 *
	 * Not a failure by itself — the import path is legitimate — but it is the honest record of
	 * what the form cannot author, and it is how a regression in `buildPlan` would surface in a
	 * real run rather than only in a unit test.
	 */
	wizardDivergence?: string;
};

export type PreflightReport = {
	capabilities: CapabilityState[];
	scenarios: (ScenarioPlan & {
		runnable: boolean;
		blockedBy: Capability[];
	})[];
	counts: { runnable: number; blocked: number; invalid: number };
};

const VOD_FIXTURES = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"packages",
	"core",
	"src",
	"plan",
	"__fixtures__",
);
const LIVE_FIXTURES = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"packages",
	"core",
	"src",
	"live",
	"__fixtures__",
);

/**
 * Placeholder source paths mean "the owner must supply this asset".
 *
 * The corpus spells them several ways, because they came from different encoding examples
 * scripts: `<INSERT_…>`, `<REDACTED_…>`, `{YOUR …}`, `/path/to/your/…`. Matching only
 * one spelling would quietly mark a Dolby scenario runnable and then fail it opaquely
 * 18 times over — which is precisely the failure the design's D3 note warns about.
 */
const PLACEHOLDER_SOURCE =
	/^<.*>$|^\{.*\}$|^\/path\/to\/your\/|<INSERT|<REDACTED/i;

/** Assets that exist publicly and the bootstrap can fetch without the owner. */
const PUBLIC_SOURCE =
	/^netflix-opencontent\/|^sollevante_|^sintel\/|^big_buck_bunny/i;

/**
 * An input/output kind → the capability it needs, or `undefined` for kinds that need
 * nothing registered (HTTP/HTTPS sources, LOCAL).
 *
 * Shared by the VOD and live paths so the two can never drift, which they did: live was
 * classified by filename regex while VOD switched on the kind.
 */
export function capabilityOfIoKind(kind: string): Capability | undefined {
	switch (kind) {
		case "AZURE":
			return "AZURE";
		case "GCS":
			return "GCS";
		case "GCS_SERVICE_ACCOUNT":
			return "GCS_SERVICE_ACCOUNT";
		case "SFTP":
			return "SFTP";
		case "GENERIC_S3":
			return "AKAMAI";
		case "AKAMAI_MSL":
			return "AKAMAI_MSL";
		case "LIVE_MEDIA_INGEST":
			return "LIVE_MEDIA_INGEST";
		case "AKAMAI_NETSTORAGE":
			return "AKAMAI_NETSTORAGE";
		case "S3":
			return "S3";
		default:
			return undefined;
	}
}

/**
 * The parsed live plan, or nothing — never a throw.
 *
 * `liveNeeds` has already reported an honest `invalid` for unparseable JSON or a plan that
 * fails the schema, so this only has to avoid taking the run down with it.
 */
function parsedLivePlan(raw: string): { livePlan?: LiveChannelPlan } {
	try {
		const result = liveChannelPlanSchema.safeParse(JSON.parse(raw));
		return result.success ? { livePlan: result.data } : {};
	} catch {
		return {};
	}
}

/**
 * A live fixture's capabilities, derived by PARSING it.
 *
 * Returns the `needs`/`invalid` pair so a live plan that no longer satisfies its own
 * schema is reported as INVALID rather than silently classified. Zixi and ESAM are read
 * off the ingest kind and the SCTE-35 source, which is where they actually live.
 */
function liveNeeds(raw: string): {
	needs: Capability[];
	sources: string[];
	invalid?: string;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			needs: [],
			sources: [],
			invalid: `unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const result = liveChannelPlanSchema.safeParse(parsed);
	if (!result.success) {
		return {
			needs: [],
			sources: [],
			invalid: result.error.issues
				.slice(0, 3)
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; "),
		};
	}
	const plan = result.data;
	const needs = new Set<Capability>();
	// The live source is a single discriminated union at `liveInput`, not an `ingest`
	// array — reading the shape rather than the filename is the whole point of this
	// function, so it reads the field that actually exists.
	if (plan.liveInput.kind === "ZIXI") {
		needs.add("ZIXI");
	}
	// ESAM is out-of-band POIS: it needs a reachable POIS endpoint, wherever the plan
	// puts it (`start.esam`, or the ad-marker block).
	if (plan.start?.esam !== undefined) {
		needs.add("POIS");
	}
	for (const output of plan.outputs ?? []) {
		const cap = capabilityOfIoKind(output.kind);
		if (cap) {
			needs.add(cap);
		}
	}
	// Owner-specific infrastructure the run rewrite cannot repoint, because there is no id
	// to repoint it to. Better a named SKIP than a channel provisioned against someone
	// else's static IP.
	if (
		plan.bitmovin.staticIpId !== undefined ||
		plan.bitmovin.infrastructure !== undefined
	) {
		needs.add("LIVE_INFRA");
	}
	if (
		plan.liveInput.kind === "SRT" &&
		(plan.liveInput as { mode?: string }).mode === "CALLER"
	) {
		needs.add("SRT_SOURCE");
	}
	// #162 Track 2a: a literal version pin is an environmental prerequisite —
	// STRUCTURAL (any non-alias value), so the next pinned fixture is covered
	// the day it lands, not when someone remembers this list.
	const encoderVersion = plan.bitmovin.encoderVersion;
	if (
		encoderVersion !== undefined &&
		encoderVersion !== "STABLE" &&
		encoderVersion !== "BETA"
	) {
		needs.add("PINNED_ENCODER_VERSION");
	}
	return { needs: [...needs].sort(), sources: [] };
}

export function sourcesOf(plan: EncodingPlan): string[] {
	const paths = new Set<string>();
	for (const s of plan.ingest ?? []) {
		paths.add(s.inputPath);
	}
	for (const s of plan.fileStreams ?? []) {
		if ("inputPath" in s && typeof s.inputPath === "string") {
			paths.add(s.inputPath);
		}
	}
	for (const s of plan.dolbyStreams ?? []) {
		// Three fields, not one. A review found only `inputPath` was read, so the DV
		// mezzanine (14 distinct values) and the metadata XML sidecar (13) were absent
		// from `sources` — and `sources` is documented as exactly what the phase-B
		// bootstrap stages, so the bootstrap would have been told to stage a shorter
		// list than the run needs. Two placeholder spellings live ONLY here.
		for (const field of [
			"inputPath",
			"videoInputPath",
			"metadataInputPath",
		] as const) {
			const value = (s as Record<string, unknown>)[field];
			if (typeof value === "string" && value.length > 0) {
				paths.add(value);
			}
		}
	}
	return [...paths].sort();
}

/**
 * Rebuild a fixture through the wizard's own code path.
 *
 * `planToWizardState` is the wizard's import (the "load a preset / paste a plan" path) and
 * `buildPlan` is what the Submit button calls. Running both reproduces exactly what an operator
 * would post, so the corpus verifies the product's output rather than its input.
 *
 * A divergence is REPORTED, never silently preferred one way or the other: the wizard's plan is
 * what gets submitted (that is the whole point), and the difference is carried on the scenario
 * so the run report can name it. If the wizard cannot round-trip a scenario, that is a defect in
 * the wizard and the corpus is the right place for it to surface.
 */
export function planViaWizard(raw: string): {
	plan?: unknown;
	divergence?: string;
} {
	let fixture: unknown;
	try {
		fixture = JSON.parse(raw);
	} catch {
		// Malformed JSON is handled by the caller's safeParse, which reports it properly.
		return {};
	}
	if (typeof fixture !== "object" || fixture === null) {
		return {};
	}
	try {
		const state = planToWizardState(fixture as Record<string, unknown>);
		const built = buildPlan(state);
		/**
		 * Compared AFTER the schema parse, on both sides.
		 *
		 * My first version diffed the raw fixture against the wizard's pre-parse output and
		 * reported 48 of 66 as divergent — almost all of it schema defaults being applied on one
		 * side and not the other (`renditions.0.mode: fixture undefined vs wizard "STANDARD"`).
		 * The parse is what the server applies to both, so it is the only comparison that means
		 * anything; anything surviving it is a real difference in what gets submitted.
		 */
		const parsedBuilt = encodingPlanSchema.safeParse(built);
		const parsedFixture = encodingPlanSchema.safeParse(fixture);
		if (!parsedBuilt.success) {
			return {
				plan: built,
				divergence: `the wizard's rebuild does not satisfy the plan schema: ${parsedBuilt.error.issues
					.slice(0, 2)
					.map((i) => `${i.path.join(".")}: ${i.message}`)
					.join("; ")}`,
			};
		}
		if (!parsedFixture.success) {
			// The fixture itself is broken; the caller reports that properly.
			return { plan: built };
		}
		return {
			plan: built,
			...(stableJson(parsedBuilt.data) === stableJson(parsedFixture.data)
				? {}
				: {
						divergence:
							firstDifference(parsedFixture.data, parsedBuilt.data) ??
							"shape differs",
					}),
		};
	} catch (err) {
		return {
			divergence: `the wizard could not rebuild this plan: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/** Key-order-independent serialisation, so a reordered object is not a difference. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([x], [y]) => x.localeCompare(y));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The first path where the two plans differ, so a divergence is actionable.
 *
 * "the plans differ" sends the reader to a 2,000-line diff; "muxings.3.segmentNaming" sends
 * them to the line.
 */
function firstDifference(
	want: unknown,
	got: unknown,
	path: string[] = [],
): string | undefined {
	if (stableJson(want) === stableJson(got)) {
		return undefined;
	}
	const here = path.join(".") || "(root)";
	if (
		want === null ||
		got === null ||
		typeof want !== "object" ||
		typeof got !== "object"
	) {
		return `${here}: fixture ${JSON.stringify(want)} vs wizard ${JSON.stringify(got)}`;
	}
	if (Array.isArray(want) !== Array.isArray(got)) {
		return `${here}: one is an array and the other is not`;
	}
	if (Array.isArray(want) && Array.isArray(got)) {
		if (want.length !== got.length) {
			return `${here}: fixture has ${want.length} item(s), wizard has ${got.length}`;
		}
		for (let i = 0; i < want.length; i++) {
			const d = firstDifference(want[i], got[i], [...path, String(i)]);
			if (d) {
				return d;
			}
		}
		return undefined;
	}
	const w = want as Record<string, unknown>;
	const g = got as Record<string, unknown>;
	const keys = [...new Set([...Object.keys(w), ...Object.keys(g)])].sort();
	for (const k of keys) {
		const d = firstDifference(w[k], g[k], [...path, k]);
		if (d) {
			return d;
		}
	}
	return undefined;
}

/**
 * The shortest source this plan can be run against, in seconds — or `undefined` when the plan
 * places no lower bound on it.
 *
 * The harness stages ONE mezzanine for every scenario, and some scenarios need a longer one.
 * `trimming-time-based` asks for `offset: 10, duration: 30` — a 40-second window — and the
 * staged file is 10.04 seconds, so Bitmovin answered `Internal encoding error occurred. Please
 * contact support` and the run recorded it as a product failure. It was the harness handing an
 * impossible job to the encoder, the same mistake as pointing an Atmos master at an H.264 `.mov`.
 *
 * Derived from the plan's own numbers, never from a filename or a hand-kept list, so a new
 * fixture is covered the day it lands.
 *
 * Two contributors, and the second one I got wrong first.
 *
 *   TIME_BASED trims: `offset + duration` is the window the encoder must find.
 *
 *   thumbnail positions in SECONDS. I originally excluded these, reasoning that
 *   `sprites-trickplay` samples every 10s on the same source and passes, so a position at the
 *   boundary must be fine. It is not, and the next real run said so exactly:
 *   `Setting up encoding configuration failed! No valid thumbnail positions set!` A sprite
 *   INTERVAL that runs past the end simply yields fewer tiles; a thumbnail POSITION past the
 *   end has no frame to grab. The two are not the same shape and I had reasoned by analogy.
 *
 * The number to compare against is the VIDEO stream's duration, not the container's: the probe
 * reported `217 frames @ 24.000fps` and `durationSec 10.04`, so the video ends at 217/24 = 9.04s
 * and the container is longer only because the audio track is. A position at 10s is past the
 * last frame — arithmetic, not a guessed margin. The caller supplies that duration.
 */
export function requiredSourceSeconds(plan: EncodingPlan): number | undefined {
	let need = 0;
	for (const trim of plan.trimmingStreams ?? []) {
		if (trim.kind !== "TIME_BASED") {
			continue;
		}
		const offset = typeof trim.offset === "number" ? trim.offset : 0;
		const duration = typeof trim.duration === "number" ? trim.duration : 0;
		need = Math.max(need, offset + duration);
	}
	for (const thumb of plan.thumbnails ?? []) {
		if (thumb.unit !== "SECONDS") {
			// PERCENT positions scale to whatever the source is, so they place no bound.
			continue;
		}
		for (const position of thumb.positions ?? []) {
			if (typeof position === "number") {
				// STRICTLY greater: a frame must exist AT the position, so a source exactly that
				// long is not enough. `Math.nextUp` would be pedantry; the smallest real margin
				// is one frame and the caller compares `need > available`.
				need = Math.max(need, position);
			}
		}
	}
	return need > 0 ? need : undefined;
}

/**
 * The VIDEO stream's duration from a probe, which is what a thumbnail position must fit inside.
 *
 * `durationSec` is the CONTAINER's, and on the staged mezzanine it is 10.04s while the video
 * ends at 9.04s because the audio track is longer. Comparing a thumbnail position against the
 * container duration is what let `positions: [10]` through to the encoder.
 */
export function videoSeconds(probe: {
	durationSec?: number;
	fps?: number;
	nbFrames?: number;
}): number | undefined {
	if (
		probe.nbFrames !== undefined &&
		probe.fps !== undefined &&
		probe.fps > 0
	) {
		return probe.nbFrames / probe.fps;
	}
	return probe.durationSec;
}

/**
 * The typed sources the corpus declares, and which of them exist.
 *
 * A typed source is a `fileStreams` entry with a declared `fileType` — a WebVTT subtitle today.
 * It cannot be satisfied by substituting the video mezzanine at any price, which is why it is
 * gated; but "cannot substitute" is not "does not exist", and conflating the two is what kept
 * four scenarios dark.
 */
async function measureTypedAssets(
	options: { prisma: AppPrismaClient },
	log: (line: string) => void,
): Promise<{ wanted: string[]; resolved: string[] }> {
	const wanted = new Set<string>();
	for (const scenario of loadScenarios()) {
		for (const stream of scenario.plan?.fileStreams ?? []) {
			if (
				"fileType" in stream &&
				typeof stream.fileType === "string" &&
				"inputPath" in stream &&
				typeof stream.inputPath === "string"
			) {
				wanted.add(stream.inputPath);
			}
		}
	}
	if (wanted.size === 0) {
		return { wanted: [], resolved: [] };
	}
	const prefix = process.env.VERIFY_ASSET_PREFIX ?? "general/";
	const bucket = process.env.VERIFY_S3_INPUT_BUCKET ?? "ap-northeast-1-input";
	const label = process.env.VERIFY_S3_LABEL ?? "verify-aws";
	try {
		const credentials = createCredentialStore(options.prisma, cipherFromEnv());
		const row = (await credentials.list()).find((r) =>
			r.label.startsWith(label),
		);
		if (!row) {
			return { wanted: [...wanted], resolved: [] };
		}
		const browser = createBrowserForCredential({
			provider: row.provider,
			config: (row.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(await credentials.revealSecret(row.id)) as Record<
				string,
				string
			>,
		});
		const keys = new Set<string>();
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await browser.listObjects({
				bucket,
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
		const resolved = [...wanted].filter(
			(w) => keys.has(`${prefix}${w}`) || keys.has(w),
		);
		log(
			`typed sources: ${resolved.length}/${wanted.size} resolve in ${bucket} under "${prefix}" (${keys.size} object(s) listed)`,
		);
		return { wanted: [...wanted], resolved };
	} catch (err) {
		// NAMED. An unlistable bucket must not read as "the assets are missing".
		log(
			`typed sources: could not list ${bucket} — ${err instanceof Error ? err.message : String(err)}`,
		);
		return { wanted: [...wanted], resolved: [] };
	}
}

/** Which capabilities a plan needs, derived from the plan — never from its filename. */
export function capabilitiesFor(
	plan: EncodingPlan,
	name: string,
): Capability[] {
	const needs = new Set<Capability>();

	// Cloud reach comes from the input/output KINDS, which is the fact that matters.
	// The filename is a hint, not evidence: `generic-s3-akamai-io` is GENERIC_S3 in the
	// plan, and that is what the runner has to satisfy.
	for (const io of [...plan.inputs, ...plan.outputs]) {
		const cap = capabilityOfIoKind(io.kind);
		if (cap) {
			needs.add(cap);
		}
	}

	/**
	 * A source with a DECLARED type needs a file of that type.
	 *
	 * The run stages exactly one mezzanine and the rewrite points every source at it, so a
	 * stream that declares what it reads — `fileType: "WEBVTT"` — can only be satisfied by a
	 * real file of that type. Structural, so a new fixture is covered the day it lands.
	 */
	for (const stream of plan.fileStreams ?? []) {
		if ("fileType" in stream && typeof stream.fileType === "string") {
			needs.add("TYPED_SOURCE_ASSETS");
		}
	}
	/**
	 * Every Dolby path is a format-specific master or sidecar — an ADM BWF `.wav`, a `.atmos`
	 * DAMF set, a J2K `.mxf` DV mezzanine, an XML metadata sidecar. None of them is a thing
	 * the staged H.264 mezzanine can stand in for, and `dolbyStreams` being present is the
	 * evidence; the existing check below only fired on placeholder-looking NAMES, which these
	 * real Netflix open-content paths are not.
	 */
	if ((plan.dolbyStreams ?? []).length > 0) {
		needs.add("DOLBY_ASSETS");
	}
	/**
	 * A VOD plan pinned to a Cloud Connect infrastructure needs one to exist (C18).
	 *
	 * `LIVE_INFRA` already covers this for live channels, and the same prerequisite applies to a
	 * VOD encoding that declares `bitmovin.infrastructure` — but only the live path asked for it.
	 * So `labels-infrastructure-preview` was runnable, and Bitmovin refused it on CREATE:
	 * `Could not retrieve AWS account. Please check your configuration! (code 2042)`. It was the
	 * last FAIL in a full corpus run, and it is not the product's — the account is not connected.
	 *
	 * Structural, from the plan's own field, so a new infrastructure-bearing fixture is gated the
	 * day it lands. No encoder minutes were burned (the 400 comes back on create), but a FAIL that
	 * names the product for an unmet prerequisite is exactly the confusion this gate exists for.
	 */
	if (plan.bitmovin.infrastructure) {
		needs.add("LIVE_INFRA");
	}

	const sources = sourcesOf(plan);
	const ownerAssets = sources.filter(
		(s) => PLACEHOLDER_SOURCE.test(s) && !PUBLIC_SOURCE.test(s),
	);
	if (ownerAssets.length > 0) {
		// A placeholder in a dolby plan is a licensed master the owner must supply;
		// anywhere else it is a generic mezzanine the bootstrap can synthesize.
		needs.add(
			plan.dolbyStreams?.length || /dolby|atmos|vision/i.test(name)
				? "DOLBY_ASSETS"
				: "GENERIC_ASSETS",
		);
	}
	if (sources.some((s) => /^hdr10\//i.test(s))) {
		needs.add("HDR10_ASSET");
	}
	// A DRM row names a KEY PROVIDER, not storage, so the rewrite cannot repoint it and the
	// placeholder id reaches Bitmovin as-is. Gated, so the report says what is missing instead
	// of surfacing `Storage credential no longer exists` from six unrelated scenarios.
	if ((plan.drm ?? []).some((row) => row.credentialId !== undefined)) {
		needs.add("DRM_CREDENTIAL");
	}
	if (JSON.stringify(plan).toLowerCase().includes("nexguard")) {
		needs.add("NEXGUARD");
	}
	if (JSON.stringify(plan).toLowerCase().includes("kantar")) {
		needs.add("KANTAR");
	}
	return [...needs].sort();
}

/** Read every fixture, parsing each so an unparseable plan is INVALID, not absent. */
export function loadScenarios(): ScenarioPlan[] {
	const scenarios: ScenarioPlan[] = [];
	for (const [dir, kind] of [
		[VOD_FIXTURES, "VOD"],
		[LIVE_FIXTURES, "LIVE"],
	] as const) {
		// Loud, not skipped. A swallowed ENOENT here reports `total 0 … 0 invalid` — a
		// reassuring number over an empty population, which is the failure shape this
		// project keeps rediscovering. If the fixture corpus cannot be read, nothing
		// downstream means anything.
		const files = readdirSync(dir).filter((f) => f.endsWith(".plan.json"));
		if (files.length === 0) {
			throw new Error(
				`no *.plan.json under ${dir} — preflight cannot measure an empty corpus`,
			);
		}
		for (const file of files.sort()) {
			const name = file.replace(".plan.json", "");
			const raw = readFileSync(join(dir, file), "utf8");
			if (kind === "LIVE") {
				// Live plans are a different schema; phase C owns them. Listed here so the
				// population is complete from day one rather than growing silently.
				scenarios.push({
					name,
					kind,
					plan: null,
					// Parsed, not pattern-matched on the filename. The first version read
					// /zixi/i and /esam/i off the NAME — the practice `capabilitiesFor`'s own
					// doc comment disavows — which meant "0 invalid" covered only the 66 VOD
					// plans and a malformed live fixture reported valid (review catch).
					...liveNeeds(raw),
					// `liveNeeds` above already parsed this and reported an honest `invalid` for
					// bad JSON. A second, UNGUARDED `JSON.parse` here threw out of the whole
					// function, so one stray comma in one live fixture lost all 73 rows instead
					// of producing a single INVALID row (review catch).
					...parsedLivePlan(raw),
					// The LIVE wizard is a separate form (`app/live/new/build-live-plan.ts`) and
					// the live runner submits the parsed plan; routing live through the VOD
					// wizard would be a lie. Labelled so the report never implies otherwise.
					submittedVia: "wizard-import",
					sources: [],
				});
				continue;
			}
			/**
			 * Through the WIZARD, not straight from the file.
			 *
			 * The fixture JSON is the scenario's definition, but it is not what an operator
			 * submits — the operator fills in the wizard and the wizard calls `buildPlan`. A
			 * corpus that posts the fixture directly proves the compiler, the orchestrator and
			 * Bitmovin, and proves NOTHING about the plan the product actually generates. The
			 * deep-equal between the two was asserted by a unit test and never exercised against
			 * a real encoder, so every "verified" verdict rested on artefacts built from a plan
			 * the product might not have produced.
			 *
			 * So the fixture is imported into wizard state and rebuilt, exactly as the UI does,
			 * and THAT is the plan that gets submitted and verified. When the two disagree the
			 * scenario carries the difference — a wizard that cannot reproduce a scenario is a
			 * finding about the wizard, not something to route around.
			 */
			const viaWizard = planViaWizard(raw);
			/**
			 * The FORM path's plan when it reproduces the scenario, the IMPORT path's otherwise.
			 *
			 * Submitting the form's plan when it diverges would verify a subtly different
			 * scenario — for `gcs-service-account-io` it would drop the GCS input's `region`, so
			 * the artefacts would come from a plan that is not the one under test. The import
			 * path submits the plan verbatim (plus the account id), which is exactly what an
			 * operator pasting it would get.
			 */
			const submittedVia: "wizard-form" | "wizard-import" =
				viaWizard.plan && !viaWizard.divergence
					? "wizard-form"
					: "wizard-import";
			const parsed = encodingPlanSchema.safeParse(
				submittedVia === "wizard-form"
					? viaWizard.plan
					: buildSubmissionPlan({ raw: JSON.parse(raw) }, PLACEHOLDER_ACCOUNT),
			);
			if (!parsed.success) {
				scenarios.push({
					name,
					kind,
					plan: null,
					submittedVia,
					needs: [],
					sources: [],
					invalid: parsed.error.issues
						.slice(0, 3)
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join("; "),
				});
				continue;
			}
			scenarios.push({
				name,
				kind,
				plan: parsed.data,
				submittedVia,
				...(viaWizard.divergence
					? { wizardDivergence: viaWizard.divergence }
					: {}),
				needs: capabilitiesFor(parsed.data, name),
				sources: sourcesOf(parsed.data),
			});
		}
	}
	return scenarios;
}

export type PreflightOptions = {
	prisma: AppPrismaClient;
	/** Label prefix the harness's own credentials carry. */
	labelPrefix?: string;
	log?: (line: string) => void;
};

/**
 * Which cloud a credential provider satisfies.
 *
 * `GENERIC_S3` and the Akamai/OCI providers are the same wire protocol with V4 signing
 * (C10), which is why one capability covers them.
 *
 * : this was an if-chain over `provider: string`, and two of its
 * literals — `AWS_S3_ROLE` and `AZURE` — were values the enum has never
 * contained (`AWS_S3_ROLE_BASED`, `AZURE_BLOB`). Both branches were DEAD:
 * role-based AWS credentials fell through to `S3` only by luck of the first
 * condition, and an Azure credential could NEVER evidence the AZURE
 * capability, so the corpus's Azure SKIPs would have survived a working
 * credential. `string` is what hid it — tsc cannot reject an impossible
 * comparison it cannot see. Now the parameter is the enum and the switch is
 * exhaustive: adding a CredentialProvider member without deciding its
 * capability is a compile error, not a silent fall-through.
 */
export function capabilityOfProvider(
	provider: CredentialProvider,
): Capability | undefined {
	switch (provider) {
		case "AWS_S3":
		case "AWS_S3_ROLE_BASED":
			return "S3";
		case "AZURE_BLOB":
			return "AZURE";
		case "GCS_SERVICE_ACCOUNT":
			return "GCS_SERVICE_ACCOUNT";
		case "GCS_HMAC":
			return "GCS";
		case "SFTP":
			// Nothing can browse SFTP, so the probe fails loudly and the
			// capability stays unevidenced — the declared posture (see the
			// Capability union's SFTP note).
			return "SFTP";
		case "GENERIC_S3":
		case "AKAMAI_OBJECT_STORAGE":
		case "OCI_OBJECT_STORAGE":
			return "AKAMAI";
		case "KANTAR":
			return "KANTAR";
		case "AKAMAI_NETSTORAGE":
			// DELIBERATELY unmapped (not the #111 bug class): evidencing
			// AKAMAI_NETSTORAGE off a decrypt would mark scenarios RUNNABLE
			// whose artefact read-back is impossible until #137(c)'s driver
			// exists — they would fail opaquely mid-run, which is exactly what
			// preflight exists to prevent. The named SKIP is the honest state.
			return undefined;
		case "AKAMAI_MSL":
			// The MSL capability is PROVISIONING CONFIG (streamId + eventName),
			// not browsable storage — so it maps to its capability here and the
			// evidence loop takes the KANTAR-style arm (decrypt + require the
			// config pair), never the browse path. Until 2026-08-23 this
			// returned undefined with a comment saying the capability "comes
			// from provisioning config" — and no arm ever read that config, so
			// AKAMAI_MSL was unsatisfiable and live-akamai-msl sat in the
			// never-run column while a complete MSL credential was registered.
			return "AKAMAI_MSL";
		case "DRM_CENC":
		case "DRM_SPEKE":
		case "LIVE_MEDIA_INGEST":
		case "NEXGUARD":
		case "SRT_PASSPHRASE":
		case "ZIXI":
		case "POIS_ENDPOINT":
		case "NOTIFICATION_WEBHOOK":
			// Not storage: nothing to browse, no capability to evidence.
			return undefined;
		default:
			// A new enum member lands here as a type error, not a fall-through.
			provider satisfies never;
			return undefined;
	}
}

/**
 * How many buckets a credential-reach probe may try when nothing names one.
 *
 * Bounded because an account can hold hundreds across regions, and an unbounded walk
 * would turn preflight into a slow scan of someone else's infrastructure.
 */
const MAX_BUCKET_PROBES = 8;

/** The owner's convention: `verify-<cloud>-<direction> (<bucket>)`. */
export function bucketFromLabel(label: string): string | undefined {
	return /\(([^)]+)\)/.exec(label)?.[1];
}

export async function preflight(
	options: PreflightOptions,
): Promise<PreflightReport> {
	const log = options.log ?? (() => {});
	const prefix = options.labelPrefix ?? "verify-";
	const credentials = createCredentialStore(options.prisma, cipherFromEnv());
	const rows = (await credentials.list()).filter((r) =>
		r.label.startsWith(prefix),
	);

	const evidence = new Map<Capability, string>();
	for (const row of rows) {
		const capability = capabilityOfProvider(row.provider);
		if (!capability) {
			continue;
		}
		if (capability === "KANTAR") {
			// Nothing to browse; the presence of a decryptable credential IS the check.
			try {
				await credentials.revealSecret(row.id);
				evidence.set(capability, `${row.label} decrypts`);
			} catch (err) {
				log(
					`${row.label}: secret does not decrypt (${err instanceof Error ? err.message : String(err)})`,
				);
			}
			continue;
		}
		if (capability === "AKAMAI_MSL") {
			// MSL is provisioning config, not storage: the evidence is a
			// decryptable credential whose config carries the pair the encoder
			// needs — streamId + eventName. Requiring BOTH (not mere decrypt)
			// keeps a half-configured row from marking the scenario runnable
			// and dying at provision.
			const config = (row.config ?? {}) as Record<string, unknown>;
			// review-292 S1: mirror the credential schema's
			// z.coerce.number.int.positive — "" and 0 must NOT be
			// evidence; a numeric string must.
			const streamIdNum = Number(config.streamId);
			const hasPair =
				config.streamId !== undefined &&
				config.streamId !== null &&
				String(config.streamId).trim() !== "" &&
				Number.isInteger(streamIdNum) &&
				streamIdNum > 0 &&
				typeof config.eventName === "string" &&
				config.eventName.length > 0;
			if (!hasPair) {
				log(
					`${row.label}: AKAMAI_MSL config lacks streamId/eventName — not evidence`,
				);
				continue;
			}
			try {
				await credentials.revealSecret(row.id);
				evidence.set(
					capability,
					`${row.label} decrypts and carries streamId + eventName`,
				);
			} catch (err) {
				log(
					`${row.label}: secret does not decrypt (${err instanceof Error ? err.message : String(err)})`,
				);
			}
			continue;
		}
		try {
			const browser = createBrowserForCredential({
				provider: row.provider,
				config: (row.config ?? {}) as Record<string, unknown>,
				secret: JSON.parse(await credentials.revealSecret(row.id)) as Record<
					string,
					string
				>,
			});
			// Candidate buckets, in descending order of how much they prove.
			//
			// The label convention carries the bucket, but the AWS credential predates it,
			// and the first fallback here — "enumerate and take the first" — was a lottery:
			// the account holds 114 buckets across regions, the alphabetically-first one is
			// in another region, and S3 answered "must be addressed using the specified
			// endpoint". So the fallbacks are an explicit env override and then a BOUNDED
			// walk that stops at the first bucket that really lists.
			const candidates: string[] = [];
			const labelled = bucketFromLabel(row.label);
			if (labelled) {
				candidates.push(labelled);
			}
			const override = process.env[`VERIFY_${capability}_BUCKET`];
			if (override) {
				candidates.push(override);
			}
			if (candidates.length === 0) {
				const buckets = await browser.listBuckets();
				candidates.push(...buckets.slice(0, MAX_BUCKET_PROBES));
				log(
					`${row.label}: no bucket in the label and no VERIFY_${capability}_BUCKET; probing up to ${MAX_BUCKET_PROBES} of ${buckets.length} buckets`,
				);
			}

			let reached: { bucket: string; objects: number } | undefined;
			const failures: string[] = [];
			for (const candidate of candidates) {
				try {
					const page = await browser.listObjects({
						bucket: candidate,
						limit: 1,
					});
					reached = { bucket: candidate, objects: page.objects.length };
					break;
				} catch (err) {
					failures.push(
						`${candidate}: ${err instanceof Error ? err.message.slice(0, 70) : String(err)}`,
					);
				}
			}
			if (!reached) {
				log(
					`FAIL ${row.label}: no candidate bucket listed — ${failures.slice(0, 3).join(" | ")}`,
				);
				continue;
			}
			// Reaching the bucket is the evidence — not that it has anything in it.
			const previous = evidence.get(capability);
			const note = `${row.label} lists ${reached.bucket} (${reached.objects} object(s) on page 1)`;
			evidence.set(capability, previous ? `${previous}; ${note}` : note);
			log(`PASS ${note}`);
		} catch (err) {
			log(
				`FAIL ${row.label}: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`,
			);
		}
	}

	/**
	 * The COMPLETE capability population, compiler-pinned (review-292): a
	 * member missing here is a tsc error, not a silently-undiscoverable row.
	 * Twice a capability was declared, mapped and evidenced while this list
	 * lacked its row — the evidence went into a map nothing read (AKAMAI_MSL
	 * tonight; AKAMAI_NETSTORAGE latently). Object.keys preserves insertion
	 * order, so the report's row order is stable.
	 */
	const ALL = Object.keys({
		S3: true,
		AZURE: true,
		GCS: true,
		GCS_SERVICE_ACCOUNT: true,
		AKAMAI: true,
		SFTP: true,
		GENERIC_ASSETS: true,
		TYPED_SOURCE_ASSETS: true,
		DOLBY_ASSETS: true,
		HDR10_ASSET: true,
		KANTAR: true,
		AKAMAI_MSL: true,
		LIVE_MEDIA_INGEST: true,
		AKAMAI_NETSTORAGE: true,
		ZIXI: true,
		POIS: true,
		LIVE_INFRA: true,
		SRT_SOURCE: true,
		DRM_CREDENTIAL: true,
		NEXGUARD: true,
		PINNED_ENCODER_VERSION: true,
	} satisfies Record<Capability, true>) as Capability[];
	/**
	 * Which declared TYPED sources are actually in the input bucket.
	 *
	 * `TYPED_SOURCE_ASSETS` was unconditionally unsatisfied, so four WebVTT scenarios sat in the
	 * "never run" column while `general/sintel/subtitles_en.vtt` — the exact file they declare, one
	 * prefix down — had been there all along. Looking costs one recursive listing.
	 *
	 * Uses the SAME prefix and the same match the runner resolves with, so preflight and the run
	 * cannot disagree about whether a scenario is runnable.
	 */
	const typedAssets = await measureTypedAssets(options, log);
	const capabilities: CapabilityState[] = ALL.map((capability) => {
		const seen = evidence.get(capability);
		if (seen) {
			return { capability, satisfied: true, evidence: seen };
		}
		// The asset and external-endpoint capabilities are not credentials; they are
		// resolved by the asset bootstrap and by the owner respectively. Preflight
		// reports them unsatisfied rather than guessing.
		// GENERIC_ASSETS rides on S3 reach: the bootstrap synthesizes these from the
		// BBB master already in the input bucket, so if S3 is reachable they can exist.
		// Reported as its own line so a reader is never told "blocked by S3" for what is
		// actually a missing file.
		/**
		 * TYPED_SOURCE_ASSETS is satisfied by LOOKING, not by assuming.
		 *
		 * It was unconditionally unsatisfied, which is how four WebVTT scenarios sat in the
		 * "never run" column while `general/sintel/subtitles_en.vtt` — the exact file they declare,
		 * one prefix down — had been in the input bucket the whole time. The corpus declares 34
		 * source paths; two of them resolve, and both belong to these scenarios.
		 *
		 * Measured against the SAME listing the runner resolves with, so preflight and the run
		 * cannot disagree — the disagreement class this project keeps paying for.
		 */
		if (capability === "TYPED_SOURCE_ASSETS") {
			const resolved = typedAssets.resolved;
			const wanted = typedAssets.wanted;
			return wanted.length === 0
				? {
						capability,
						satisfied: true,
						evidence: "no scenario declares a typed source",
					}
				: resolved.length === wanted.length
					? {
							capability,
							satisfied: true,
							evidence: `every declared typed source is in the input bucket (${resolved.join(", ")})`,
						}
					: {
							capability,
							satisfied: false,
							evidence: `${wanted.length - resolved.length} of ${wanted.length} declared typed source(s) are not in the input bucket — missing: ${wanted.filter((w) => !resolved.includes(w)).join(", ")}`,
						};
		}
		if (capability === "GENERIC_ASSETS") {
			const s3 = evidence.get("S3");
			return s3
				? {
						capability,
						satisfied: true,
						evidence: `synthesizable from the BBB master via S3 (${s3.split(";")[0]})`,
					}
				: {
						capability,
						satisfied: false,
						evidence:
							"needs S3 reach so the bootstrap can write the derivations",
					};
		}
		const reason: Record<string, string> = {
			DOLBY_ASSETS:
				"no Dolby masters registered — the owner supplies these (design D3, deferred)",
			TYPED_SOURCE_ASSETS:
				"the plan reads a source with a declared type (e.g. WEBVTT) and the run stages only the H.264 mezzanine — submitting it would bill for a guaranteed input failure",
			HDR10_ASSET: "the hdr10 demo file is not in the asset manifest yet",
			ZIXI: "needs a Zixi broadcaster; the feeder cannot push zixi",
			POIS: "needs a POIS endpoint for ESAM media-point insertion",
			KANTAR: "no Kantar credential registered",
			AKAMAI_NETSTORAGE:
				"deliberately unevidenced until #137(c)'s NetStorage driver exists — a decrypt-only evidence would mark scenarios runnable whose artefact read-back is impossible (this row exists so the report can SAY that; review-292)",
		};
		return {
			capability,
			satisfied: false,
			evidence:
				reason[capability] ??
				`no ${prefix}* credential reached a ${capability} bucket`,
		};
	});

	const satisfied = new Set(
		capabilities.filter((c) => c.satisfied).map((c) => c.capability),
	);
	const scenarios = loadScenarios().map((s) => {
		const blockedBy = s.needs.filter((n) => !satisfied.has(n));
		return {
			...s,
			runnable: s.invalid === undefined && blockedBy.length === 0,
			blockedBy,
		};
	});

	return {
		capabilities,
		scenarios,
		counts: {
			runnable: scenarios.filter((s) => s.runnable).length,
			blocked: scenarios.filter((s) => !s.runnable && !s.invalid).length,
			invalid: scenarios.filter((s) => s.invalid !== undefined).length,
		},
	};
}

/** Human-readable preflight. Every scenario appears — that is the whole point. */
export function formatPreflight(report: PreflightReport): string {
	const lines = ["capabilities:"];
	for (const c of report.capabilities) {
		lines.push(
			`  ${c.satisfied ? "YES" : "no "}  ${c.capability.padEnd(13)} ${c.evidence}`,
		);
	}
	lines.push("", "scenarios:");
	const byBlocker = new Map<string, string[]>();
	for (const s of report.scenarios) {
		const key = s.invalid
			? `INVALID (${s.invalid})`
			: s.runnable
				? "runnable"
				: `blocked by ${s.blockedBy.join("+")}`;
		byBlocker.set(key, [...(byBlocker.get(key) ?? []), s.name]);
	}
	for (const [key, names] of [...byBlocker].sort()) {
		lines.push(`  ${key} — ${names.length}`);
		for (const n of names) {
			lines.push(`      ${n}`);
		}
	}
	lines.push(
		"",
		`runnable ${report.counts.runnable}  blocked ${report.counts.blocked}  invalid ${report.counts.invalid}  total ${report.scenarios.length}`,
	);
	return lines.join("\n");
}
