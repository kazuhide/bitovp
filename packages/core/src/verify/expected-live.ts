/**
 * `LiveChannelPlan → ExpectedLiveArtefacts` — the live half of the expectation compiler.
 *
 * Pure, UI-free, and deliberately a SEPARATE compiler from the VOD one rather than a
 * branch inside it. A live channel is not a VOD encoding with a different input: nothing
 * is complete while it runs, so the interesting facts are about MOVEMENT — does the media
 * sequence advance, does the DVR window hold its shape, does the heartbeat keep arriving
 * — and about what is true only AFTER a stop. A compiler that tried to serve both would
 * have to make every field optional, and the VOD one earned its shape over 66 fixtures.
 *
 * What is knowable from a live plan alone, and therefore what this emits:
 *
 *   the ingest kind      which coordinates the channel must hand back, and whether a
 *                        feeder can push to it at all
 *   muxing prefixes      where segments accumulate, with the same `PathPattern` treatment
 *                        the VOD compiler uses
 *   manifest files       and the DVR window each one declares
 *   the C8 budget        `timeshift / segmentLength × renditions` against the 54,000
 *                        manifest-element ceiling — computed by the SAME `dvr.ts` helper
 *                        the wizard's calculator uses, so a verifier and a UI can never
 *                        disagree about whether a channel is over budget
 *
 * What is deliberately NOT here: anything the encoder decides at runtime. A live channel
 * has no per-title mode, but it does have an encoder that starts when it starts and a
 * feed that may be late — so segment COUNTS are never expectations, only the ratios and
 * the movement are. That is the same rule the VOD compiler learned the hard way with
 * per-title .
 */

import {
	liveHlsEntryUri,
	liveHlsEntryUris,
	selectLiveManifestMuxings,
} from "../live/compiler";
import {
	LIVE_MANIFEST_ELEMENT_BUDGET,
	manifestElementEstimate,
} from "../live/dvr";
import type { LiveChannelPlan } from "../live/schema";
import { type PathPattern, pathPattern, withTrailingSlash } from "./expected";

/** A live ingest, and whether our own feeder can drive it. */
export type ExpectedLiveIngest = {
	kind: string;
	/**
	 * True when `apps/worker/src/feeder` can push this protocol.
	 *
	 * The feeder pushes RTMP and SRT-caller. Zixi needs a broadcaster appliance we do not
	 * have, and an HLS pull ingest needs a running origin — so those channels can be
	 * provisioned and verified for their coordinates, but never fed. A verifier that
	 * pretended otherwise would hang for the whole start timeout and report a timeout as
	 * an encoding defect.
	 */
	feedable: boolean;
	/** Coordinates the channel must hand back before a feed can be pointed at it. */
	requiresCoordinates: ("streamKey" | "encoderIp")[];
	/** SRT listener port the plan declares, so the feeder does not have to guess one. */
	srtPort?: number;
	/**
	 * RTMP only: the application name and stream key a feed must push to.
	 *
	 * `rtmp://<ip>/live` is the simple-RTMP convention and it is WRONG for a REDUNDANT_RTMP input,
	 * whose points declare their own — `liveA/primaryFeed`, `liveB/backupFeed`. `live-redundant-rtmp`
	 * provisioned, reached RUNNING, accepted a feeder session and wrote ZERO objects, because
	 * nothing was listening at `/live`. The plan says exactly where to push; the harness was not
	 * reading it.
	 *
	 * Absent for a simple RTMP input, where `/live` and the channel-level key are right.
	 */
	rtmpApplication?: string;
	rtmpStreamKey?: string;
	/**
	 * Redundant RTMP ingest points the plan declares, by application name.
	 *
	 * `live-redundant-rtmp` emitted a check set byte-identical to `live-rtmp-simple`, so it
	 * verified nothing about redundancy at all — the fixture existed and proved nothing
	 * (review catch). The plan names its ingest points, so how many there should be IS
	 * knowable, and a channel that came back with fewer is a redundancy that silently is
	 * not one.
	 */
	ingestPoints?: string[];
	/**
	 * : static ingest points' streamKeyConfiguration types
	 * (GENERATE/ASSIGN). Without this the static fixture emitted a check set
	 * byte-identical to live-rtmp-simple — the same disease ingestPoints
	 * cured for the redundant fixture (comment above).
	 */
	staticIngestPoints?: string[];
};

