/**
 * The live verification engine: `ExpectedLiveArtefacts` + a running channel → a report.
 *
 * The VOD engine asks "is the finished output what the plan said". A live channel is never
 * finished, so this asks three different questions, and the split is the design:
 *
 *   PROVISION  did the channel reach RUNNING, and did it hand back the coordinates its
 *              protocol owes — a stream key you cannot read is a channel you cannot feed
 *   MOVEMENT   sampled twice, some seconds apart: does the media sequence advance, do
 *              heartbeat rows accumulate, does the DVR window hold the shape the plan
 *              declared. A single sample cannot distinguish a running channel from a
 *              stalled one, which is why every check here takes two.
 *   AFTER STOP is the live-to-VOD manifest closed, and does the recording length match
 *              the time we actually fed
 *
 * Every side effect arrives through `LiveEngineDeps`, as in the VOD engine, and the rule
 * that engine learned across five instances applies here from the start:
 *
 *   **Never gate an assertion on a value the artefact under test supplies.**
 *
 * A live channel supplies more of those than a VOD output does — heartbeat counters,
 * playlist sequence numbers, a segment count that depends on when the encoder started —
 * so the temptation to write `if (sample.mediaSequence)` is stronger and the cost is the
 * same: the odd channel that reports less is the one you wanted checked. Where a value is
 * missing this emits a SKIP naming it, and `engine-live-no-silence.test.ts` pins that by
 * the same id-set property the VOD side uses.
 */

import {
	type ExpectedLiveArtefacts,
	type ExpectedLiveManifest,
	liveEvidenceProgression,
	type MediaFreshness,
	mediaFreshness,
} from "@bitovp/core";
import {
	expandRandomFilenameTokens,
	initSegmentCandidates,
} from "../bitmovin/filename-template";
import { HEARTBEAT_SWEEP_INTERVAL_MS } from "../heartbeat-cadence";
import { closureProbe, type LiveEdgeClosure } from "./edge-resolver";
import {
	type Check,
	type ObjectEntry,
	ReportBuilder,
	type VerificationReport,
} from "./engine";

// The closure types live with the resolver that builds them; re-exported so
// the engine stays the import site the runner and the tests already use.
export type {
	LiveEdgeClosure,
	LiveEdgeClosureChild,
	LiveEdgeServed,
} from "./edge-resolver";

/** One observation of a running channel. */
/**
 * A read refusal that is TOPOLOGY, not failure (review-292 I2): an
 * AKAMAI_MSL output is Akamai's ingest — no storage driver can read it back,
 * by design. Readers throw with this prefix; the engine then reports the
 * affected checks as unobservable SKIPs instead of harness-fault FAILs, so a
 * billed MSL run does not end red for a read nobody could ever perform.
 */
export const UNOBSERVABLE_READ_PREFIX = "UNOBSERVABLE: ";

export type LiveSample = {
	/** When we looked, ours — the interval between samples is the x-axis of every delta. */
	at: number;
	/** Channel status as the product reports it. */
	status: string;
	/** `#EXT-X-MEDIA-SEQUENCE` from a live media playlist, when one could be read. */
	mediaSequence?: number;
	/** Segments listed in the live playlist at this instant. */
	playlistSegments?: number;
	/** Rows in the heartbeat time series at this instant. */
	heartbeatRows?: number;
	/** Objects under the muxing prefixes at this instant. */
	objects?: ObjectEntry[];
	/**
	 * Storage or parse faults hit while taking this sample.
	 *
	 * Carried because a harness fault and a stalled channel look identical from an empty
	 * result, and the first version swallowed both into `undefined` — which the engine then
	 * honestly reported as a SKIP, so a run with a bad credential produced FAIL=0 and a
	 * PASS verdict without reading a byte. A read that FAILED is a finding about the
	 * harness, not a fact about the channel (review catch).
	 */
	readErrors?: string[];
	/**
	 * The MSL delivery-mirror legs observed on the EDGE at this sample — one
	 * closure per (manifest, mirror) leg.
	 * Taken IN-RUN, while the channel is still writing, because progression can
	 * only be witnessed between two probes on a live edge; the post-stop
	 * closure in `edgeClosures` cannot show it. Absent when no edge base URL /
	 * reader is wired — the leg is then UNOBSERVED, never a pass.
	 */
	edge?: LiveEdgeClosure[];
};

/** What the channel looked like once it had been stopped and rolled to VOD. */
export type LiveAfterStop = {
	/** Why rolling this recording to VOD is intentionally not applicable. */
	liveToVodNotApplicable?: string;
	/** Our live-to-VOD record's status. */
	liveToVodStatus?: string;
	/** The rolled VOD manifest's text, when it could be read. */
	vodManifestText?: string;
	/** Exact terminal manifests[].url closures walked by the runner. */
	vodClosures?: {
		type: "HLS" | "DASH" | "UNKNOWN";
		manifestId: string;
		url: string;
		closed: boolean;
		childCount: number;
		segmentCount: number;
		endlist?: boolean;
		missing?: string[];
		error?: string;
	}[];
	/** Seconds we actually pushed media for — the feeder knows this, nothing else does. */
	fedSeconds?: number;
	/** Duration the rolled recording reports, from a probe or the manifest. */
	recordedSeconds?: number;
	/**
	 * A storage fault hit while reading the rolled manifest.
	 *
	 * Carried for the same reason `LiveSample.readErrors` is: this read used to sit outside
	 * the `live:readable` floor entirely, so a failure here was invisible.
	 */
	readError?: string;
};

export type LiveEngineDeps = {
	/** Results from the exact-run bounded post-stop MP4 checker, not live playback. */
	archiveChecks?: readonly Check[];
	/** Coordinates the channel handed back. */
	coordinates: { streamKey?: string; encoderIp?: string };
	/** Two or more observations, in order. */
	samples: LiveSample[];
	/** Post-stop facts, absent while the channel is still running. */
	afterStop?: LiveAfterStop;
	/**
	 * Each expected manifest FILE as it was found in the bucket.
	 *
	 * The live engine reads only the HLS media playlist, through `samples`. That is right for the
	 * movement checks — a media playlist is where segments appear — but it left the manifests
	 * themselves unverified: `live-srt-listener` writes a `stream.mpd` that a directory listing
	 * plainly shows, and nothing in this file looked at it. "Live DASH works" rested on my having
	 * seen a filename, which is not a check.
	 *
	 * Collected by the runner because this engine has no reader; parsed with the same
	 * `mpd-parser`/`m3u8-parser` the VOD side uses (D1), so a manifest that a player would reject
	 * fails here too.
	 */
	manifestFiles?: {
		manifestKey: string;
		kind: "HLS" | "DASH" | "SMOOTH";
		key: string;
		bytes?: number;
		/** Video+audio representations a real parser found, when it could parse. */
		entries?: number;
		/** DASH: the codecs of each VIDEO AdaptationSet the parser found . */
		videoCodecSets?: string[][];
		error?: string;
	}[];
	/**
	 * Ingest points the channel reported, for a redundant input.
	 *
	 * Undefined when the runner could not read them, which is a SKIP and not a pass: the
	 * count is a value the channel supplies.
	 */
	ingestPoints?: string[];
	/**
	 * Edge-closure observations for delivery-MIRROR legs

	 *
	 * A `deliveryMirror` writes every destination to a SECOND output. When that
	 * output is `AKAMAI_MSL` its delivery is Akamai's edge, which no storage
	 * driver reads — so the runner reads it back over the delivery EDGE (master
	 * → all children → all listed segments, the closure the origin already
	 * gets) and hands the RESULT here, one entry per (manifest, mirror output)
	 * leg. An ABSENT entry means the edge base URL was not available, which is
	 * UNOBSERVED — a SKIP that must not pass the run, never a silent PASS. This
	 * is why `runner.ts`'s origin-only floor could not see the gap: the mirror
	 * output is not in `expected.manifests` at all (the deferred item, row 187(b)).
	 *
	 * Since this is the POST-STOP observation only. A
	 * PASS needs the two IN-RUN probes on `samples[].edge` with progression
	 * between them; this final closure can still FAIL a leg it found empty when
	 * no in-run probe exists, but it can never pass one on its own.
	 */
	edgeClosures?: LiveEdgeClosure[];
	/**
	 * Whether a feed was actually pushed.
	 *
	 * Separate from `samples` because an unfeedable ingest still produces samples — the
	 * channel runs, it simply has no media — and every movement check must SKIP with that
	 * reason rather than fail. Conflating "no feed" with "no movement" would report a
	 * correct SRT-listener provisioning run as a broken encoder.
	 */
	fed: boolean;
};

