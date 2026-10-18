import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
	redactUrl,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { LiveEdgeClosure } from "./edge-resolver";
import type { LiveSample } from "./engine-live";
import type { LiveCleanupSeal } from "./live-cleanup-seal";
import {
	assembleLiveEvidence,
	type LiveEvidenceInputs,
} from "./live-evidence-assembly";

/**
 * The evidence tuple assembled from one live run
: legs come from the PLAN (manifests × delivery targets), the
 * origin legs are witnessed through the listing and the read master, the edge
 * legs through the in-run closures, and every leg is sealed by core's rule.
 */

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const FIXTURES = join(
	import.meta.dirname,
	"../../../../packages/core/src/live/__fixtures__",
);
const plan = liveChannelPlanSchema.parse(
	JSON.parse(
		readFileSync(join(FIXTURES, "live-akamai-msl-storage.plan.json"), "utf8"),
	),
);
const expected = compileExpectedLiveArtefacts(plan);

const EDGE = "https://edge.akamaized.net/cmaf/live/1/ev/";
const OUTPUT_PREFIX = "verify/RUN1/live-akamai-msl-storage/";
const EDGE_RUN = `${EDGE}${OUTPUT_PREFIX}`;
const MSL_CREDENTIAL = "00000000-0000-4000-8000-000000000004";

function seal(overrides: Partial<LiveCleanupSeal> = {}): LiveCleanupSeal {
	const ok = { established: true, detail: "ok" };
	return {
		channelId: "chan-1",
		liveChannelRunId: "run-1",
		providerEncodingId: "enc-1",
		providerStreamIds: Object.fromEntries(
			expected.muxings.map((muxing) => [
				muxing.streamKey,
				`stream-${muxing.streamKey}`,
			]),
		),
		providerOutputIds: { origin: "output-origin", "mirror-1": "output-msl" },
		productStopProjection: ok,
		providerTerminal: ok,
		localTerminal: ok,
		feederProcessGone: ok,
		hostProcessGone: ok,
		queueDrained: ok,
		tokenRequired: false,
		tokenCleanup: ok,
		localClean: true,
		clean: true,
		...overrides,
	};
}

function terminal(
	overrides: Partial<NonNullable<LiveEvidenceInputs["intentTerminal"]>> = {},
): NonNullable<LiveEvidenceInputs["intentTerminal"]> {
	const readback = {
		channelId: "chan-1",
		cleanup: seal(),
		providerStatuses: [{ encodingId: "enc-1", status: "CANCELED" }],
		providerTerminalObservedAt: "2026-08-30T10:01:00.000Z",
		providerIdentityComplete: true,
		providerIdentityConflict: false,
		providerProofUncertain: false,
	};
	return {
		cleanupState: "CLEANED",
		providerId: "enc-1",
		providerIds: ["enc-1"],
		...overrides,
		readback: {
			...readback,
			...(typeof overrides.readback === "object" && overrides.readback !== null
				? overrides.readback
				: {}),
		},
	};
}