/** One live muxing's expected output location and cadence. */
export type ExpectedLiveMuxing = {
	muxingKind?: "CMAF";
	initSegmentNameTemplate?: string;
	muxingKey: string;
	streamKey: string;
	container: "FMP4_SEGMENTED" | "TS_SEGMENTED";
	outputKey: string;
	dir: PathPattern;
	segmentNaming: string;
	segmentLengthSec: number;
	initSegment?: string;
};

/** One live manifest, its DVR window, and what that window costs. */
export type ExpectedLiveManifest = {
	manifestKey: string;
	kind: "HLS" | "DASH";
	outputKey: string;
	dir: PathPattern;
	/** The master playlist (HLS) or the MPD (DASH). */
	files: string[];
	/**
	 * HLS MEDIA playlist uris — the files that actually carry `EXT-X-MEDIA-SEQUENCE`,
	 * `EXTINF` durations and, once rolled to VOD, `EXT-X-ENDLIST`.
	 *
	 * The first version emitted only the master and the runner read that, which made five
	 * checks unreachable: a master has no sequence number, no segment durations and never
	 * an ENDLIST — so `live:media-sequence` and `live:dvr:*` could only SKIP, and
	 * `live:to-vod:endlist` would FAIL on a perfectly good recording. The VOD engine
	 * already guards this exact confusion (`isMaster`), and §9b already records
	 * `manifest:hls:endlist` as unreachable for the same reason; the live side reproduced
	 * it without the guard.
	 *
	 * Same derivation the live compiler uses for its StreamInfo/AudioMedia uris, so the
	 * names cannot drift from what the encoder is told to write.
	 */
	mediaPlaylists: string[];
	/**
	 * DASH only : the distinct VIDEO codecs this manifest lists,
	 * in plan order. One AdaptationSet per codec is the contract (C34); the
	 * verifier checks the MPD's set structure against this, which a
	 * representation count could never see (paid case F).
	 */
	videoCodecs?: string[];
	/** Declared DVR window in seconds; absent means no timeshift was requested. */
	timeshiftSec?: number;
	/**
	 * C8: manifest elements this window implies, against the 54,000 budget.
	 *
	 * Present only when a timeshift is declared, because with no window there is no
	 * budget question. `level` is the wizard's own verdict, so the report and the form
	 * agree by construction.
	 */
	elementBudget?: {
		segmentsPerRendition: number;
		totalElements: number;
		budget: number;
		utilization: number;
		level: "ok" | "warning" | "over";
	};
};

/**
 * One delivery-mirror target — an output at least one destination writes to
 * in addition to its primary (audit 602ec286 BLOCKER-3, ; MSL4 + storage
 * simultaneous case). The primary (origin) manifests are read through
 * `manifests`; the mirror is a SEPARATE delivery target the verifier must judge
 * on its own — an `AKAMAI_MSL` mirror is Akamai's ingest, so it is read back on
 * the delivery EDGE, not on any storage driver.
 */
export type ExpectedLiveMirror = {
	/** The mirror output's key (one `deliveryMirrors` entry). */
	outputKey: string;
	/** The mirror output's kind; only `AKAMAI_MSL` legs are edge-observed today. */
	kind: string;
};

/**
 * An MSL output that must be observed on the delivery edge.
 *
 * `PRIMARY` means the manifest itself targets AKAMAI_MSL (there is no readable
 * storage origin for that leg). `MIRROR` means a readable primary is also
 * written to an AKAMAI_MSL delivery mirror. Kept plan-derived so an absent
 * observation can never make the required edge leg disappear.
 */
export type ExpectedLiveMslEdgeOutput = {
	outputKey: string;
	role: "PRIMARY" | "MIRROR";
};

