import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	edgeBaseUrlShapeDefect,
	edgeUrlPolicy,
	isPrivateOrLoopbackHost,
	LIVE_EVIDENCE_VERSION,
	type LiveEvidenceLegInput,
	type LiveEvidenceProbe,
	liveEvidenceCompleteness,
	liveEvidenceProgression,
	liveEvidenceSupportsPass,
	MAX_CREDENTIAL_EDGE_BASE_URL_LENGTH,
	MEDIA_FRESHNESS_TOLERANCE_MS,
	mediaFreshness,
	parseCredentialEdgeBaseUrl,
	parseEdgeBaseUrl,
	redactUrl,
	resolveEdgeReference,
	sealLiveEvidenceLeg,
	summarizeLiveEvidence,
} from "./live-evidence";

/**
 * The Live/MSL evidence tuple (audit 5c3d97ca BLOCKER-4, §14.4 EV-02): the
 * completeness rule, the progression rule, the credential-free URL shape and
 * the reference policy. Every negative the audit lists — empty/master-only,
 * disallowed scheme/origin, root escape, zero segments, two identical
 * snapshots, one child missing — must leave a leg INCOMPLETE.
 */

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");

const BASE = "https://edge.akamaized.net/hls/live/2126636/event/";
const RUN_PREFIX = "verify/RUN1/live-akamai-msl-storage/";
const RUN_ROOT = `${BASE}${RUN_PREFIX}`;

function probe(
	at: string,
	children: { id: string; mediaSequence?: number; served: string[] }[],
): LiveEvidenceProbe {
	return { at, children };
}

/** A COMPLETE edge leg — every negative below removes one element from it. */
function completeLeg(): LiveEvidenceLegInput {
	const master = redactUrl(`${BASE}stream.m3u8`, sha256);
	const child = redactUrl(`${BASE}video_4500000.m3u8`, sha256);
	const segment = (name: string) => redactUrl(`${RUN_ROOT}${name}`, sha256);
	return {
		version: LIVE_EVIDENCE_VERSION,
		scenario: "live-akamai-msl-storage",
		outputLeg: "hls@mirror-1",
		manifestKey: "hls",
		outputKey: "mirror-1",
		kind: "HLS",
		role: "EDGE",
		build: {
			commit: "5c3d97ca",
			image: `worker@sha256:${"c".repeat(64)}`,
			planSha256: "a".repeat(64),
		},
		source: {
			location: "verify-in/bbb-short.mov",
			etag: '"abc"',
			versionId: "v-1",
			size: 42,
			sha256: sha256("source"),
		},
		channel: {
			channelId: "chan-1",
			liveChannelRunId: "run-1",
			providerEncodingId: "enc-1",
			providerStreamIds: { video: "stream-video-1" },
			providerOutputIds: { "mirror-1": "output-msl-1" },
			requiredProviderStreamKeys: ["video"],
			requiredProviderOutputKeys: ["mirror-1"],
		},
		msl: {
			outputKey: "mirror-1",
			credentialId: "00000000-0000-4000-8000-000000000004",
			providerOutputId: "output-msl-1",
			streamId: 2_126_636,
			eventName: "event",
			streamFormat: "HLS",
			mslVersion: "MSL4",
			eventRoot: redactUrl(BASE, sha256),
		},
		output: { prefix: RUN_PREFIX, edge: master },
		topology: {
			expectedChildCount: 1,
			expectedChildIds: ["video_4500000.m3u8"],
		},
		master: {
			key: "stream.m3u8",
			url: master,
			bytes: 120,
			sha256: sha256("m"),
			entries: 1,
		},
		children: [
			{
				id: "video_4500000.m3u8",
				url: child,
				requiresInit: false,
				mediaSequence: 12,
				listed: 5,
				media: [
					{
						key: "seg-1.ts",
						url: segment("seg-1.ts"),
						bytes: 400_000,
						sha256: sha256("1"),
					},
					{
						key: "seg-2.ts",
						url: segment("seg-2.ts"),
						bytes: 410_000,
						sha256: sha256("2"),
					},
				],
				missing: [],
			},
		],
		probes: [
			probe("2026-08-30T10:00:00.000Z", [
				{
					id: "video_4500000.m3u8",
					mediaSequence: 10,
					served: [`${RUN_ROOT}seg-1.ts`],
				},
			]),
			probe("2026-08-30T10:00:12.000Z", [
				{
					id: "video_4500000.m3u8",
					mediaSequence: 12,
					served: [`${RUN_ROOT}seg-2.ts`],
				},
			]),
		],
		progression: { observed: true, detail: "media sequence 10 → 12" },
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
				detail: "this ingest creates no temporary stream key",
			},
		},
	};
}