/** How far the observed DVR window may sit from the declared one. */
const DVR_WINDOW_TOLERANCE = 0.2;

/**
 * Minimum seconds between two samples for a movement check to mean anything.
 *
 * It interacts with `live:readable`, and the interaction is written down rather than tuned
 * because neither I nor a reviewer can size it without watching a real origin publish: a
 * not-found on the LAST sample is a FAIL, and at `feedSeconds`'s floor the runner sleeps
 * only ~12s. A slow origin could legitimately not have published a playlist by then, which
 * would read as a defect. The nightly's 45s is comfortable; an ad-hoc run at the floor is
 * the case to distrust, and the first real run against a live origin is what should settle
 * the number.
 */
export const MIN_SAMPLE_GAP_SEC = 10;

/**
 * Verify a live channel.
 *
 * Returns the same `VerificationReport` the VOD engine does, so `formatReport`, the run
 * report and the exit code all work unchanged — a live scenario is a row in the same table
 * as a VOD one, which is the whole point of the corpus being one corpus.
 */
/** RFC 6381 codecs strings → the plan's codec family (H264 / H265 / AV1 / VP9), else the raw prefix. */
export function codecFamily(codec: string): string {
	const lower = codec.toLowerCase();
	if (/^(avc1|avc3)/.test(lower) || lower === "h264") return "H264";
	if (/^(hvc1|hev1)/.test(lower) || lower === "h265") return "H265";
	if (/^av01/.test(lower) || lower === "av1") return "AV1";
	if (/^vp09/.test(lower) || lower === "vp9") return "VP9";
	return lower.split(".")[0] ?? lower;
}