export type ExpectedLiveArtefacts = {
	planName: string;
	ingest: ExpectedLiveIngest;
	muxings: ExpectedLiveMuxing[];
	/** Separate post-stop obligations; never satisfied by live segment checks. */
	archives?: {
		muxingKey: string;
		outputKey: string;
		dir: PathPattern;
		filename: string;
		mirrorOutputKeys: string[];
	}[];
	manifests: ExpectedLiveManifest[];
	/**
	 * How many renditions the channel ENCODES.
	 *
	 * It is no longer the C8 multiplier (#192). The budget counts the legs a
	 * manifest enumerates, and a rendition muxed into another container adds a
	 * stream without adding a playlist — so this number and the estimate stopped
	 * being the same fact the moment a container could hold two.
	 */
	renditionCount: number;
	/** True when the plan asks for SCTE-35 / ESAM, which needs a reachable POIS. */
	needsPois: boolean;
	/**
	 * Delivery-mirror legs . Present ONLY
	 * when at least one declared mirror is not solely a primary/self target — non-mirror goldens stay
	 * byte-identical. An origin-only PASS must not pass the whole run while a
	 * mirror leg is unobserved; the engine and runner judge each mirror leg
	 * individually against this list.
	 */
	mirrors?: ExpectedLiveMirror[];
	/** MSL targets that require edge evidence, including direct-primary MSL. */
	mslEdgeOutputs?: ExpectedLiveMslEdgeOutput[];
	/** Notes the engine surfaces as SKIPs, never silently dropped. */
	notes: string[];
};

/**
 * Which live ingests our feeder can actually push.
 *
 * `SRT` covers both modes in the schema, but only CALLER is feedable: in LISTENER mode
 * Bitmovin dials out to us, which needs an inbound port we do not control from a worker
 * container. The listener scenario is still worth running — it verifies the coordinates
 * and the heartbeat path — it just cannot carry media.
 */