/** One closed HLS edge closure with one child serving `seq`-numbered media. */
function closure(
	at: number,
	seq: number,
	manifestKey = "hls",
): LiveEdgeClosure {
	const masterName = manifestKey === "hls" ? "stream.m3u8" : "stream.mpd";
	const master = redactUrl(`${EDGE}${masterName}`, sha);
	const child = redactUrl(
		manifestKey === "hls"
			? `${EDGE}video_4500000.m3u8`
			: `${EDGE_RUN}output/live-akamai-msl-storage/video_4500000.m4s`,
		sha,
	);
	const seg = (n: number) =>
		redactUrl(`${EDGE_RUN}output/live-akamai-msl-storage/seg-${n}.m4s`, sha);
	const ids =
		manifestKey === "hls"
			? (expected.manifests.find((manifest) => manifest.manifestKey === "hls")
					?.mediaPlaylists ?? [])
			: expected.muxings.map((muxing) => muxing.muxingKey);
	return {
		manifestKey,
		outputKey: "mirror-1",
		masterUrl: `${EDGE}${masterName}`,
		closed: true,
		at,
		master: {
			url: master,
			bytes: 200,
			sha256: sha("master"),
			entries: ids.length,
		},
		childCount: ids.length,
		segmentCount: ids.length * 2,
		children: ids.map((id) => ({
			id,
			requiresInit: true,
			url: child,
			bytes: 300,
			sha256: sha("child"),
			mediaSequence: seq,
			listed: 2,
			served: [
				{
					key: "init.mp4",
					url: seg(0),
					bytes: 700,
					sha256: sha("init"),
					init: true,
				},
				{
					key: `seg-${seq}.m4s`,
					url: seg(seq),
					bytes: 500_000,
					sha256: sha(`s${seq}`),
					init: false,
					reference: `seg-${seq}.m4s`,
					lastModified: new Date(at).toISOString(),
				},
				{
					key: `seg-${seq + 1}.m4s`,
					url: seg(seq + 1),
					bytes: 500_000,
					sha256: sha(`s${seq + 1}`),
					init: false,
					reference: `seg-${seq + 1}.m4s`,
					lastModified: new Date(at).toISOString(),
				},
			],
			missing: [],
		})),
		msl: {
			outputKey: "mirror-1",
			credentialId: MSL_CREDENTIAL,
			providerOutputId: "output-msl",
			streamId: 1,
			eventName: "ev",
			streamFormat: "CMAF",
			mslVersion: "MSL4",
			eventRoot: redactUrl(EDGE, sha),
		},
	};
}

function sample(
	at: number,
	seq: number,
	opts: { edge?: boolean } = {},
): LiveSample {
	const objects = expected.muxings.flatMap((m) => [
		{ key: `${m.dir.prefix}init.mp4`, size: 700 },
		...Array.from({ length: seq }, (_, i) => ({
			key: `${m.dir.prefix}seg-${i + 1}.m4s`,
			size: 500_000,
		})),
	]);
	return {
		at,
		status: "RUNNING",
		mediaSequence: seq,
		playlistSegments: seq,
		objects,
		...(opts.edge === false
			? {}
			: { edge: [closure(at, seq, "hls"), closure(at, seq, "dash")] }),
	};
}

function inputs(
	overrides: Partial<LiveEvidenceInputs> = {},
): LiveEvidenceInputs {
	return {
		scenario: "live-akamai-msl-storage",
		expected,
		plan,
		build: {
			commit: "b8c63e35",
			image: `worker@sha256:${"c".repeat(64)}`,
			planSha256: "b".repeat(64),
		},
		source: {
			location: "verify-in/bbb-short.mov",
			etag: '"abc"',
			versionId: "v-1",
			size: 42,
			sha256: sha("source"),
		},
		channel: {
			channelId: "chan-1",
			liveChannelRunId: "run-1",
			providerEncodingId: "enc-1",
			providerStreamIds: Object.fromEntries(
				expected.muxings.map((muxing) => [
					muxing.streamKey,
					`stream-${muxing.streamKey}`,
				]),
			),
			providerOutputIds: {
				origin: "output-origin",
				"mirror-1": "output-msl",
			},
		},
		mslOutputs: [
			{
				outputKey: "mirror-1",
				credentialId: MSL_CREDENTIAL,
				streamId: 1,
				eventName: "ev",
				streamFormat: "CMAF",
				mslVersion: "MSL4",
				eventRoot: EDGE,
			},
		],
		outputPrefix: OUTPUT_PREFIX,
		samples: [sample(1_000, 10), sample(13_000, 12)],
		manifestFiles: [
			{
				manifestKey: "hls",
				kind: "HLS",
				key: "output/live-akamai-msl-storage/stream.m3u8",
				bytes: 220,
				sha256: sha("m"),
				entries: 5,
			},
			{
				manifestKey: "dash",
				kind: "DASH",
				key: "output/live-akamai-msl-storage/stream.mpd",
				bytes: 900,
				sha256: sha("d"),
				entries: 4,
			},
		],
		cleanup: seal(),
		intentTerminal: terminal(),
		...overrides,
	};
}