describe("liveEvidenceCompleteness — one rule for what a live PASS is a pass OF", () => {
	it("a leg carrying every element is COMPLETE", () => {
		expect(liveEvidenceCompleteness(completeLeg())).toEqual({
			complete: true,
			missing: [],
		});
	});

	it("seals source bytes and transcoded segment bytes independently — their SHA-256 values are not expected to match", () => {
		const leg = completeLeg();
		expect(leg.source.sha256).not.toBe(leg.children[0]?.media[0]?.sha256);
		expect(liveEvidenceCompleteness(leg)).toEqual({
			complete: true,
			missing: [],
		});
	});

	it("allows master and child playlists only at the direct MSL event root and binds media/progression URLs to this run", () => {
		const leg = completeLeg();
		expect(leg.master?.url?.path).toBe("/hls/live/2126636/event/stream.m3u8");
		expect(leg.children[0]?.url?.path).toBe(
			"/hls/live/2126636/event/video_4500000.m3u8",
		);
		expect(leg.children[0]?.media[0]?.url?.path).toContain(`/${RUN_PREFIX}`);
		expect(leg.probes[0]?.children[0]?.served[0]).toContain(`/${RUN_PREFIX}`);
		expect(liveEvidenceCompleteness(leg)).toEqual({
			complete: true,
			missing: [],
		});
	});

	it("refuses advancing media from an old run prefix even when current provider ids and output.prefix are present", () => {
		const leg = completeLeg();
		const oldRoot = `${BASE}verify/RUN0/live-akamai-msl-storage/`;
		leg.children = leg.children.map((child) => ({
			...child,
			media: child.media.map((media) => ({
				...media,
				url: redactUrl(`${oldRoot}${media.key}`, sha256),
			})),
		}));
		leg.probes = [
			probe("2026-08-30T10:00:00.000Z", [
				{
					id: "video_4500000.m3u8",
					mediaSequence: 40,
					served: [`${oldRoot}seg-40.ts`],
				},
			]),
			probe("2026-08-30T10:00:12.000Z", [
				{
					id: "video_4500000.m3u8",
					mediaSequence: 42,
					served: [`${oldRoot}seg-42.ts`],
				},
			]),
		];
		const verdict = liveEvidenceCompleteness(leg);
		expect(verdict.complete).toBe(false);
		expect(verdict.missing.join("\n")).toMatch(/current run prefix/i);
	});

	it.each([
		["master under the current-run prefix", "master", `${RUN_ROOT}stream.m3u8`],
		[
			"child under the current-run prefix",
			"child",
			`${RUN_ROOT}video_4500000.m3u8`,
		],
		[
			"child under another event root",
			"child",
			"https://edge.akamaized.net/hls/live/2126636/other-event/video_4500000.m3u8",
		],
		["query-bearing child", "child", `${BASE}video_4500000.m3u8?hdnts=secret`],
	])("refuses a %s", (_description, target, url) => {
		const leg = completeLeg();
		const redacted = redactUrl(url, sha256);
		if (target === "master") {
			leg.output.edge = redacted;
			if (leg.master) leg.master.url = redacted;
		} else if (leg.children[0]) {
			leg.children[0].url = redacted;
		}
		const verdict = liveEvidenceCompleteness(leg);
		expect(verdict.complete).toBe(false);
		expect(verdict.missing.join("\n")).toMatch(/direct MSL event root/i);
	});

	it("refuses query-bearing media evidence", () => {
		const leg = completeLeg();
		const media = leg.children[0]?.media[0];
		if (media) {
			media.url = redactUrl(`${RUN_ROOT}seg-1.ts?token=secret`, sha256);
		}
		const verdict = liveEvidenceCompleteness(leg);
		expect(verdict.complete).toBe(false);
		expect(verdict.missing.join("\n")).toMatch(/current run prefix/i);
	});

	it("refuses query-bearing progression evidence", () => {
		const leg = completeLeg();
		const first = leg.probes[0]?.children[0];
		if (first) first.served = [`${RUN_ROOT}seg-1.ts?token=secret`];
		const verdict = liveEvidenceCompleteness(leg);
		expect(verdict.complete).toBe(false);
		expect(verdict.missing.join("\n")).toMatch(/probes.*current run/i);
	});

	it("refuses old-prefix progression probes even when the final closure URLs belong to this run", () => {
		const leg = completeLeg();
		const oldRoot = `${BASE}verify/RUN0/live-akamai-msl-storage/`;
		leg.probes = [
			probe("2026-08-30T10:00:00.000Z", [
				{
					id: "video_4500000.m3u8",
					mediaSequence: 50,
					served: [`${oldRoot}seg-50.ts`],
				},
			]),
			probe("2026-08-30T10:00:12.000Z", [
				{
					id: "video_4500000.m3u8",
					mediaSequence: 52,
					served: [`${oldRoot}seg-52.ts`],
				},
			]),
		];
		const verdict = liveEvidenceCompleteness(leg);
		expect(verdict.complete).toBe(false);
		expect(verdict.missing.join("\n")).toMatch(/probes.*current run prefix/i);
	});

	it("refuses a master under an old run prefix — the only prefix exemption is a master directly at the MSL event root", () => {
		const leg = completeLeg();
		const oldMaster = redactUrl(
			`${BASE}verify/RUN0/live-akamai-msl-storage/stream.m3u8`,
			sha256,
		);
		leg.output = { ...leg.output, edge: oldMaster };
		leg.master = {
			...(leg.master as NonNullable<typeof leg.master>),
			url: oldMaster,
		};
		const verdict = liveEvidenceCompleteness(leg);
		expect(verdict.complete).toBe(false);
		expect(verdict.missing.join("\n")).toMatch(
			/master.*direct MSL event root/i,
		);
	});

	/**
	 * Each audit negative removes exactly one element; the rule must name it.
	 * Table-driven so a new element cannot be added to the tuple without a row
	 * here saying what its absence reads as.
	 */
	it.each<
		[string, (leg: LiveEvidenceLegInput) => LiveEvidenceLegInput, RegExp]
	>([
		[
			"master-only (no children walked)",
			(leg) => ({ ...leg, children: [] }),
			/children: no child/,
		],
		[
			"a child with ZERO media witnessed",
			(leg) => ({
				...leg,
				children: [
					{
						...(leg.children[0] as LiveEvidenceLegInput["children"][number]),
						media: [],
					},
				],
			}),
			/media: no nonzero media/,
		],
		[
			"an edge child without a URL",
			(leg) => ({
				...leg,
				children: leg.children.map(({ url: _url, ...child }) => child),
			}),
			/children\..*\.url: no exact child URL/i,
		],
		[
			"edge media without a URL",
			(leg) => ({
				...leg,
				children: leg.children.map((child) => ({
					...child,
					media: child.media.map(({ url: _url, ...media }) => media),
				})),
			}),
			/media\..*\.url: no media URL.*current run prefix/i,
		],
		[
			"an fMP4 init object without a URL",
			(leg) => ({
				...leg,
				children: leg.children.map((child) => ({
					...child,
					requiresInit: true,
					init: { key: "init.mp4", bytes: 100, sha256: sha256("init") },
				})),
			}),
			/init\.url: init URL is outside the current run prefix/i,
		],
		[
			"a progression probe with an invalid media URL",
			(leg) => ({
				...leg,
				probes: leg.probes.map((entry) => ({
					...entry,
					children: entry.children.map((child) => ({
						...child,
						served: ["seg-from-nowhere.ts"],
					})),
				})),
			}),
			/probes\..*media URL is outside the current run prefix/i,
		],
		[
			"a child whose media were all zero bytes",
			(leg) => ({
				...leg,
				children: [
					{
						...(leg.children[0] as LiveEvidenceLegInput["children"][number]),
						media: [{ key: "seg-1.ts", bytes: 0, sha256: sha256("") }],
					},
				],
			}),
			/media: no nonzero media/,
		],
		[
			"one referenced object missing on a child",
			(leg) => ({
				...leg,
				children: [
					{
						...(leg.children[0] as LiveEvidenceLegInput["children"][number]),
						missing: ["seg-3.ts (HTTP 404)"],
					},
				],
			}),
			/missing: 1 referenced object/,
		],
		[
			"only one probe",
			(leg) => ({ ...leg, probes: [leg.probes[0] as LiveEvidenceProbe] }),
			/probes: 1 probe/,
		],
		[
			"two identical snapshots (no progression)",
			(leg) => ({
				...leg,
				progression: { observed: false, detail: "identical media served" },
			}),
			/progression: identical/,
		],
		[
			"an edge leg without its edge URL",
			(leg) => ({ ...leg, output: { prefix: leg.output.prefix } }),
			/output\.edge/,
		],
		[
			"an edge leg without its MSL identity binding",
			(leg) => ({ ...leg, msl: undefined }),
			/msl: no credential-safe MSL output identity/,
		],
		[
			"an MSL identity bound to an old provider output resource",
			(leg) => ({
				...leg,
				msl: leg.msl
					? { ...leg.msl, providerOutputId: "output-msl-old" }
					: undefined,
			}),
			/msl\.providerOutputId.*current provider output/i,
		],
		[
			"an MSL identity whose event name does not own the recorded root",
			(leg) => ({
				...leg,
				msl: leg.msl ? { ...leg.msl, eventName: "old-event" } : undefined,
			}),
			/msl\.eventRoot.*old-event/i,
		],
		[
			"an observed master outside the credential-bound event root",
			(leg) => ({
				...leg,
				output: {
					...leg.output,
					edge: redactUrl(
						"https://edge.akamaized.net/hls/live/2126636/other/stream.m3u8",
						sha256,
					),
				},
			}),
			/msl\.eventRoot.*outside the bound event root/i,
		],
		[
			"an edge master whose bytes were not hashed",
			(leg) => ({
				...leg,
				master: { key: "stream.m3u8", bytes: 120 },
			}),
			/master\.sha256/,
		],
		[
			"edge media whose bytes were not hashed",
			(leg) => ({
				...leg,
				children: [
					{
						...(leg.children[0] as LiveEvidenceLegInput["children"][number]),
						media: [{ key: "seg-1.ts", bytes: 400_000 }],
					},
				],
			}),
			/bytes not hashed/,
		],
		[
			"an unknown commit",
			(leg) => ({ ...leg, build: { ...leg.build, commit: "unknown" } }),
			/build\.commit/,
		],
		[
			"an image identity that was not captured",
			(leg) => ({ ...leg, build: { ...leg.build, image: undefined } }),
			/build\.image/,
		],
		[
			"a mutable image tag rather than an immutable digest",
			(leg) => ({ ...leg, build: { ...leg.build, image: "worker:latest" } }),
			/build\.image/,
		],
		[
			"a plan digest that is not a SHA-256",
			(leg) => ({ ...leg, build: { ...leg.build, planSha256: "abc" } }),
			/planSha256/,
		],
		[
			"a source whose stable identity was never read",
			(leg) => ({
				...leg,
				source: {
					location: leg.source.location,
					size: leg.source.size,
					sha256: leg.source.sha256,
				},
			}),
			/source\.(etag|versionId|generation)/,
		],
		[
			"a source whose fed bytes were not hashed",
			(leg) => ({ ...leg, source: { ...leg.source, sha256: undefined } }),
			/source\.sha256/,
		],
		[
			"a source whose size was not recorded",
			(leg) => ({ ...leg, source: { ...leg.source, size: undefined } }),
			/source\.size/,
		],
		[
			"no airing (LiveChannelRun) identified",
			(leg) => ({
				...leg,
				channel: { ...leg.channel, liveChannelRunId: undefined },
			}),
			/liveChannelRunId/,
		],
		[
			"no provider encoding",
			(leg) => ({
				...leg,
				channel: { ...leg.channel, providerEncodingId: undefined },
			}),
			/providerEncodingId/,
		],
		[
			"a required provider stream without an exact id",
			(leg) => ({
				...leg,
				channel: { ...leg.channel, providerStreamIds: {} },
			}),
			/providerStreamIds\.video/,
		],
		[
			"a required provider output without an exact id",
			(leg) => ({
				...leg,
				channel: { ...leg.channel, providerOutputIds: {} },
			}),
			/providerOutputIds\.mirror-1/,
		],
		[
			"one required child omitted from the master",
			(leg) => ({
				...leg,
				topology: {
					expectedChildCount: 2,
					expectedChildIds: ["video_4500000.m3u8", "audio_128000.m3u8"],
				},
			}),
			/topology/,
		],
		[
			"an unconfirmed provider terminal",
			(leg) => ({
				...leg,
				providerTerminal: { confirmed: false, detail: "STOPPED but error set" },
			}),
			/providerTerminal/,
		],
		[
			"an unclean cleanup seal",
			(leg) => ({ ...leg, cleanup: { ...leg.cleanup, clean: false } }),
			/cleanup/,
		],
		[
			"a queue not positively drained despite an aggregate clean bit",
			(leg) => ({ ...leg, cleanup: { ...leg.cleanup, queueDrained: false } }),
			/cleanup\.queueDrained/,
		],
		[
			"a temporary token not positively released",
			(leg) => ({
				...leg,
				cleanup: {
					...leg.cleanup,
					tokenCleanup: {
						required: true,
						confirmed: false,
						detail: "stream key still readable",
					},
				},
			}),
			/cleanup\.tokenCleanup/,
		],
		[
			"a master that was never read",
			(leg) => {
				const { master: _dropped, ...rest } = leg;
				return rest;
			},
			/master: the master/,
		],
	])("%s leaves the leg INCOMPLETE and names it", (_name, mutate, expected) => {
		const verdict = liveEvidenceCompleteness(mutate(completeLeg()));
		expect(verdict.complete).toBe(false);
		expect(verdict.missing.join("\n")).toMatch(expected);
	});

	it("an ORIGIN leg needs no hashes — its media are witnessed by listing, not fetched", () => {
		const leg = completeLeg();
		const origin: LiveEvidenceLegInput = {
			...leg,
			role: "ORIGIN",
			outputLeg: "hls@origin",
			outputKey: "origin",
			output: { prefix: leg.output.prefix },
			master: { key: "stream.m3u8", bytes: 120 },
			children: [
				{
					id: "v1080",
					requiresInit: false,
					listed: 5,
					media: [{ key: "seg-1.m4s", bytes: 500_000 }],
					missing: [],
				},
			],
		};
		origin.topology = { expectedChildCount: 1 };
		expect(liveEvidenceCompleteness(origin)).toEqual({
			complete: true,
			missing: [],
		});
	});

	it("sealLiveEvidenceLeg attaches the verdict, and the summary reflects every leg", () => {
		const good = sealLiveEvidenceLeg(completeLeg());
		const bad = sealLiveEvidenceLeg({
			...completeLeg(),
			outputLeg: "dash@mirror-1",
			kind: "DASH",
			children: [],
		});
		expect(good.complete).toBe(true);
		expect(bad.complete).toBe(false);
		const summary = summarizeLiveEvidence([good, bad]);
		expect(summary.version).toBe(LIVE_EVIDENCE_VERSION);
		expect(summary.complete).toBe(false);
		expect(summary.legs.map((l) => [l.outputLeg, l.complete])).toEqual([
			["hls@mirror-1", true],
			["dash@mirror-1", false],
		]);
		expect(summary.legs[0]?.mediaWitnessed).toBe(2);
		expect(summary.legs[0]?.mediaBytes).toBe(810_000);
		// The gate names the first incomplete leg and its first missing element.
		const gate = liveEvidenceSupportsPass(summary);
		expect(gate.ok).toBe(false);
		expect(gate.ok ? "" : gate.reason).toContain("dash@mirror-1");
		expect(gate.ok ? "" : gate.reason).toContain("children: no child");
		expect(liveEvidenceSupportsPass(summarizeLiveEvidence([good])).ok).toBe(
			true,
		);
	});

	it("no tuple at all, and a tuple with no legs, both refuse a PASS", () => {
		expect(liveEvidenceSupportsPass(undefined).ok).toBe(false);
		expect(liveEvidenceSupportsPass(summarizeLiveEvidence([])).ok).toBe(false);
		expect(summarizeLiveEvidence([]).complete).toBe(false);
	});

	it("refuses a forged summary whose parent completeness disagrees with green legs", () => {
		const summary = summarizeLiveEvidence([sealLiveEvidenceLeg(completeLeg())]);
		expect(
			liveEvidenceSupportsPass({ ...summary, complete: false }),
		).toMatchObject({ ok: false });
	});
});