export async function verifyLiveChannel(
	expected: ExpectedLiveArtefacts,
	deps: LiveEngineDeps,
): Promise<VerificationReport> {
	const report = new ReportBuilder();

	verifyProvisioning(report, expected, deps);
	verifyMovement(report, expected, deps);
	verifyDvrWindow(report, expected, deps);
	verifyAfterStop(report, deps);

	verifyRedundancy(report, expected, deps);
	verifyStaticIngest(report, expected);
	verifyLadderShape(report, expected, deps);
	verifyAdMarkers(report, expected, deps);
	verifyMirrorDelivery(report, expected, deps);

	/**
	 * A read that FAILED is a finding about the harness, not silence about the channel.
	 *
	 * The runner used to swallow every storage read into `undefined`, which the engine
	 * honestly turned into SKIPs — and `runner.ts` calls any report with `failed === 0` a
	 * PASS. So a bad credential, a wrong bucket or a 500 on `/heartbeats` produced a green
	 * live row that never read a byte. That is the reassuring-number shape this harness
	 * exists to remove, arriving through the SKIP arm that was built to be honest.
	 */
	/**
	 * A not-found on an EARLY sample is startup, not a fault.
	 *
	 * The floor as first written FAILed every healthy channel: sample 1 is taken at t=0 of
	 * the feed, so the playlist genuinely does not exist yet. A review pointed out this is
	 * the normal case and would have read as "the fix works" on the first nightly — the
	 * shape where a correct-looking instrument trains you to ignore it.
	 *
	 * So: any non-not-found error counts at any sample (auth, network, a wrong bucket), and
	 * a not-found counts only on the LAST sample, where the object should exist by then.
	 */
	const lastIndex = deps.samples.length - 1;
	const readErrors = [
		...deps.samples.flatMap((sample, i) =>
			(sample.readErrors ?? []).filter(
				(e) => !e.startsWith("NOTFOUND ") || i === lastIndex,
			),
		),
		// The post-stop read counts unconditionally: by then the rolled manifest must exist.
		...(deps.afterStop?.readError !== undefined
			? [deps.afterStop.readError]
			: []),
	];
	const unobservable = readErrors.filter((e) =>
		e.includes(UNOBSERVABLE_READ_PREFIX),
	);
	const realReadErrors = readErrors.filter(
		(e) => !e.includes(UNOBSERVABLE_READ_PREFIX),
	);
	if (realReadErrors.length > 0) {
		report.fail(
			"live:readable",
			"hygiene",
			`${realReadErrors.length} read(s) failed while sampling, so this report describes what could be reached rather than what the channel did: ${[...new Set(realReadErrors)].slice(0, 3).join(" | ")}`,
		);
	} else if (unobservable.length > 0) {
		report.pass(
			"live:readable",
			"hygiene",
			`every READABLE origin was read; ${unobservable.length} read(s) target an unobservable output (MSL ingest — see the run notes), which is topology, not unreadability`,
		);
	} else {
		report.pass(
			"live:readable",
			"hygiene",
			"every playlist and prefix this report relies on was readable",
		);
	}

	/**
	 * Every declared manifest must EXIST, parse, and enumerate its renditions.
	 *
	 * One check id per manifest whatever its kind, so an HLS-only report and an HLS+DASH one are
	 * diffable, and a DASH manifest can no longer be "verified" by having been seen in a bucket
	 * listing. A manifest the runner could not read is a FAIL, not a SKIP: it is declared in the
	 * plan, so its absence is the product's.
	 */
	for (const m of expected.manifests) {
		const id = `live:manifest:${m.manifestKey}`;
		const found = deps.manifestFiles?.find(
			(f) => f.manifestKey === m.manifestKey,
		);
		/**
		 * The per-codec set checks are a function of the PLAN :
		 * a DASH manifest expecting video carries `codec-sets`, and one expecting
		 * more than one codec carries `codec-sets-homogeneous` too. When the
		 * manifest could not be evaluated at all they are named SKIPs, never
		 * absent — the no-silence sweep keys on the id set under an observation
		 * that collects no files, and a mixed-codec fixture must differ from a
		 * plain one THERE, not only when an MPD was parsed (merge of #342 + #343).
		 */
		const codecSetSkips = (reason: string) => {
			if (m.kind !== "DASH" || !m.videoCodecs || m.videoCodecs.length === 0) {
				return;
			}
			report.skip(`${id}:codec-sets`, "manifest", reason);
			if (new Set(m.videoCodecs.map(codecFamily)).size > 1) {
				report.skip(`${id}:codec-sets-homogeneous`, "manifest", reason);
			}
		};
		if (!deps.manifestFiles) {
			report.skip(
				id,
				"manifest",
				"the runner did not collect manifest files, so nothing can be said about them",
			);
			codecSetSkips(
				"no manifest files were collected — the per-codec set contract was not evaluated",
			);
			continue;
		}
		if (found?.error?.includes(UNOBSERVABLE_READ_PREFIX)) {
			report.skip(
				id,
				"manifest",
				`${m.kind} manifest sits on an unobservable output (MSL ingest) — its existence cannot be read back by any driver; provisioning and push are verified by the other checks`,
			);
			codecSetSkips(
				"the manifest sits on an unobservable output — the per-codec set contract was not evaluated",
			);
			continue;
		}
		if (!found || found.error !== undefined) {
			report.fail(
				id,
				"manifest",
				`${m.kind} manifest ${m.dir.prefix}${m.files[0] ?? "(unnamed)"} — ${found?.error ?? "not collected"}`,
			);
			codecSetSkips(
				"the manifest was not read — the per-codec set contract was not evaluated",
			);
			continue;
		}
		if (
			!report.assert(
				id,
				"manifest",
				(found.bytes ?? 0) > 0,
				`${m.kind} manifest ${found.key} present — ${found.bytes ?? 0} bytes`,
			)
		) {
			continue;
		}
		/**
		 * The rendition count, as a FLOOR.
		 *
		 * A live manifest is written while the channel runs, so a ladder still coming up may
		 * legitimately show fewer entries than the plan declares — the same reasoning the VOD
		 * per-title bound arrived at, for a different cause. At least one, and never more than
		 * the plan's total, which is knowable here because live ladders are not per-title.
		 */
		if (found.entries !== undefined) {
			/**
			 * The bound comes from the MUXINGS, one per rendition leg.
			 *
			 * `ExpectedLiveManifest` carries `mediaPlaylists` (exact for HLS, empty for DASH) but
			 * no rendition total, and live ladders are not per-title — so the muxing count is the
			 * number of legs the channel produces and bounds both families the same way.
			 */
			const total = expected.muxings.length;
			report.assert(
				`${id}:entries`,
				"manifest",
				found.entries >= 1 && found.entries <= total,
				`${m.kind} manifest must enumerate between 1 and ${total} rendition(s) (the channel has ${total} muxing leg(s)) — a real parser found ${found.entries}`,
			);
		} else {
			report.skip(
				`${id}:entries`,
				"manifest",
				`${found.key} was read but not parsed, so its rendition count is unknown`,
			);
		}
		// Set STRUCTURE, not a count : one video
		// AdaptationSet per codec is the contract (C34). A count of
		// representations is satisfied by two codecs in one set — exactly the
		// MPD the provider refused. Emitted for every DASH manifest that lists
		// video; the homogeneity check only when more than one codec is
		// expected, so a mixed-codec fixture carries a check a plain one does
		// not (the no-silence guard's collision was how the gap was found).
		if (m.kind === "DASH" && m.videoCodecs && m.videoCodecs.length > 0) {
			const wantFamilies = [...new Set(m.videoCodecs.map(codecFamily))].sort();
			if (found.videoCodecSets === undefined) {
				report.skip(
					`${id}:codec-sets`,
					"manifest",
					"the parser exposed no AdaptationSet structure — the per-codec set contract cannot be checked",
				);
				if (wantFamilies.length > 1) {
					// A check that APPLIES to this plan but could not be evaluated is
					// a named SKIP, never absent: the no-silence sweep keys on the
					// id set, and a mixed-codec fixture must carry this id whether or
					// not the observation could see the sets (merge of #342 + #343).
					report.skip(
						`${id}:codec-sets-homogeneous`,
						"manifest",
						"the parser exposed no AdaptationSet structure — per-set homogeneity cannot be checked",
					);
				}
			} else {
				const sets = found.videoCodecSets.map((codecs) => [
					...new Set(codecs.map(codecFamily)),
				]);
				const gotFamilies = [...new Set(sets.flat())].sort();
				// An MPD that declares no `codecs` attributes still has a set COUNT;
				// only the family comparison needs the strings.
				const codecsDeclared = sets.some((families) => families.length > 0);
				report.assert(
					`${id}:codec-sets`,
					"manifest",
					sets.length === wantFamilies.length &&
						(!codecsDeclared ||
							JSON.stringify(gotFamilies) === JSON.stringify(wantFamilies)),
					`${wantFamilies.length} video AdaptationSet(s) for ${wantFamilies.join("+")} — found ${sets.length} set(s) carrying ${codecsDeclared ? gotFamilies.join("+") : "undeclared codecs"}`,
				);
				if (wantFamilies.length > 1 && !codecsDeclared) {
					report.skip(
						`${id}:codec-sets-homogeneous`,
						"manifest",
						"the MPD declares no codecs attributes — per-set homogeneity cannot be checked",
					);
				} else if (wantFamilies.length > 1) {
					const mixed = sets.filter((families) => families.length > 1);
					report.assert(
						`${id}:codec-sets-homogeneous`,
						"manifest",
						mixed.length === 0,
						mixed.length === 0
							? "every video AdaptationSet carries one codec"
							: `${mixed.length} video AdaptationSet(s) mix codecs (${mixed.map((f) => f.join("+")).join("; ")}) — the shape the provider refused in paid case F`,
					);
				}
			}
		}
	}

	/**
	 * And a floor: a report where NOTHING measurable moved is not a pass.
	 *
	 * Distinct from the read check above, because a channel can be perfectly readable and
	 * still tell us nothing — an origin that publishes no playlist yet, a heartbeat sweep
	 * that has not fired. Every movement check SKIPping is the signature, and design §5
	 * calls a report that verified nothing INVALID rather than green.
	 */
	const movement = report.checks.filter(
		(c) =>
			/^live:(?:media-sequence|heartbeat|segments)$/.test(c.id) ||
			/^live:(?:edge|mirror):/.test(c.id),
	);
	// Not when the harness's own sampling was the reason. `live:sample-gap` already FAILs
	// there, and two product FAILs for one harness condition is double-counting — the
	// report would blame the channel twice for our interval (review catch).
	const gapFailed =
		report.checks.find((c) => c.id === "live:sample-gap")?.verdict === "FAIL";
	if (
		deps.fed &&
		!gapFailed &&
		movement.length > 0 &&
		movement.every((c) => c.verdict === "SKIP")
	) {
		report.fail(
			"live:measured-something",
			"hygiene",
			"a feed was pushed and yet not one movement check could be evaluated — nothing about this channel was measured, which is not a pass",
		);
	}

	// Segments, heartbeat and LiveToVod do not prove the separate progressive
	// file. Keep each planned storage copy unresolved until an exact-run,
	// post-stop archive verifier supplies file/decode/A/V evidence.
	for (const archive of expected.archives ?? []) {
		for (const outputKey of new Set([
			archive.outputKey,
			...archive.mirrorOutputKeys,
		])) {
			const id = `live:archive:${archive.muxingKey}:${outputKey}`;
			const observed =
				deps.archiveChecks?.filter((check) => check.id === id) ?? [];
			if (observed.length === 1 && observed[0]) {
				report.add(id, "hygiene", observed[0].verdict, observed[0].detail);
				continue;
			}
			report.skip(
				id,
				"hygiene",
				"UNVERIFIED: exact-run post-stop MP4 file, decode and A/V duration evidence has not been collected; live delivery and LiveToVod checks do not prove this archive",
			);
		}
	}
	for (const note of expected.notes) {
		report.skip("note", "hygiene", note);
	}
	return report.build(expected.planName);
}