describe("assembleLiveEvidence", () => {
	it.each([
		false,
		true,
	])("requires one expanded CMAF init and excludes it from media evidence (%s)", (ambiguous) => {
		const cmafPlan = liveChannelPlanSchema.parse({
			...plan,
			muxings: plan.muxings.map((m) => ({
				...m,
				kind: "CMAF",
				initSegmentNameTemplate: "init-{rand_chars:8}.mp4",
			})),
			liveManifests: plan.liveManifests
				.filter((m) => m.kind === "DASH")
				.map((m) => ({
					...m,
					videoMuxingKind: "CMAF",
					audioMuxingKind: "CMAF",
				})),
		});
		const cmafExpected = compileExpectedLiveArtefacts(cmafPlan);
		const samples = [sample(1_000, 10), sample(13_000, 12)].map((s) => ({
			...s,
			edge: undefined,
			objects: s.objects?.map((o) => ({
				...o,
				key: o.key.replace("init.mp4", "init-Ab12Cd34.mp4"),
			})),
		}));
		if (ambiguous) {
			for (const s of samples)
				s.objects?.push({
					key: `${cmafExpected.muxings[0]?.dir.prefix}init-Ef56Gh78.mp4`,
					size: 700,
				});
		}
		const origin = assembleLiveEvidence(
			inputs({ plan: cmafPlan, expected: cmafExpected, samples }),
		).find((leg) => leg.outputLeg === "dash@origin");
		expect(origin).toBeDefined();
		expect(origin?.children.every((child) => child.requiresInit)).toBe(true);
		expect(
			origin?.children.every((child) =>
				child.media.every((o) => !o.key.includes("init-")),
			),
		).toBe(true);
		expect(origin?.children[0]?.init?.key).toBe(
			ambiguous
				? undefined
				: `${cmafExpected.muxings[0]?.dir.prefix}init-Ab12Cd34.mp4`,
		);
		expect(origin?.complete).toBe(!ambiguous);
	});
	it("accepts Run32's growing origin with media sequence 0 without inventing an extra media child", () => {
		// Minimal, credential-free projection of Run32's retained probes:
		// 11:12:31.443 -> 11:13:11.980, each muxing 20 -> 27 nonzero
		// objects, playlist sequence 0 -> 0 while its DVR head is retained.
		// Reuse the synthetic test ladder, not paid credentials or byte hashes.
		const samples = [
			sample(Date.parse("2026-09-08T11:12:31.443Z"), 20),
			sample(Date.parse("2026-09-08T11:13:11.980Z"), 27),
		].map((s) => ({ ...s, mediaSequence: 0 }));
		const origin = assembleLiveEvidence(inputs({ samples })).find(
			(leg) => leg.outputLeg === "hls@origin",
		);
		expect(origin?.complete).toBe(true);
		expect(
			origin?.probes.every(
				(probe) =>
					probe.children.map((child) => child.id).join() ===
					origin.topology.expectedChildIds?.join(),
			),
		).toBe(true);
		expect(
			origin?.children.every((child) =>
				child.media.every((m) => m.sha256 === undefined),
			),
		).toBe(true);
	});

	it("does not let a moving playlist counter hide one stalled origin rendition", () => {
		const first = sample(1_000, 20);
		const second = sample(42_000, 27);
		const prefix = expected.muxings[0]?.dir.prefix as string;
		second.objects = [
			...(second.objects ?? []).filter((o) => !o.key.startsWith(prefix)),
			...(first.objects ?? []).filter((o) => o.key.startsWith(prefix)),
		];
		const origin = assembleLiveEvidence(
			inputs({ samples: [first, second] }),
		).find((leg) => leg.outputLeg === "hls@origin");
		expect(origin?.complete).toBe(false);
		expect(origin?.missing.join("\n")).toContain("identical media served");
	});

	it("does not count foreign-prefix objects as origin progression", () => {
		const first = sample(1_000, 20);
		const second = {
			...sample(42_000, 20),
			objects: [
				...(first.objects ?? []),
				{ key: "foreign-run/seg-21.ts", size: 500_000 },
			],
		};
		const origin = assembleLiveEvidence(
			inputs({ samples: [first, second] }),
		).find((leg) => leg.outputLeg === "hls@origin");
		expect(origin?.complete).toBe(false);
		expect(origin?.missing.join("\n")).toContain("identical media served");
	});

	it("emits one ORIGIN leg per manifest and one EDGE leg per (manifest, MSL mirror), all COMPLETE on a healthy run", () => {
		const legs = assembleLiveEvidence(inputs());
		expect(legs.map((l) => [l.outputLeg, l.role, l.complete])).toEqual([
			["hls@origin", "ORIGIN", true],
			["hls@mirror-1", "EDGE", true],
			["dash@origin", "ORIGIN", true],
			["dash@mirror-1", "EDGE", true],
		]);
		const origin = legs[0];
		// Origin media are witnessed by LISTING: bytes from sizes, no hash.
		expect(origin?.children).toHaveLength(expected.muxings.length);
		expect(
			origin?.children[0]?.media.every(
				(m) => m.bytes > 0 && m.sha256 === undefined,
			),
		).toBe(true);
		expect(origin?.master?.sha256).toBe(sha("m"));
		expect(origin?.probes).toHaveLength(2);
		expect(origin?.progression.observed).toBe(true);
		// Edge media carry the fetched hashes and credential-free URLs.
		const edge = legs[1];
		expect(edge?.output.edge?.origin).toBe("https://edge.akamaized.net");
		expect(edge?.master?.sha256).toBe(sha("master"));
		expect(edge?.children[0]?.media.map((m) => m.sha256)).toEqual([
			sha("s12"),
			sha("s13"),
		]);
		expect(edge?.progression.detail).toContain("media sequence 10 → 12");
		// WP-C6b: the object's own age and the manifest's raw reference ride
		// into the durable tuple beside the hash — the last probe's media.
		expect(edge?.children[0]?.media.map((m) => m.lastModified)).toEqual([
			new Date(13_000).toISOString(),
			new Date(13_000).toISOString(),
		]);
		expect(edge?.children[0]?.media.map((m) => m.reference)).toEqual([
			"seg-12.m4s",
			"seg-13.m4s",
		]);
		// Cleanup and provider terminal ride from the seal.
		expect(edge?.cleanup).toEqual({
			clean: true,
			queueDrained: true,
			processGone: true,
			storageRetained: true,
			tokenCleanup: {
				required: false,
				confirmed: true,
				detail: "ok",
			},
		});
		expect(edge?.providerTerminal.confirmed).toBe(true);
	});

	it("an edge leg nobody probed is INCOMPLETE — a target not looked at is a missing element, not a missing row", () => {
		const legs = assembleLiveEvidence(
			inputs({
				samples: [
					sample(1_000, 10, { edge: false }),
					sample(13_000, 12, { edge: false }),
				],
			}),
		);
		const edge = legs.find((l) => l.outputLeg === "hls@mirror-1");
		expect(edge?.complete).toBe(false);
		expect(edge?.missing.join("\n")).toMatch(/output\.edge/);
		expect(edge?.missing.join("\n")).toMatch(/master: the master/);
		expect(edge?.missing.join("\n")).toMatch(/probes: 0 probe/);
		// The origin legs are unaffected.
		expect(legs.find((l) => l.outputLeg === "hls@origin")?.complete).toBe(true);
	});

	it("does not attribute an edge closure carrying a different credential identity", () => {
		const samples = [sample(1_000, 10), sample(13_000, 12)].map((entry) => ({
			...entry,
			edge: entry.edge?.map((edge) => ({
				...edge,
				msl: edge.msl
					? { ...edge.msl, credentialId: "credential-from-another-event" }
					: undefined,
			})),
		}));
		const edge = assembleLiveEvidence(inputs({ samples })).find(
			(leg) => leg.outputLeg === "hls@mirror-1",
		);
		expect(edge?.complete).toBe(false);
		expect(edge?.missing.join("\n")).toMatch(/output\.edge|probes: 0 probe/);
	});

	it("two identical samples make every leg INCOMPLETE (no progression)", () => {
		const legs = assembleLiveEvidence(
			inputs({ samples: [sample(1_000, 10), sample(13_000, 10)] }),
		);
		expect(legs.every((l) => !l.complete)).toBe(true);
		expect(legs[0]?.missing.join("\n")).toMatch(/progression: .*identical/);
	});

	it("a single sample cannot complete a leg", () => {
		const legs = assembleLiveEvidence(inputs({ samples: [sample(1_000, 10)] }));
		expect(legs[0]?.missing.join("\n")).toMatch(/probes: 1 probe/);
	});

	it("an unclean or unconfirmed teardown, an unknown commit, an unread source or a missing airing each fail the leg by name", () => {
		const unclean = assembleLiveEvidence(
			inputs({ cleanup: seal({ clean: false }) }),
		);
		expect(unclean[0]?.missing.join("\n")).toMatch(/cleanup/);
		const unconfirmed = assembleLiveEvidence(
			inputs({
				intentTerminal: terminal({ cleanupState: "UNRESOLVED" }),
			}),
		);
		expect(unconfirmed[0]?.missing.join("\n")).toMatch(
			/providerTerminal: EV-01 provider-set cleanup is UNRESOLVED/,
		);
		const unknownCommit = assembleLiveEvidence(
			inputs({
				build: {
					commit: "unknown",
					image: `worker@sha256:${"c".repeat(64)}`,
					planSha256: "b".repeat(64),
				},
			}),
		);
		expect(unknownCommit[0]?.missing.join("\n")).toMatch(/build\.commit/);
		const unread = assembleLiveEvidence(
			inputs({ source: { location: "verify-in/bbb-short.mov" } }),
		);
		expect(unread[0]?.missing.join("\n")).toMatch(/source\.(etag|sha256|size)/);
		const unfed = assembleLiveEvidence(inputs({ source: undefined }));
		expect(unfed[0]?.missing.join("\n")).toMatch(/source\.location/);
		const noAiring = assembleLiveEvidence(
			inputs({
				channel: {
					...inputs().channel,
					liveChannelRunId: undefined,
				},
			}),
		);
		expect(noAiring[0]?.missing.join("\n")).toMatch(/liveChannelRunId/);
		const noSeal = assembleLiveEvidence(inputs({ cleanup: undefined }));
		expect(noSeal[0]?.missing.join("\n")).toMatch(/cleanup/);
	});

	it("never promotes local STOPPED/error-null into provider proof without EV-01's exact-set dossier", () => {
		const [leg] = assembleLiveEvidence(inputs({ intentTerminal: undefined }));
		expect(leg?.providerTerminal).toEqual({
			confirmed: false,
			detail: "no EV-01 provider terminal dossier was supplied",
		});
		expect(leg?.cleanup.clean).toBe(false);
		expect(leg?.complete).toBe(false);
	});

	it.each([
		{
			name: "a duplicate provider id",
			dossier: terminal({
				providerIds: ["enc-1", "enc-hidden"],
				readback: {
					channelId: "chan-1",
					providerStatuses: [
						{ encodingId: "enc-1", status: "CANCELED" },
						{ encodingId: "enc-hidden", status: "CANCELED" },
					],
					providerTerminalObservedAt: "2026-08-30T10:01:00.000Z",
					providerIdentityComplete: false,
					providerIdentityConflict: true,
					providerProofUncertain: false,
				},
			}),
		},
		{
			name: "the wrong channel",
			dossier: terminal({
				readback: {
					channelId: "chan-other",
					providerStatuses: [{ encodingId: "enc-1", status: "CANCELED" }],
					providerTerminalObservedAt: "2026-08-30T10:01:00.000Z",
					providerIdentityComplete: true,
					providerIdentityConflict: false,
					providerProofUncertain: false,
				},
			}),
		},
		{
			name: "a non-terminal provider status",
			dossier: terminal({
				readback: {
					channelId: "chan-1",
					providerStatuses: [{ encodingId: "enc-1", status: "RUNNING" }],
					providerTerminalObservedAt: "2026-08-30T10:01:00.000Z",
					providerIdentityComplete: true,
					providerIdentityConflict: false,
					providerProofUncertain: false,
				},
			}),
		},
		{
			name: "a provider output map that differs from EV-01 readback",
			dossier: terminal({
				readback: {
					cleanup: seal({
						providerOutputIds: {
							origin: "output-origin",
							"mirror-1": "output-other-airing",
						},
					}),
				},
			}),
		},
	])("fails closed on $name", ({ dossier }) => {
		const [leg] = assembleLiveEvidence(inputs({ intentTerminal: dossier }));
		expect(leg?.providerTerminal.confirmed).toBe(false);
		expect(leg?.complete).toBe(false);
	});

	it("an origin master that could not be read, and a prefix that listed no media, are named", () => {
		const legs = assembleLiveEvidence(
			inputs({
				manifestFiles: [
					{ manifestKey: "hls", kind: "HLS", key: "x", error: "NoSuchKey" },
				],
				samples: [
					{ ...sample(1_000, 10), objects: [] },
					{ ...sample(13_000, 12), objects: [] },
				],
			}),
		);
		const hls = legs.find((l) => l.outputLeg === "hls@origin");
		expect(hls?.complete).toBe(false);
		expect(hls?.missing.join("\n")).toMatch(/master: the master/);
		expect(hls?.missing.join("\n")).toMatch(
			/children\.v1080\.media: no nonzero media/,
		);
	});

	it("a plan with no MSL mirror emits ORIGIN legs only", () => {
		const plainPlan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(join(FIXTURES, "live-rtmp-simple.plan.json"), "utf8"),
			),
		);
		const plain = compileExpectedLiveArtefacts(plainPlan);
		const legs = assembleLiveEvidence(
			inputs({ expected: plain, plan: plainPlan }),
		);
		expect(legs.every((l) => l.role === "ORIGIN")).toBe(true);
		expect(legs.length).toBe(plain.manifests.length);
	});

	it.each([
		["live-akamai-msl-ts", ["HLS"]],
		["live-akamai-msl", ["HLS", "DASH"]],
	] as const)("a direct MSL4 %s plan emits EDGE legs only — never an impossible storage ORIGIN", (name, kinds) => {
		const directPlan = liveChannelPlanSchema.parse(
			JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
		);
		const directExpected = compileExpectedLiveArtefacts(directPlan);
		const providerStreamIds = Object.fromEntries(
			directExpected.muxings.map((muxing) => [
				muxing.streamKey,
				`stream-${muxing.streamKey}`,
			]),
		);
		const legs = assembleLiveEvidence(
			inputs({
				expected: directExpected,
				plan: directPlan,
				channel: {
					channelId: "chan-direct",
					liveChannelRunId: "run-direct",
					providerEncodingId: "enc-direct",
					providerStreamIds,
					providerOutputIds: { origin: "output-msl-direct" },
				},
				cleanup: seal({
					channelId: "chan-direct",
					liveChannelRunId: "run-direct",
					providerEncodingId: "enc-direct",
					providerStreamIds,
					providerOutputIds: { origin: "output-msl-direct" },
				}),
			}),
		);
		expect(legs.map((leg) => leg.role)).toEqual(
			Array.from({ length: kinds.length }, () => "EDGE"),
		);
		expect(legs.map((leg) => leg.kind)).toEqual(kinds);
		expect(legs.some((leg) => leg.role === "ORIGIN")).toBe(false);
	});

	it("persists nothing that looks like a credential — no userinfo, no query value, no secret", () => {
		const serialized = JSON.stringify(assembleLiveEvidence(inputs()));
		expect(serialized).not.toMatch(/https?:\/\/[^/\s"]*@/);
		expect(serialized).not.toContain("hdnts=");
		expect(serialized).not.toMatch(/(secret|password|token)=/i);
	});
});