describe("mediaFreshness — served objects must be THIS airing's (WP-C6b)", () => {
	/**
	 * Measured 2026-09-02 (measurement doc Part 9): a re-aired channel's root
	 * playlists advanced while every object they named carried the first
	 * airing's Last-Modified (08:18Z) at a 13:25Z start. Progression is not
	 * evidence that a viewer's bytes belong to this run; the object's own
	 * timestamp against `runningSince` is.
	 */
	const SINCE = "2026-09-02T13:25:15.048Z";
	const fresh = { key: "seg-904.ts", lastModified: "2026-09-02T13:55:23.000Z" };
	const stale = { key: "seg-904.ts", lastModified: "2026-09-02T08:18:11.000Z" };

	it("is FRESH when every object was modified at or after runningSince", () => {
		const v = mediaFreshness([fresh, { ...fresh, key: "seg-905.ts" }], SINCE);
		expect(v.verdict).toBe("FRESH");
		expect(v.detail).toContain("2 media object(s)");
	});

	it("is STALE when ANY object predates the airing, naming the oldest and both timestamps", () => {
		const v = mediaFreshness([fresh, stale], SINCE);
		expect(v.verdict).toBe("STALE");
		expect(v.detail).toContain("1 of 2");
		expect(v.detail).toContain("seg-904.ts");
		expect(v.detail).toContain("2026-09-02T08:18:11.000Z");
		expect(v.detail).toContain(SINCE);
		expect(v.detail).toContain("previous airing");
	});

	it("tolerates exactly 60 s before runningSince — a segment cut as the run came up — and not more", () => {
		const since = Date.parse(SINCE);
		const edge = new Date(since - MEDIA_FRESHNESS_TOLERANCE_MS).toISOString();
		const beyond = new Date(
			since - MEDIA_FRESHNESS_TOLERANCE_MS - 1,
		).toISOString();
		expect(
			mediaFreshness([{ key: "a", lastModified: edge }], SINCE).verdict,
		).toBe("FRESH");
		expect(
			mediaFreshness([{ key: "a", lastModified: beyond }], SINCE).verdict,
		).toBe("STALE");
		// A numeric runningSince (ms) is accepted too.
		expect(
			mediaFreshness([{ key: "a", lastModified: edge }], since).verdict,
		).toBe("FRESH");
	});

	it.each([
		["no runningSince", [fresh], undefined, "runningSince is unknown"],
		[
			"unparsable runningSince",
			[fresh],
			"yesterday",
			"runningSince is unknown",
		],
		["no media", [], SINCE, "no media object was witnessed"],
		["a missing header", [fresh, { key: "seg-905.ts" }], SINCE, "seg-905.ts"],
		[
			"an unparsable header",
			[{ key: "seg-906.ts", lastModified: "Wed, 32 Foo 2026" }],
			SINCE,
			"seg-906.ts",
		],
	] as const)("is UNVERIFIED — never FRESH — with %s", (_label, media, since, expected) => {
		const v = mediaFreshness([...media], since);
		expect(v.verdict).toBe("UNVERIFIED");
		expect(v.detail).toContain(expected);
	});

	it("a stale object beside a missing header is STALE — the witnessed defect outranks the unverifiable sibling (rev411)", () => {
		// Two independent reasons not to pass; the one that was SEEN wins, so a
		// header-less object can never soften a FAIL into a WARN.
		const v = mediaFreshness([stale, { key: "seg-905.ts" }], SINCE);
		expect(v.verdict).toBe("STALE");
		expect(v.detail).toContain("seg-904.ts");
		// And a fresh object beside a missing header is still UNVERIFIED.
		expect(mediaFreshness([fresh, { key: "seg-905.ts" }], SINCE).verdict).toBe(
			"UNVERIFIED",
		);
	});
});