/**
 * Redundant ingest: are all the declared points actually there?
 *
 * `live-redundant-rtmp` emitted a check set byte-identical to `live-rtmp-simple`, so the
 * fixture existed and proved nothing about redundancy (review catch). The plan names its
 * ingest points, so the count IS knowable from the plan — and a redundant channel that came
 * back with one point is a redundancy that silently is not one, which is worse than no
 * redundancy because nobody knows.
 *
 * What is checkable without a second encoder: the channel must expose as many ingest points
 * as the plan declared. Whether a FAILOVER actually happens needs two feeds and a deliberate
 * cut, which this harness cannot stage — so that is a named SKIP rather than silence.
 */
function verifyRedundancy(
	report: ReportBuilder,
	expected: ExpectedLiveArtefacts,
	deps: LiveEngineDeps,
): void {
	const declared = expected.ingest.ingestPoints;
	if (declared === undefined || declared.length < 2) {
		return;
	}
	const observed = deps.ingestPoints;
	if (observed === undefined) {
		report.skip(
			"live:redundancy",
			"muxing",
			`the plan declares ${declared.length} ingest points (${declared.join(", ")}) but the channel reported none, so redundancy could not be checked`,
		);
	} else {
		report.assert(
			"live:redundancy",
			"muxing",
			observed.length >= declared.length,
			`a redundant channel must expose all ${declared.length} declared ingest points (${declared.join(", ")}) — ${observed.length} reported${observed.length < declared.length ? ", so this redundancy is not one" : ""}`,
		);
	}
	// Failover itself needs two feeds and a deliberate cut, which this harness cannot stage.
	report.skip(
		"live:failover",
		"muxing",
		"proving a failover needs two simultaneous feeds and a deliberate cut of the primary, which this harness cannot stage — the ingest points' presence is checked above",
	);
}

/**
 * a static-ingest channel's obligation, named rather than
 * silent. Proving the fixed FQDN accepts a push needs a real encoder against
 * live-input.bitmovin.com — the #113/#114 real-credential item — which this
 * harness cannot stage; the named SKIP keeps the check id present (the
 * no-silence invariant) and gives the static fixture the distinguishing
 * check its uniqueness demands.
 */
function verifyStaticIngest(
	report: ReportBuilder,
	expected: ExpectedLiveArtefacts,
): void {
	const declared = expected.ingest.staticIngestPoints;
	if (declared === undefined || declared.length === 0) {
		return;
	}
	report.skip(
		"live:static-ingest",
		"muxing",
		`the plan declares ${declared.length} static ingest point(s) (${declared.join(", ")}) on the fixed FQDN rtmps://live-input.bitmovin.com/live (ledger #113 exists because this hostname was once wrong) — proving the URL accepts a push needs a real encoder, which this harness cannot stage`,
	);
}

/**
 * The ladder the plan declared, against the files that appeared.
 *
 * `renditionCount`, `segmentNaming`, `initSegment` and `container` were all compiled by the
 * expectation and read by NOTHING — a review counted five such fields and pointed out that
 * three fixtures (`live-esam-full`, `live-static-ip`, `live-redundant-rtmp`) therefore
 * emitted a byte-identical check set and verified nothing distinct about the features they
 * exist for. An expectation nobody consumes is a comment.
 *
 * These are per-MUXING checks, so a ladder where one rendition never starts is visible —
 * `live:segments` counts the union and cannot see that.
 */
function verifyLadderShape(
	report: ReportBuilder,
	expected: ExpectedLiveArtefacts,
	deps: LiveEngineDeps,
): void {
	const last = deps.samples.at(-1);
	const objects = last?.objects;
	if (!deps.fed) {
		for (const id of ["live:ladder", "live:segment-naming"]) {
			report.skip(
				id,
				"muxing",
				`no media was pushed, so none of the ${expected.muxings.length} muxing prefixes can have segments — the ladder's shape is unverifiable without a feed`,
			);
		}
		return;
	}
	if (objects === undefined) {
		for (const id of ["live:ladder", "live:segment-naming"]) {
			report.skip(
				id,
				"muxing",
				"the output prefixes could not be listed, so the ladder's shape could not be checked",
			);
		}
		return;
	}

	// Every declared muxing must have written SOMETHING under its own prefix, with the
	// segment name the plan gave it. A rendition that never started leaves an empty prefix
	// while its siblings fill, which a union count hides completely.
	const silent: string[] = [];
	for (const muxing of expected.muxings) {
		const rx = patternToRegExp(
			muxing.segmentNaming,
			muxing.segmentNamingIsTemplate === true,
		);
		const initKeys = new Set(
			initSegmentCandidates(
				objects
					.filter((o) => o.key.startsWith(muxing.dir.prefix))
					.map((o) => o.key),
				muxing.initSegment,
				muxing.initSegmentNameTemplate,
			),
		);
		const mine = objects.filter(
			(o) =>
				o.key.startsWith(muxing.dir.prefix) &&
				(rx.test(o.key.split("/").pop() ?? "") || initKeys.has(o.key)),
		);
		if (mine.length === 0) {
			silent.push(`${muxing.muxingKey} (${muxing.container})`);
		}
	}
	report.assert(
		"live:ladder",
		"muxing",
		silent.length === 0,
		`all ${expected.muxings.length} declared muxings must be writing — ${silent.length === 0 ? "every rendition is producing segments" : `silent: ${silent.join(", ")}`}`,
	);

	/**
	 * And nothing may appear under a muxing prefix that the plan did not name.
	 *
	 * The cheapest of the five unread expectations to consume — no new I/O, it is a pattern
	 * match on keys already in hand — and it catches a class a COUNT cannot: a wrong naming
	 * template means the manifest references names the origin never wrote, and
	 * `live:segments` counts those files happily. A reviewer picked this as the first of the
	 * five worth doing, for exactly that reason.
	 *
	 * Extra files are the finding, not missing ones: a rung still starting has no segments
	 * yet and `live:ladder` above owns that.
	 */
	const unexpected: string[] = [];
	for (const muxing of expected.muxings) {
		const rx = patternToRegExp(
			muxing.segmentNaming,
			muxing.segmentNamingIsTemplate === true,
		);
		const initKeys = new Set(
			initSegmentCandidates(
				objects
					.filter((o) => o.key.startsWith(muxing.dir.prefix))
					.map((o) => o.key),
				muxing.initSegment,
				muxing.initSegmentNameTemplate,
			),
		);
		for (const o of objects) {
			if (!o.key.startsWith(muxing.dir.prefix)) {
				continue;
			}
			const base = o.key.slice(muxing.dir.prefix.length);
			// Only this prefix's own level, and never the init segment.
			if (base.includes("/") || initKeys.has(o.key)) {
				continue;
			}
			if (!rx.test(base)) {
				unexpected.push(`${muxing.muxingKey}/${base}`);
			}
		}
	}
	report.assert(
		"live:segment-naming",
		"muxing",
		unexpected.length === 0,
		unexpected.length === 0
			? `every segment matches the naming template its muxing declared`
			: `these objects match no declared segment name, so a manifest referencing the template would point at files the origin never wrote: ${unexpected.slice(0, 3).join(", ")}`,
	);
}