function ingestOf(plan: LiveChannelPlan): ExpectedLiveIngest {
	const input = plan.liveInput;
	const kind = input.kind;
	/**
	 * SRT mode describes what **BITMOVIN** does, and I had it exactly inverted.
	 *
	 * LISTENER = Bitmovin waits for an incoming connection that an external source PUSHES
	 * to it, on one of `SRT_LISTENER_PORTS`. CALLER = Bitmovin dials OUT to a remote
	 * host:port to pull. Our feeder pushes AS an SRT caller — `feeder/command.ts` says so
	 * in as many words, "SRT caller → Bitmovin listener (the shared contract gotcha)" — so the plan
	 * whose input our feeder can drive is the **LISTENER** one.
	 *
	 * The first version read `mode === "CALLER"`, which conflated "our feeder pushes as a
	 * caller" (true) with "the plan's SRT input must be mode CALLER" (false). The result
	 * was precisely backwards: the runner attempted the caller plan, whose input is not
	 * listening, and skipped the listener plan, which is the one that can carry media. The
	 * goldens pinned the wrong values, so they corroborated the bug instead of catching it
	 * — a review caught it against four in-repo sources and the Bitmovin docs.
	 */
	const srtPushable =
		kind === "SRT" && (input as { mode?: string }).mode === "LISTENER";
	const feedable = kind === "RTMP" || kind === "REDUNDANT_RTMP" || srtPushable;
	/**
	 * What the channel must hand back before a feed can be pointed at it.
	 *
	 * RTMP needs the stream key and the encoder address. An SRT LISTENER needs the address
	 * (the port comes from the plan). An HLS PULL ingest needs nothing — Bitmovin fetches
	 * from a URL the plan already carries — so demanding an encoder address there would
	 * FAIL a correct channel. Latent today (no HLS-ingest fixture) and fixed anyway,
	 * because the previous `else` gave `encoderIp` to everything non-RTMP.
	 */
	const requiresCoordinates: ("streamKey" | "encoderIp")[] =
		kind === "RTMP" || kind === "REDUNDANT_RTMP"
			? ["streamKey", "encoderIp"]
			: kind === "HLS"
				? []
				: ["encoderIp"];
	/**
	 * The SRT port the channel listens on, from the PLAN.
	 *
	 * The runner hardcoded 2088 — the first of `SRT_LISTENER_PORTS` — and ignored what the
	 * plan declared, so a channel listening on 2089 could never be reached. Carried here
	 * because the plan is the only place that knows it, and a verifier that guesses a port
	 * is a verifier that reports a connection failure as a media defect.
	 */
	const srtPort =
		kind === "SRT" ? (input as { port?: number }).port : undefined;
	/**
	 * Either list, whichever the plan used — the schema forbids mixing them.
	 *
	 * The FULL point is kept now, not just its `applicationName`. Dropping `streamKey` is how the
	 * harness ended up pushing to `rtmp://<ip>/live` with the channel-level key for a
	 * REDUNDANT_RTMP input whose points declare `liveA/primaryFeed` and `liveB/backupFeed` —
	 * nothing was listening there, and the channel wrote zero objects while reporting RUNNING.
	 */
	const rawPoints = [
		...((
			input as {
				ingestPoints?: { applicationName?: string; streamKey?: string }[];
			}
		).ingestPoints ?? []),
		...((
			input as {
				staticIngestPoints?: { applicationName?: string; streamKey?: string }[];
			}
		).staticIngestPoints ?? []),
	];
	const points = rawPoints
		.map((p) => p.applicationName)
		.filter((x): x is string => typeof x === "string");
	// The FIRST point is where a single feed goes; redundancy is about the encoder accepting a
	// second one, not about the harness pushing twice.
	const primaryPoint = rawPoints[0];
	return {
		kind,
		feedable,
		requiresCoordinates,
		...(srtPort !== undefined ? { srtPort } : {}),
		...(typeof primaryPoint?.applicationName === "string" &&
		primaryPoint.applicationName.trim() !== ""
			? { rtmpApplication: primaryPoint.applicationName }
			: {}),
		...(typeof primaryPoint?.streamKey === "string" &&
		primaryPoint.streamKey.trim() !== ""
			? { rtmpStreamKey: primaryPoint.streamKey }
			: {}),
		...(points.length > 0 ? { ingestPoints: points } : {}),
		...(() => {
			const staticTypes = (
				(
					input as {
						staticIngestPoints?: {
							streamKeyConfiguration?: { type?: string };
						}[];
					}
				).staticIngestPoints ?? []
			).map((p) => p.streamKeyConfiguration?.type ?? "GENERATE");
			return staticTypes.length > 0 ? { staticIngestPoints: staticTypes } : {};
		})(),
	};
}

/**
 * A live destination path, with the trailing slash the convention omits.
 *
 * `live/validate.ts` normalises exactly this (`raw.endsWith("/") ? raw : raw + "/"`),
 * which is the convention's own proof that consumers must add it. VOD fixtures carry the
 * slash already, so the shared `pathPattern` returns paths verbatim and is right there —
 * normalising inside it would move 66 VOD goldens for no reason. Doing it here instead
 * keeps both conventions intact.
 *
 * Without this, `prefix + file` produced `output/live-rtmp-simplestream.m3u8` for every
 * manifest in all 7 fixtures, and every read was wrapped in a `.catch`, so five checks
 * SKIPped on every real run and said nothing about why (review catch).
 */