describe("liveEvidenceProgression — media must ADVANCE between two probes", () => {
	const a = probe("t0", [{ id: "c", mediaSequence: 10, served: ["s1"] }]);

	it("observes a media-sequence advance", () => {
		const b = probe("t1", [{ id: "c", mediaSequence: 12, served: ["s1"] }]);
		expect(liveEvidenceProgression(a, b)).toMatchObject({ observed: true });
	});

	it("observes a newly SERVED media identity even when no sequence is carried (DASH)", () => {
		const a2 = probe("t0", [{ id: "1080p", served: ["seg-9.m4s"] }]);
		const b2 = probe("t1", [{ id: "1080p", served: ["seg-11.m4s"] }]);
		expect(liveEvidenceProgression(a2, b2)).toMatchObject({ observed: true });
	});

	it("two identical snapshots are NOT progression", () => {
		const b = probe("t1", [{ id: "c", mediaSequence: 10, served: ["s1"] }]);
		const out = liveEvidenceProgression(a, b);
		expect(out.observed).toBe(false);
		expect(out.detail).toContain("identical");
	});

	it("a sequence that went BACKWARDS is not progression either", () => {
		const b = probe("t1", [{ id: "c", mediaSequence: 8, served: ["s1"] }]);
		expect(liveEvidenceProgression(a, b).observed).toBe(false);
	});

	it("one probe, or a failed probe, cannot show progression", () => {
		expect(liveEvidenceProgression(a, undefined).observed).toBe(false);
		expect(
			liveEvidenceProgression(a, { ...a, at: "t1", error: "HTTP 503" })
				.observed,
		).toBe(false);
	});

	it("requires EVERY child to exist in both probes and advance", () => {
		const first = probe("t0", [
			{ id: "video", mediaSequence: 10, served: ["v10.ts"] },
			{ id: "audio", mediaSequence: 10, served: ["a10.ts"] },
		]);
		const stalled = probe("t1", [
			{ id: "video", mediaSequence: 12, served: ["v12.ts"] },
			{ id: "audio", mediaSequence: 10, served: ["a10.ts"] },
		]);
		const missing = probe("t1", [
			{ id: "video", mediaSequence: 12, served: ["v12.ts"] },
		]);
		expect(liveEvidenceProgression(first, stalled).observed).toBe(false);
		expect(liveEvidenceProgression(first, stalled).detail).toContain("audio");
		expect(liveEvidenceProgression(first, missing).observed).toBe(false);
		expect(liveEvidenceProgression(first, missing).detail).toContain("missing");
	});
});