/** `%number%`-style pattern → a matcher, same rule the VOD engine uses. */
function patternToRegExp(pattern: string, namingTemplate: boolean): RegExp {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const random = namingTemplate
		? expandRandomFilenameTokens(escaped, Number.MAX_SAFE_INTEGER, true)
		: escaped;
	return new RegExp(`^${random.replace(/%[a-zA-Z]+%/g, "[^/]+")}$`);
}

/**
 * SCTE-35 / ESAM, which `needsPois` announced and nothing checked.
 *
 * `live-esam-full` existed to verify ad-marker insertion and verified exactly as much about
 * it as `live-rtmp-simple` did. This cannot assert that a marker was INSERTED — that needs
 * a POIS to respond, which is why the scenario is gated on `CAP_POIS` — but it can assert
 * the thing that is checkable without one: an ESAM channel must carry a SCTE-35 data stream
 * for the encoder to place markers into, so its playlist must be readable and its ladder
 * must include the extra stream the plan declared. Anything more is a named SKIP that says
 * what would open it, rather than silence.
 */
function verifyAdMarkers(
	report: ReportBuilder,
	expected: ExpectedLiveArtefacts,
	deps: LiveEngineDeps,
): void {
	if (!expected.needsPois) {
		return;
	}
	const last = deps.samples.at(-1);
	const text = deps.afterStop?.vodManifestText;
	if (text === undefined) {
		report.skip(
			"live:scte35",
			"manifest",
			"ESAM insertion needs a reachable POIS to respond, and the rolled playlist was not readable — so neither the request nor the resulting marker could be observed (CAP_POIS)",
		);
		return;
	}
	// `EXT-X-CUE-OUT`/`EXT-X-DATERANGE` is what an inserted marker looks like in HLS. Its
	// ABSENCE is not a failure without a POIS, so this reports what it saw rather than
	// judging it — a check that FAILed here would fail on every run until a POIS exists.
	const markers = (text.match(/#EXT-X-(CUE-OUT|DATERANGE)/g) ?? []).length;
	report.add(
		"live:scte35",
		"manifest",
		markers > 0 ? "PASS" : "SKIP",
		markers > 0
			? `${markers} ad-marker tag(s) in the rolled playlist`
			: `no ad-marker tags in the rolled playlist, which is expected without a reachable POIS to answer the ESAM request (CAP_POIS) — the channel ran with ${last?.status ?? "unknown"} status`,
	);
}

/**
 * Judge each delivery-MIRROR leg on the Akamai edge

 *
 * The origin closure the rest of this engine performs cannot reach a mirror: an
 * `AKAMAI_MSL` mirror is Akamai's ingest, and its output is not even in
 * `expected.manifests` — so a plan delivering to a readable origin AND an MSL
 * mirror passed on the origin's manifests while nothing ever looked at the
 * mirror (the deferred item, row 187(b); the manual closure that exposed it found 116/116
 * segments 404 on the edge). Here every MSL mirror × every manifest is a
 * leg, judged individually:
 *
 * closed the runner read master → all children → all listed
 * segments back on the edge, with bytes → PASS
 * missing / error the edge WAS read and did not serve it → FAIL (a mirror
 * that delivers nothing is a product failure, not "unverified")
 * no observation no edge base URL was available to read the mirror back →
 * UNOBSERVED SKIP. `runner.ts`'s mirror floor then refuses to
 * pass the whole run on the origin alone.
 *
 * The check id is a function of the PLAN (manifests × mirrors), not of what the
 * edge reported, so it is emitted whether or not the runner could read the edge
 * the no-silence property the VOD side paid for five times.
 */
function verifyMirrorDelivery(
	report: ReportBuilder,
	expected: ExpectedLiveArtefacts,
	deps: LiveEngineDeps,
): void {
	for (const target of expected.mslEdgeOutputs ?? []) {
		for (const manifest of expected.manifests) {
			if (
				target.role === "PRIMARY" &&
				manifest.outputKey !== target.outputKey
			) {
				continue;
			}
			const id = `${target.role === "MIRROR" ? "live:mirror" : "live:edge"}:${manifest.manifestKey}:${target.outputKey}`;
			const label =
				target.role === "MIRROR"
					? `MSL mirror "${target.outputKey}"`
					: `direct MSL output "${target.outputKey}"`;
			const matches = (c: LiveEdgeClosure) =>
				c.manifestKey === manifest.manifestKey &&
				c.outputKey === target.outputKey;
			/**
			 * The IN-RUN probes: one closure per
			 * sample, taken while the channel was writing. A PASS needs at least
			 * two of them, each closed (≥1 child, every child ≥1 nonzero media
			 * segment, every reference inside the policy), AND media advancing
			 * between the first and the last — two identical snapshots are a
			 * stalled edge, not a delivery. The post-stop closure is judged only
			 * when no in-run probe exists: it can still FAIL a leg it found
			 * empty, but a master that returned 200 after the stop never passes.
			 */
			const probes = deps.samples.flatMap((s) =>
				(s.edge ?? []).filter(matches),
			);
			const final = deps.edgeClosures?.find(matches);
			// Once in-run probes exist, delivery is judged exclusively from them.
			// A post-stop fetch can race CDN expiry/teardown and is verifier state,
			// not evidence that bytes observed while RUNNING were never delivered.
			const faulted = probes.find((c) => c.error !== undefined);
			if (probes.length === 0 && !final) {
				report.skip(
					id,
					"manifest",
					`the ${manifest.kind} manifest targets ${label}, delivered on the Akamai edge — no credential-bound edge observation was available, so this leg is UNOBSERVED (topology, never a pass)`,
				);
				continue;
			}
			const identityFault = probes.find(
				(closure) =>
					closure.msl?.outputKey !== target.outputKey ||
					!closure.msl.providerOutputId ||
					!closure.msl.credentialId,
			);
			if (identityFault) {
				report.fail(
					id,
					"manifest",
					`${label} ${manifest.kind} observation is not bound to the exact credential/outputKey/provider outputId for this airing`,
				);
				continue;
			}
			if (probes.length === 0 && final) {
				if (final.error !== undefined || !final.closed) {
					const missing = final.missing ?? [];
					report.fail(
						id,
						"manifest",
						final.error !== undefined
							? `${label} ${manifest.kind} edge read failed at ${final.masterUrl}: ${final.error}`
							: `${label} ${manifest.kind} edge closure at ${final.masterUrl} — ${final.childCount ?? 0} child(ren), ${final.segmentCount ?? 0} media segment(s) served, ${missing.length} not served${missing[0] ? ` (first ${missing[0]})` : ""}`,
					);
					continue;
				}
				report.skip(
					id,
					"manifest",
					`${label} ${manifest.kind} was read on the edge only AFTER the stop (${final.masterUrl}) — no in-run probe exists, so progression was never witnessed; a post-stop closure alone is UNOBSERVED, not a pass`,
				);
				continue;
			}
			if (probes.length < 2) {
				report.fail(
					id,
					"manifest",
					`${label} ${manifest.kind} edge was probed only ${probes.length} time(s) in-run at ${probes[0]?.masterUrl ?? "?"} — two probes at least ${MIN_SAMPLE_GAP_SEC}s apart are required to witness media progression`,
				);
				continue;
			}
			if (faulted !== undefined) {
				report.fail(
					id,
					"manifest",
					`${label} ${manifest.kind} edge read failed at ${faulted.masterUrl}: ${faulted.error}`,
				);
				continue;
			}
			const open = probes.find((c) => !c.closed);
			if (open) {
				const missing = open.missing ?? [];
				const rejected = open.rejected ?? [];
				report.fail(
					id,
					"manifest",
					`${label} ${manifest.kind} edge closure at ${open.masterUrl} did not close — ${open.childCount ?? 0} child(ren), ${open.segmentCount ?? 0} media segment(s) served with bytes, ${missing.length} not served${missing[0] ? ` (first ${missing[0]})` : ""}${rejected.length > 0 ? `, ${rejected.length} reference(s) refused by the URL policy (first ${rejected[0]})` : ""}`,
				);
				continue;
			}
			const first = probes[0] as LiveEdgeClosure;
			const last = probes[probes.length - 1] as LiveEdgeClosure;
			const progression = liveEvidenceProgression(
				closureProbe(first),
				closureProbe(last),
			);
			const summary = `${label} ${manifest.kind} edge closure at ${last.masterUrl} — ${last.childCount ?? 0} child(ren), ${last.segmentCount ?? 0} media segment(s) served with bytes at the last of ${probes.length} in-run probes; ${progression.detail}`;
			if (!progression.observed) {
				report.fail(id, "manifest", summary);
				continue;
			}
			/**
			 * Freshness (WP-C6b, measured 2026-09-02): a re-aired channel's root
			 * playlists ADVANCED while every object they named was the first
			 * airing's — progression alone would have passed exactly the defect.
			 * Each served media object's Last-Modified is judged against the
			 * airing's runningSince (core's `mediaFreshness`), on every in-run
			 * probe: STALE fails the leg; a missing header or start time leaves
			 * it UNVERIFIED, which is a WARN on the leg and never a pass.
			 */
			const freshnessId = `live:segment-freshness:${manifest.manifestKey}:${target.outputKey}`;
			const verdicts = probes.map((closure) =>
				mediaFreshness(
					(closure.children ?? []).flatMap((child) =>
						child.served.filter((s) => !s.init),
					),
					closure.runningSince,
				),
			);
			const stale = verdicts.find((v) => v.verdict === "STALE");
			const unverified = verdicts.find((v) => v.verdict === "UNVERIFIED");
			if (stale) {
				report.fail(
					freshnessId,
					"manifest",
					`${label} ${manifest.kind}: ${stale.detail}`,
				);
				report.fail(
					id,
					"manifest",
					`${summary}; BUT the objects are a previous airing's — ${stale.detail}`,
				);
				continue;
			}
			if (unverified) {
				report.skip(
					freshnessId,
					"manifest",
					`${label} ${manifest.kind}: object age UNVERIFIED — ${unverified.detail}`,
				);
				report.warn(
					id,
					"manifest",
					`${summary}; object freshness UNVERIFIED (${unverified.detail}) — progression alone is not delivery`,
				);
				continue;
			}
			report.pass(
				freshnessId,
				"manifest",
				`${label} ${manifest.kind}: ${(verdicts[verdicts.length - 1] as MediaFreshness).detail}`,
			);
			report.pass(
				id,
				"manifest",
				`${summary}; every served object is this airing's`,
			);
		}
	}
}

/** RUNNING, and the coordinates the protocol owes. */
function verifyProvisioning(
	report: ReportBuilder,
	expected: ExpectedLiveArtefacts,
	deps: LiveEngineDeps,
): void {
	const last = deps.samples.at(-1);
	report.assert(
		"live:running",
		"muxing",
		last?.status === "RUNNING",
		`channel must reach RUNNING — last observed status ${last?.status ?? "none"}`,
	);

	/**
	 * An ERROR observed at ANY sample, even one the channel recovered from.
	 *
	 * `live:running` asserts the LAST status, which is the design's contract — and on its
	 * own that silently discards an ERROR seen mid-run. Bitmovin's `autoRestart` can
	 * legitimately take a channel ERROR → RUNNING, so this is not a FAIL: the channel did
	 * what it was configured to do. But it is not nothing either, and dropping it is the
	 * reassuring-number shape this harness exists to remove — an operator wants to know
	 * their channel restarted, and a nightly run that never mentions it cannot tell them.
	 *
	 * I found this by driving the engine rather than reading it: a channel that was ERROR
	 * at the first sample and RUNNING at the last produced zero findings of any kind.
	 */
	const wobbled = deps.samples.filter((x) => x.status !== "RUNNING");
	if (wobbled.length > 0 && last?.status === "RUNNING") {
		report.warn(
			"live:status-stability",
			"muxing",
			`the channel reported a non-RUNNING status at ${wobbled.length} of ${deps.samples.length} samples (${[...new Set(wobbled.map((x) => x.status))].join(", ")}) and recovered — legitimate if autoRestart is configured, but worth seeing`,
		);
	} else if (last?.status === "RUNNING") {
		report.pass(
			"live:status-stability",
			"muxing",
			`the channel held RUNNING across all ${deps.samples.length} samples`,
		);
	} else {
		// "Held one status" is literally true of a channel that was ERROR at every sample,
		// and saying it is the reassuring-number shape this check's own docstring exists to
		// remove. `live:running` already FAILs; stability has nothing to add (review catch).
		report.skip(
			"live:status-stability",
			"muxing",
			`the channel never reached RUNNING (${last?.status ?? "no status"}), so stability says nothing — see live:running`,
		);
	}

	// Coordinates are what a human needs to point an encoder, so an absent one is a FAIL
	// and not a SKIP: the channel is up and unusable.
	for (const field of expected.ingest.requiresCoordinates) {
		const value = deps.coordinates[field];
		report.assert(
			`live:coordinates:${field}`,
			"muxing",
			typeof value === "string" && value.length > 0,
			`${expected.ingest.kind} must hand back ${field} — ${value ? "present" : "absent"}`,
		);
	}
}

/**
 * Does anything actually move?
 *
 * Two samples, and the gap between them has to be big enough to matter: on a 6-second
 * ladder, two samples one second apart prove nothing about a channel that has stalled.
 * The gap is asserted rather than assumed, because a runner that sampled too fast would
 * otherwise turn a real stall into a green report.
 */
function verifyMovement(
	report: ReportBuilder,
	expected: ExpectedLiveArtefacts,
	deps: LiveEngineDeps,
): void {
	const first = deps.samples.at(0);
	const last = deps.samples.at(-1);
	if (!first || !last || deps.samples.length < 2) {
		report.skip(
			"live:movement",
			"muxing",
			`movement needs at least two samples — ${deps.samples.length} taken, so nothing about advance or stall can be said`,
		);
		for (const id of [
			"live:sample-gap",
			"live:media-sequence",
			"live:heartbeat",
			"live:segments",
			"live:segment-bytes",
		]) {
			// The sample COUNT is harness-supplied rather than artefact-supplied, so the
			// invariant does not strictly demand this — but a report whose id set changes
			// shape with the harness's own sampling is still harder to diff, and a reviewer
			// noted this axis was the one untested. Now it holds on every axis.
			report.skip(
				id,
				"muxing",
				`only ${deps.samples.length} sample(s) were taken, so this could not be judged`,
			);
		}
		return;
	}

	const gapSec = (last.at - first.at) / 1000;
	if (
		!report.assert(
			"live:sample-gap",
			"muxing",
			gapSec >= MIN_SAMPLE_GAP_SEC,
			`samples must be at least ${MIN_SAMPLE_GAP_SEC}s apart for movement to mean anything — ${gapSec.toFixed(1)}s`,
		)
	) {
		// Report the movement checks as SKIPs rather than deciding on a bad interval: a
		// vanished check is the fifth quiet state, and a FAIL here would blame the channel
		// for the harness's sampling.
		for (const id of [
			"live:media-sequence",
			"live:heartbeat",
			"live:segments",
			"live:segment-bytes",
		]) {
			report.skip(
				id,
				"muxing",
				`samples were only ${gapSec.toFixed(1)}s apart, below the ${MIN_SAMPLE_GAP_SEC}s floor — not judged`,
			);
		}
		return;
	}

	// Nothing may move if nothing was pushed. Named SKIPs, so an SRT-listener or Zixi run
	// reports honestly rather than failing for a feed it was never going to get.
	if (!deps.fed) {
		for (const id of [
			"live:media-sequence",
			"live:heartbeat",
			"live:segments",
			// `live:segment-bytes` belongs here for the same reason as the rest. The
			// invariant test caught its absence within seconds of it being written — which
			// is the whole argument for having the property rather than a checklist.
			"live:segment-bytes",
		]) {
			report.skip(
				id,
				"muxing",
				`no media was pushed to this ${expected.ingest.kind} ingest, so ${id.split(":")[1]} cannot advance — the channel's provisioning is still verified above`,
			);
		}
		return;
	}

	/**
	 * `#EXT-X-MEDIA-SEQUENCE` advances only when segments are REMOVED, so a short feed cannot
	 * make it move.
	 *
	 * Per the HLS spec it is the media sequence number of the FIRST segment in the playlist —
	 * it increments as segments roll off the head, which happens only once the DVR window is
	 * full. `live-srt-listener` FAILed a real run with `0 → 0` on a channel that was entirely
	 * healthy: the bucket holds 7 audio segments, 7 at 360p and 7 at 720p, and `live:segments`
	 * PASSed in the same report. With a 90s feed against a multi-minute window nothing had
	 * rolled off yet, so 0 → 0 was the CORRECT reading and the assertion was wrong.
	 *
	 * So this only asserts advance when the playlist demonstrably dropped something — the
	 * segment count stopped growing as fast as the sequence should have moved. Otherwise it is a
	 * named SKIP that says why, which keeps the check id present (the no-silence invariant) and
	 * stops it being a guaranteed false red on every short feed.
	 */
	const grew = (last.playlistSegments ?? 0) - (first.playlistSegments ?? 0);
	const windowFull =
		first.playlistSegments !== undefined &&
		last.playlistSegments !== undefined &&
		grew <= 0 &&
		(last.playlistSegments ?? 0) > 0;
	if (windowFull) {
		advanced(
			report,
			"live:media-sequence",
			first.mediaSequence,
			last.mediaSequence,
			"the playlist stopped growing, so segments are rolling off and #EXT-X-MEDIA-SEQUENCE must advance",
			"the live playlist's media sequence could not be read",
		);
	} else if (
		first.playlistSegments === undefined ||
		last.playlistSegments === undefined
	) {
		/**
		 * UNREADABLE is not the same as GROWING, and my first version said it was.
		 *
		 * `windowFull` requires both segment counts, so an unreadable playlist fell into the
		 * else-branch and got the message "the playlist grew by 0 segment(s) without dropping
		 * any" — a confident statement about a file the harness never read. REAL-LIVE-5 printed
		 * exactly that. The two states need different sentences: one is a normal short feed, the
		 * other is a fault in the harness or the storage that must not read as normal.
		 */
		report.skip(
			"live:media-sequence",
			"muxing",
			"the live media playlist could not be read at both samples, so nothing can be said about #EXT-X-MEDIA-SEQUENCE — this is a read failure, not a healthy short feed (see live:readable)",
		);
	} else {
		report.skip(
			"live:media-sequence",
			"muxing",
			`the playlist grew by ${grew} segment(s) without dropping any, so #EXT-X-MEDIA-SEQUENCE stays at ${first.mediaSequence ?? "unknown"} by definition — it counts segments REMOVED from the head, and none have been. Movement is judged by live:segments instead.`,
		);
	}
	if (gapSec * 1000 < HEARTBEAT_SWEEP_INTERVAL_MS) {
		report.skip(
			"live:heartbeat",
			"muxing",
			`samples were ${gapSec.toFixed(1)}s apart, shorter than one ${(HEARTBEAT_SWEEP_INTERVAL_MS / 1000).toFixed(1)}s heartbeat sweep — heartbeat movement not judged`,
		);
	} else {
		advanced(
			report,
			"live:heartbeat",
			first.heartbeatRows,
			last.heartbeatRows,
			"heartbeat rows must accumulate while the channel runs",
			"the heartbeat series could not be read",
		);
	}
	advanced(
		report,
		"live:segments",
		first.objects?.length,
		last.objects?.length,
		"segments must keep being written while the channel runs",
		"the output prefix could not be listed",
	);

	/**
	 * And the segments must contain something.
	 *
	 * `live:segments` counts FILES, so an origin write failure that truncates every segment
	 * to zero bytes reads as a perfectly healthy channel — the same blind spot §9b records
	 * for the VOD side ("nothing reads `ObjectEntry.size`"), here closed because a live
	 * channel writes continuously and a broken origin is exactly what it would look like
	 * (review catch).
	 *
	 * `size` is a value the world supplies, so an absent one SKIPs rather than gating.
	 */
	const sized = (last.objects ?? []).filter((o) => o.size !== undefined);
	if (sized.length === 0) {
		report.skip(
			"live:segment-bytes",
			"muxing",
			`the listing reported no object sizes, so ${last.objects?.length ?? 0} segment(s) could not be checked for content`,
		);
	} else {
		const empty = sized.filter((o) => (o.size ?? 0) === 0);
		report.assert(
			"live:segment-bytes",
			"muxing",
			empty.length === 0,
			`segments must carry bytes — ${empty.length} of ${sized.length} are zero-length${empty.length > 0 ? ` (${empty[0]?.key})` : ""}`,
		);
	}
}

/**
 * One monotonic counter, asserted to have moved — or a SKIP naming what was unreadable.
 *
 * The SKIP arm is the rule: `before`/`after` are values the channel supplies, so gating
 * the assertion on them would let a channel that reports nothing decide it is not checked.
 */
function advanced(
	report: ReportBuilder,
	id: string,
	before: number | undefined,
	after: number | undefined,
	what: string,
	unreadable: string,
): void {
	if (before === undefined || after === undefined) {
		report.skip(id, "muxing", `${unreadable}, so it could not be checked`);
		return;
	}
	report.assert(id, "muxing", after > before, `${what} — ${before} → ${after}`);
}

/**
 * The DVR window: shape, and the C8 budget.
 *
 * The budget half is checkable from the plan alone and is therefore checked even on a
 * channel that never carried media — an over-budget window is a defect at authoring time,
 * not at runtime, and saying so before a feed is pointed at it is the useful moment.
 */
function verifyDvrWindow(
	report: ReportBuilder,
	expected: ExpectedLiveArtefacts,
	deps: LiveEngineDeps,
): void {
	for (const manifest of expected.manifests) {
		budgetCheck(report, manifest);
	}

	const last = deps.samples.at(-1);
	const windowed = expected.manifests.filter(
		(m) => m.timeshiftSec !== undefined,
	);
	if (windowed.length === 0) {
		return;
	}
	if (!deps.fed) {
		for (const m of windowed.filter((x) => x.kind === "HLS")) {
			report.skip(
				`live:dvr:${m.manifestKey}`,
				"manifest",
				`no media was pushed, so the observed DVR window is empty by definition — the ${m.timeshiftSec}s window's element budget is still checked above`,
			);
		}
		return;
	}
	if (last?.playlistSegments === undefined) {
		for (const m of windowed.filter((x) => x.kind === "HLS")) {
			report.skip(
				`live:dvr:${m.manifestKey}`,
				"manifest",
				"the live playlist's segment count could not be read, so the observed window could not be measured",
			);
		}
		return;
	}

	/**
	 * HLS only. The DASH arm is DELETED, not documented.
	 *
	 * The runner measures `playlistSegments` from an HLS media playlist, and the first
	 * version applied that single number to EVERY windowed manifest including DASH — the
	 * wrong instrument, not an unreachable check. Filing that under "known limitations"
	 * would bury a latent wrong assertion where the next person to make it reachable
	 * inherits a check that is silently wrong with no reason to suspect it. A check that is
	 * both dead and wrong is worse than no check, because it occupies the slot a correct one
	 * would go in (review argument, and it is right).
	 *
	 * The C8 BUDGET check above still covers every manifest, DASH included: it is plan-side,
	 * it fires, and it is the one that catches the defect that costs money.
	 */
	for (const m of windowed.filter((x) => x.kind === "HLS")) {
		const shortest = Math.min(
			...expected.muxings.map((x) => x.segmentLengthSec),
		);
		const wantSegments = Math.ceil((m.timeshiftSec as number) / shortest);
		const observed = last.playlistSegments;
		// A window still FILLING is not a defect — a channel fed for 30s cannot show a
		// 2-hour window — so the check is one-sided: never MORE than the declared window
		// (plus tolerance), because that is the failure that blows the element budget.
		report.assert(
			`live:dvr:${m.manifestKey}`,
			"manifest",
			observed <= Math.ceil(wantSegments * (1 + DVR_WINDOW_TOLERANCE)),
			`the ${m.timeshiftSec}s window allows at most ${wantSegments} segments per rendition (+${DVR_WINDOW_TOLERANCE * 100}% tolerance) — playlist carries ${observed}. A window still filling is fine; one that overruns is what breaks the C8 budget`,
		);
	}
}

/** C8: the element estimate against the 54,000 budget. */
function budgetCheck(
	report: ReportBuilder,
	manifest: ExpectedLiveManifest,
): void {
	const budget = manifest.elementBudget;
	if (budget === undefined) {
		// No declared window means no budget question — a PLAN field, so nothing is owed.
		return;
	}
	const id = `live:c8:${manifest.manifestKey}`;
	if (budget.level === "over") {
		report.fail(
			id,
			"manifest",
			`C8: a ${manifest.timeshiftSec}s window needs ${budget.totalElements} manifest elements against the ${budget.budget} budget (${(budget.utilization * 100).toFixed(0)}%) — this channel is over budget as authored`,
		);
		return;
	}
	report.add(
		id,
		"manifest",
		budget.level === "warning" ? "WARN" : "PASS",
		`C8: ${budget.totalElements} of ${budget.budget} manifest elements (${(budget.utilization * 100).toFixed(0)}%) for a ${manifest.timeshiftSec}s window`,
	);
}

/**
 * What is only true after a stop.
 *
 * A live playlist has no `#EXT-X-ENDLIST` by definition; the rolled VOD manifest must
 * have one, or a player treats the recording as a still-running stream and never shows a
 * seek bar. That single tag is the difference between a recording and a broken stream, so
 * it gets its own check.
 */
function verifyAfterStop(report: ReportBuilder, deps: LiveEngineDeps): void {
	const after = deps.afterStop;
	if (after === undefined) {
		for (const id of [
			"live:to-vod",
			"live:to-vod:closure",
			"live:to-vod:endlist",
			"live:recorded",
		]) {
			report.skip(
				id,
				"manifest",
				"the channel was not stopped in this run, so post-stop facts do not exist yet",
			);
		}
		return;
	}
	if (after.liveToVodNotApplicable !== undefined) {
		for (const id of [
			"live:to-vod",
			"live:to-vod:closure",
			"live:to-vod:endlist",
			"live:recorded",
		]) {
			report.skip(id, "manifest", after.liveToVodNotApplicable);
		}
		return;
	}

	report.assert(
		"live:to-vod",
		"manifest",
		after.liveToVodStatus === "FINISHED",
		`live-to-VOD must finish — status ${after.liveToVodStatus ?? "none"}`,
	);

	const closures = after.vodClosures ?? [];
	const brokenClosures = closures.filter((closure) => !closure.closed);
	report.assert(
		"live:to-vod:closure",
		"manifest",
		closures.length > 0 && brokenClosures.length === 0,
		closures.length === 0
			? "the terminal live-to-VOD record exposed no manifest identity to verify"
			: brokenClosures.length > 0
				? `${brokenClosures.length}/${closures.length} terminal manifest closure(s) failed: ${brokenClosures
						.slice(0, 3)
						.map(
							(closure) =>
								`${closure.type} ${closure.url}: ${closure.error ?? closure.missing?.join(", ") ?? "not closed"}`,
						)
						.join(" | ")}`
				: `${closures.length} exact terminal manifest(s) closed through every referenced child and media object`,
	);

	const hlsClosures = closures.filter((closure) => closure.type === "HLS");
	if (hlsClosures.length === 0) {
		report.skip(
			"live:to-vod:endlist",
			"manifest",
			"the terminal record exposed no HLS manifest; ENDLIST is not a DASH property",
		);
	} else {
		report.assert(
			"live:to-vod:endlist",
			"manifest",
			hlsClosures.every((closure) => closure.endlist === true),
			"every child/audio playlist of every terminal HLS manifest must carry #EXT-X-ENDLIST — without it a player treats the recording as a live stream and shows no seek bar",
		);
	}

	if (after.fedSeconds === undefined || after.recordedSeconds === undefined) {
		report.skip(
			"live:recorded",
			"manifest",
			`recording length needs both the fed duration and the recorded duration — fed ${after.fedSeconds ?? "unknown"}, recorded ${after.recordedSeconds ?? "unknown"}`,
		);
		return;
	}
	// Generous on purpose: an encoder starts when it starts, and the first GOP is not
	// instant. What this catches is a recording that captured a fraction of the feed, or
	// one whose duration ran away — not the second or two at each edge.
	const ratio = after.recordedSeconds / after.fedSeconds;
	report.assert(
		"live:recorded",
		"manifest",
		ratio >= 0.6 && ratio <= 1.4,
		`the recording should be within [0.6×, 1.4×] of the ${after.fedSeconds.toFixed(1)}s fed — recorded ${after.recordedSeconds.toFixed(1)}s (${ratio.toFixed(2)}×)`,
	);
}

/** Re-exported so callers can build a live report without importing two modules. */
export type { Check, VerificationReport };