/** Compile a live plan into the facts a verifier can check. */
export function compileExpectedLiveArtefacts(
	plan: LiveChannelPlan,
): ExpectedLiveArtefacts {
	const notes: string[] = [];
	const renditionCount = plan.renditions.length;

	const archiveMuxings = plan.muxings.filter((muxing) => muxing.kind === "MP4");
	for (const archive of archiveMuxings)
		notes.push(
			`MP4 archive ${archive.key} requires separate post-stop file and A/V verification; live segment checks do not verify it`,
		);
	const muxings: ExpectedLiveMuxing[] = plan.muxings
		.filter((muxing) => muxing.kind !== "MP4")
		.map((muxing) => {
			// A live muxing without a destination cannot be located, so it is a note rather
			// than a guess — the engine turns it into a named SKIP.
			const dest = muxing.destination;
			if (dest === undefined) {
				notes.push(
					`live muxing ${muxing.key} declares no destination, so nothing knows where its segments should appear`,
				);
			}
			return {
				muxingKey: muxing.key,
				streamKey: muxing.streamKey,
				container: muxing.kind === "TS" ? "TS_SEGMENTED" : "FMP4_SEGMENTED",
				...(muxing.kind === "CMAF" ? { muxingKind: "CMAF" as const } : {}),
				outputKey: dest?.outputKey ?? "",
				dir: pathPattern(withTrailingSlash(dest?.path ?? "")),
				segmentNaming:
					muxing.kind === "CMAF"
						? (muxing.segmentNamingTemplate ?? muxing.segmentNaming)
						: muxing.segmentNaming,
				segmentLengthSec: muxing.segmentLength,
				...(muxing.kind === "CMAF" && muxing.initSegmentNameTemplate
					? { initSegmentNameTemplate: muxing.initSegmentNameTemplate }
					: "initSegmentName" in muxing && muxing.initSegmentName
						? { initSegment: muxing.initSegmentName }
						: {}),
			};
		});

	const manifests: ExpectedLiveManifest[] = plan.liveManifests.map(
		(manifest) => {
			const timeshiftSec = manifest.timeshift;
			// C2: live `destination.path` carries NO trailing slash — `live/validate.ts`
			// normalizes exactly this case, which is the convention's own proof that
			// consumers must add it. `pathPattern` appends one, so `prefix + file` is a real
			// key; the first version concatenated a slashless prefix and produced
			// `output/live-rtmp-simplestream.m3u8` for every manifest in all 7 fixtures.
			/**
			 * The legs THIS manifest enumerates — the same helper `live/validate.ts`
			 * asks, so the two cannot answer differently again (#192).
			 *
			 * `mediaPlaylists` was `plan.renditions.map(...)`: one entry per
			 * RENDITION, plan-wide. The compiler emits one media playlist per
			 * MUXING, and a rendition muxed into the video owns none — so the
			 * muxed live golden asked for `audio_128000.m3u8` against an op list
			 * that creates nothing to produce it. `origin-observer.ts` GETs every
			 * entry, so that phantom key 404s on a HEALTHY channel and parks a
			 * permanent "origin unavailable" in front of the operator, one wasted
			 * request per sweep tick.
			 *
			 * Three instruments answered this one question three ways —
			 * `live/validate.ts` and the DVR gauge counted legs, `engine-live.ts`
			 * counted `expected.muxings.length`, and only this file counted
			 * renditions. It now counts legs like the rest.
			 */
			const selected = selectLiveManifestMuxings(plan, manifest);
			const entryUris = liveHlsEntryUris(plan);
			const mediaPlaylists =
				manifest.kind === "HLS"
					? selected.map(
							({ rendition }) =>
								entryUris.get(rendition.key) ?? liveHlsEntryUri(rendition),
						)
					: [];
			// Live ladders are uniform in practice, but if a manifest ever mixed
			// cadences the LONGEST segment gives the FEWEST elements, so using it
			// would understate the budget — take the shortest and say so.
			const legLengths = [
				...new Set(selected.map(({ muxing: m }) => m.segmentLength)),
			];
			const segmentLengthSec =
				legLengths.length > 0 ? Math.min(...legLengths) : 0;
			if (legLengths.length > 1) {
				notes.push(
					`liveManifest ${manifest.key} enumerates legs with more than one segment length (${legLengths.join(", ")}s); the C8 element estimate uses the shortest (${segmentLengthSec}s) because that yields the MOST elements and a budget check must not understate`,
				);
			}
			const videoCodecs = [
				...new Set(
					selected
						.map(({ rendition }) => rendition.codec)
						.filter((codec) => !["AAC", "DDPLUS", "DD"].includes(codec)),
				),
			];
			return {
				manifestKey: manifest.key,
				kind: manifest.kind,
				outputKey: manifest.destination.outputKey,
				dir: pathPattern(withTrailingSlash(manifest.destination.path)),
				files: [manifest.manifestName],
				mediaPlaylists,
				...(manifest.kind === "DASH" && videoCodecs.length > 0
					? { videoCodecs }
					: {}),
				...(timeshiftSec !== undefined ? { timeshiftSec } : {}),
				...(timeshiftSec !== undefined && selected.length > 0
					? {
							elementBudget: manifestElementEstimate({
								timeshiftSec,
								segmentLengthSec,
								// The legs this manifest lists, matching the Σ in
								// `live/validate.ts` — NOT plan.renditions.length.
								renditionCount: selected.length,
							}),
						}
					: {}),
			};
		},
	);

	const ingest = ingestOf(plan);
	if (!ingest.feedable) {
		notes.push(
			`${ingest.kind} cannot be driven by our feeder, so this channel can be provisioned and checked for coordinates and heartbeat but never fed — media assertions will SKIP with that reason`,
		);
	}

	const over = manifests.filter((m) => m.elementBudget?.level === "over");
	for (const m of over) {
		notes.push(
			`manifest ${m.manifestKey} declares a ${m.timeshiftSec}s window which needs ${m.elementBudget?.totalElements} manifest elements against the ${LIVE_MANIFEST_ELEMENT_BUDGET} budget (C8) — the plan is over budget before the channel starts`,
		);
	}

	// Delivery-mirror legs . Each mirror
	// carries its OUTPUT kind so the verifier can decide how to observe it — an
	// AKAMAI_MSL mirror on the edge, a readable mirror on storage. Kept off the
	// artefacts when no site actually mirrors there: a self-only storage target
	// is already represented by the primary, not a second delivered copy.
	const mirrors: ExpectedLiveMirror[] = (plan.deliveryMirrors ?? [])
		.filter(
			(mirror) =>
				plan.muxings.some(
					(muxing) =>
						muxing.destination &&
						muxing.destination.outputKey !== mirror.outputKey,
				) ||
				plan.liveManifests.some(
					(manifest) => manifest.destination.outputKey !== mirror.outputKey,
				),
		)
		.map((m) => ({
			outputKey: m.outputKey,
			kind: plan.outputs.find((o) => o.key === m.outputKey)?.kind ?? "UNKNOWN",
		}));
	const outputKinds = new Map(
		plan.outputs.map((output) => [output.key, output.kind]),
	);
	const primaryMslKeys = new Set(
		manifests
			.filter(
				(manifest) => outputKinds.get(manifest.outputKey) === "AKAMAI_MSL",
			)
			.map((manifest) => manifest.outputKey),
	);
	const mslEdgeOutputs: ExpectedLiveMslEdgeOutput[] = [
		...[...primaryMslKeys].map((outputKey) => ({
			outputKey,
			role: "PRIMARY" as const,
		})),
		...mirrors
			.filter((mirror) => mirror.kind === "AKAMAI_MSL")
			.filter((mirror) => !primaryMslKeys.has(mirror.outputKey))
			.map((mirror) => ({
				outputKey: mirror.outputKey,
				role: "MIRROR" as const,
			})),
	];

	return {
		planName: plan.name,
		ingest,
		muxings,
		...(archiveMuxings.length > 0
			? {
					archives: archiveMuxings.map((muxing) => ({
						muxingKey: muxing.key,
						outputKey: muxing.destination?.outputKey ?? "",
						dir: pathPattern(withTrailingSlash(muxing.destination?.path ?? "")),
						filename: muxing.filename,
						mirrorOutputKeys: (plan.deliveryMirrors ?? [])
							.filter(
								(mirror) => mirror.outputKey !== muxing.destination?.outputKey,
							)
							.map((mirror) => mirror.outputKey),
					})),
				}
			: {}),
		manifests,
		renditionCount,
		needsPois: plan.start?.esam !== undefined,
		...(mirrors.length > 0 ? { mirrors } : {}),
		...(mslEdgeOutputs.length > 0 ? { mslEdgeOutputs } : {}),
		notes,
	};
}