describe("redactUrl — a persisted URL is credential-free", () => {
	it("drops userinfo and query VALUES, keeps key names, and hashes the full URL", () => {
		const full =
			"https://user:pa%24s@edge.akamaized.net/hls/live/1/ev/stream.m3u8?hdnts=exp%3D1~hmac%3Dabc&x=1";
		const out = redactUrl(full, sha256);
		expect(out.origin).toBe("https://edge.akamaized.net");
		expect(out.path).toBe("/hls/live/1/ev/stream.m3u8");
		expect(out.queryKeys).toEqual(["hdnts", "x"]);
		expect(JSON.stringify(out)).not.toContain("hmac");
		expect(JSON.stringify(out)).not.toContain("pa%24s");
		expect(JSON.stringify(out)).not.toContain("user");
		// The digest is over the URL WITHOUT userinfo but WITH its query — the
		// exact request, provable, never stored.
		expect(out.urlSha256).toBe(
			sha256(
				"https://edge.akamaized.net/hls/live/1/ev/stream.m3u8?hdnts=exp%3D1~hmac%3Dabc&x=1",
			),
		);
	});
});

describe("resolveEdgeReference — `new URL(reference, parent)` under a policy", () => {
	const policy = edgeUrlPolicy(BASE);
	const master = new URL(`${BASE}stream.m3u8`);

	it.each([
		["a relative child", "video_4500000.m3u8", `${BASE}video_4500000.m3u8`],
		[
			"a nested relative child",
			"video/1080p/index.m3u8",
			`${BASE}video/1080p/index.m3u8`,
		],
		[
			"a same-origin absolute child",
			`${BASE}video_4500000.m3u8`,
			`${BASE}video_4500000.m3u8`,
		],
		[
			"a root-absolute path under the root",
			"/hls/live/2126636/event/a.m3u8",
			`${BASE}a.m3u8`,
		],
	])("accepts %s", (_name, reference, expected) => {
		const out = resolveEdgeReference(reference, master, policy);
		expect(out.ok, JSON.stringify(out)).toBe(true);
		expect(out.ok ? out.url.href : "").toBe(expected);
	});

	it.each([
		[
			"a plain-http child",
			"http://edge.akamaized.net/hls/live/2126636/event/a.m3u8",
			"scheme",
		],
		["a data: reference", "data:text/plain,hi", "scheme"],
		["a javascript: reference", "javascript:alert(1)", "scheme"],
		["another origin", "https://evil.example/a.m3u8", "origin"],
		["a protocol-relative other host", "//evil.example/a.m3u8", "origin"],
		["a ../ root escape", "../../other/a.m3u8", "root-escape"],
		["a root-absolute escape", "/other/a.m3u8", "root-escape"],
		["a query-bearing child", "video_4500000.m3u8?hdnts=abc", "query"],
		["a fragment-bearing child", "video_4500000.m3u8#part", "query"],
		[
			"userinfo in the reference",
			"https://u:p@edge.akamaized.net/hls/live/2126636/event/a.m3u8",
			"userinfo",
		],
	])("refuses %s", (_name, reference, reason) => {
		const out = resolveEdgeReference(reference, master, policy);
		expect(out.ok).toBe(false);
		expect(out.ok ? "" : out.reason).toBe(reason);
	});

	it("accepts another origin only when it is an explicitly allowed root", () => {
		const allowing = edgeUrlPolicy(BASE, ["https://cdn.example/root/"]);
		expect(
			resolveEdgeReference("https://cdn.example/root/a.m3u8", master, allowing)
				.ok,
		).toBe(true);
		// …and still not OUTSIDE that root.
		const out = resolveEdgeReference(
			"https://cdn.example/elsewhere/a.m3u8",
			master,
			allowing,
		);
		expect(out.ok).toBe(false);
	});

	it("treats a base without a trailing slash as a directory, not a file", () => {
		const p = edgeUrlPolicy("https://edge.akamaized.net/hls/live/1/ev");
		expect(p.base.pathname).toBe("/hls/live/1/ev/");
		const out = resolveEdgeReference("stream.m3u8", p.base, p);
		expect(out.ok ? out.url.href : "").toBe(
			"https://edge.akamaized.net/hls/live/1/ev/stream.m3u8",
		);
	});
});

describe("parseEdgeBaseUrl — the operator-supplied edge base", () => {
	it("accepts an HTTPS Akamai event root and normalises it to a directory", () => {
		expect(
			parseEdgeBaseUrl(
				"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev",
			),
		).toEqual({
			ok: true,
			url: "https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev/",
		});
	});

	it.each([
		["plain http", "http://x.akamaized.net/hls/live/1/ev/", /not https/],
		["userinfo", "https://u:p@x.akamaized.net/hls/live/1/ev/", /userinfo/],
		[
			"a query",
			"https://x.akamaized.net/hls/live/1/ev/?hdnts=abc",
			/query or fragment/,
		],
		[
			"a fragment",
			"https://x.akamaized.net/hls/live/1/ev/#x",
			/query or fragment/,
		],
		[
			"a host off the allowlist",
			"https://evil.example/hls/live/1/ev/",
			/not an allowed delivery host/,
		],
		["not a URL", "nope", /not a URL/],
	])("refuses %s", (_name, raw, reason) => {
		const out = parseEdgeBaseUrl(raw);
		expect(out.ok).toBe(false);
		expect(out.ok ? "" : out.reason).toMatch(reason);
	});

	it("honours an explicit host allowlist — exact hosts and dot-suffixes", () => {
		expect(
			parseEdgeBaseUrl("https://edge.lab.example/ev/", {
				allowedHosts: ["edge.lab.example"],
			}).ok,
		).toBe(true);
		expect(
			parseEdgeBaseUrl("https://a.lab.example/ev/", {
				allowedHosts: [".lab.example"],
			}).ok,
		).toBe(true);
		expect(
			parseEdgeBaseUrl("https://x.akamaized.net/ev/", {
				allowedHosts: ["edge.lab.example"],
			}).ok,
		).toBe(false);
	});
});

describe("edgeBaseUrlShapeDefect — the rules the verifier flag and the credential share", () => {
	it.each([
		["https://x.akamaized.net/hls/live/1/ev", null],
		["http://x.akamaized.net/hls/live/1/ev", "scheme"],
		["ftp://x.akamaized.net/hls/live/1/ev", "scheme"],
		["https://u:p@x.akamaized.net/hls/live/1/ev", "userinfo"],
		["https://u@x.akamaized.net/hls/live/1/ev", "userinfo"],
		["https://x.akamaized.net/hls/live/1/ev?hdnts=abc", "query"],
		["https://x.akamaized.net/hls/live/1/ev#frag", "query"],
	] as const)("%s → %s", (raw, defect) => {
		expect(edgeBaseUrlShapeDefect(new URL(raw))).toBe(defect);
	});
});

describe("isPrivateOrLoopbackHost — what no viewer can reach", () => {
	it.each([
		"localhost",
		"LOCALHOST",
		"app.localhost",
		"127.0.0.1",
		"127.255.255.254",
		"10.0.0.1",
		"10.255.255.255",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"0.0.0.0",
		"100.64.0.1",
		"100.127.255.255",
		"224.0.0.1",
		"239.255.255.255",
		"240.0.0.1",
		"255.255.255.255",
		"[::1]",
		"[::]",
		"[fc00::1]",
		"[fd12:3456::1]",
		"[fe80::1]",
		"[::ffff:10.0.0.1]",
		// The SERIALISED forms `URL.hostname` actually hands over (rev401 R2):
		// `[::ffff:127.0.0.1]` reaches the door as `[::ffff:7f00:1]`.
		"[::ffff:7f00:1]",
		"[::ffff:a00:1]",
		"[::ffff:c0a8:1]",
		"[::ffff:ac10:1]",
		"[::ffff:a9fe:a9fe]",
		"[::ffff:0:0]",
		"[::FFFF:7F00:1]",
	])("refuses %s", (host) => {
		expect(isPrivateOrLoopbackHost(host)).toBe(true);
	});

	it.each([
		"x.akamaized.net",
		"live.example.com",
		"localhost.example.com",
		"8.8.8.8",
		"172.15.0.1",
		"172.32.0.1",
		"11.0.0.1",
		"192.169.0.1",
		"169.253.0.1",
		"100.63.255.255",
		"100.128.0.1",
		"223.255.255.255",
		"[2001:db8::1]",
		"[::ffff:8.8.8.8]",
		"[::ffff:808:808]",
		"[::ffff:ac20:1]",
		// The deprecated IPv4-translatable prefix is not IPv4-mapped; a browser
		// does not treat it as IPv4 either, so it stays a plain IPv6 literal.
		"[::ffff:0:7f00:1]",
	])("admits %s", (host) => {
		expect(isPrivateOrLoopbackHost(host)).toBe(false);
	});

	it("decodes the hex-mapped form to the same verdict as the dotted form, for every IPv4 rule", () => {
		const hex = (quad: string) => {
			const [a, b, c, d] = quad.split(".").map(Number) as [
				number,
				number,
				number,
				number,
			];
			return `[::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}]`;
		};
		for (const quad of [
			"127.0.0.1",
			"10.0.0.1",
			"100.64.0.1",
			"169.254.169.254",
			"172.16.0.1",
			"192.168.1.1",
			"224.0.0.1",
			"0.0.0.0",
			"8.8.8.8",
			"172.32.0.1",
			"100.63.255.255",
		]) {
			// What WHATWG serialises for this quad, checked rather than assumed.
			expect(new URL(`https://[::ffff:${quad}]/x`).hostname).toBe(hex(quad));
			expect(isPrivateOrLoopbackHost(hex(quad)), quad).toBe(
				isPrivateOrLoopbackHost(quad),
			);
		}
	});
});

describe("parseCredentialEdgeBaseUrl — the AKAMAI_MSL credential's edgeBaseUrl", () => {
	const ROOT = "https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev";

	it("accepts the measured MSL4 Production root byte-for-byte, trimmed", () => {
		expect(parseCredentialEdgeBaseUrl(ROOT)).toEqual({ ok: true, url: ROOT });
		expect(parseCredentialEdgeBaseUrl(`  ${ROOT}\n`)).toEqual({
			ok: true,
			url: ROOT,
		});
	});

	it("accepts a customer CNAME and an MSL5-shaped root — no host allowlist, no path rule", () => {
		expect(
			parseCredentialEdgeBaseUrl("https://live.example.com/hls/live/1/ev").ok,
		).toBe(true);
		expect(
			parseCredentialEdgeBaseUrl("https://msl5.example.net/a1b2c3/stream").ok,
		).toBe(true);
		// A bare origin is a root too.
		expect(parseCredentialEdgeBaseUrl("https://live.example.com").ok).toBe(
			true,
		);
		// A PUBLIC IPv4-mapped literal stays admitted — the mapped branch
		// decodes and applies the IPv4 rules, it does not refuse the prefix.
		expect(
			parseCredentialEdgeBaseUrl("https://[::ffff:8.8.8.8]/hls/live/1/ev"),
		).toEqual({ ok: true, url: "https://[::ffff:8.8.8.8]/hls/live/1/ev" });
	});

	it.each([
		["plain http", `http://${ROOT.slice("https://".length)}`, "scheme"],
		[
			"userinfo",
			"https://u:p@bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev",
			"userinfo",
		],
		["a signed query", `${ROOT}?hdnts=abc`, "query"],
		["a fragment", `${ROOT}#x`, "query"],
		["a trailing slash", `${ROOT}/`, "trailing-slash"],
		["two trailing slashes", `${ROOT}//`, "trailing-slash"],
		[
			"a trailing slash on a bare origin",
			"https://live.example.com/",
			"trailing-slash",
		],
		["localhost", "https://localhost/hls/live/1/ev", "private-host"],
		["a loopback literal", "https://127.0.0.1/hls/live/1/ev", "private-host"],
		["an RFC1918 literal", "https://10.1.2.3/hls/live/1/ev", "private-host"],
		["a link-local literal", "https://169.254.169.254/latest", "private-host"],
		["a CGNAT literal", "https://100.64.0.1/hls/live/1/ev", "private-host"],
		["a multicast literal", "https://224.0.0.1/hls/live/1/ev", "private-host"],
		["an IPv6 loopback", "https://[::1]/hls/live/1/ev", "private-host"],
		// At the DOOR, where the URL parser has already serialised the mapped
		// literal to hex groups (rev401 R2 — these were admitted before).
		[
			"an IPv4-mapped loopback, dotted as typed",
			"https://[::ffff:127.0.0.1]/hls/live/1/ev",
			"private-host",
		],
		[
			"an IPv4-mapped private literal, hex as serialised",
			"https://[::ffff:a00:1]/hls/live/1/ev",
			"private-host",
		],
		[
			"an IPv4-mapped link-local literal",
			"https://[::ffff:169.254.169.254]/latest",
			"private-host",
		],
		["not a URL", "nope", "invalid"],
		["a relative path", "/hls/live/1/ev", "invalid"],
		["an empty string", "", "invalid"],
		["whitespace only", "   ", "invalid"],
		[
			"513 characters",
			`https://x.akamaized.net/${"a".repeat(513 - "https://x.akamaized.net/".length)}`,
			"length",
		],
	])("refuses %s", (_name, raw, defect) => {
		expect(parseCredentialEdgeBaseUrl(raw)).toEqual({ ok: false, defect });
	});

	it("measures the length cap AFTER trimming and at exactly 512", () => {
		const exact = `https://x.akamaized.net/${"a".repeat(512 - "https://x.akamaized.net/".length)}`;
		expect(exact).toHaveLength(MAX_CREDENTIAL_EDGE_BASE_URL_LENGTH);
		expect(parseCredentialEdgeBaseUrl(exact)).toEqual({ ok: true, url: exact });
		expect(parseCredentialEdgeBaseUrl(`   ${exact}   `)).toEqual({
			ok: true,
			url: exact,
		});
	});

	it("reports the FIRST failing rule in rail order, so a message names one remedy", () => {
		// http AND a trailing slash: the scheme is the rail that fires.
		expect(parseCredentialEdgeBaseUrl("http://x.akamaized.net/ev/")).toEqual({
			ok: false,
			defect: "scheme",
		});
		// A query AND a private host: the query rail fires first.
		expect(parseCredentialEdgeBaseUrl("https://127.0.0.1/ev?x=1")).toEqual({
			ok: false,
			defect: "query",
		});
	});
});
