import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePlan, qcMirrorFilename } from "./compiler";
import {
	hlsAudioLegsByRendition,
	hlsAudioMediaDefaults,
	hlsChildFiles,
	hlsStaticChildUris,
} from "./hls-media-defaults";
import { encodingPlanSchema } from "./schema";
import { validatePlan } from "./validate";

/**
 * The derivation both the compiler and the validator read . The
 * fixture is the vendor's own two-audio sample — the one whose transcription
 * gave both renditions the vendor's ONE-audio literal.
 */
function fixture() {
	return encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__/fixed-bitrate-hls-on-aws.plan.json"),
				"utf8",
			),
		),
	);
}
const HLS = { audioGroupId: "audio" };

describe("static I-frame write names without changing verifier media children", () => {
	it("matches every compiler I-frame filename in retained plan fixtures", () => {
		let iframeCount = 0;
		const dir = join(__dirname, "__fixtures__");
		for (const file of readdirSync(dir).filter((f) =>
			f.endsWith(".plan.json"),
		)) {
			const plan = encodingPlanSchema.parse(
				JSON.parse(readFileSync(join(dir, file), "utf8")),
			);
			const ops = compilePlan(plan);
			for (const manifest of plan.manifests) {
				if (manifest.kind !== "HLS") continue;
				const iframeNames = ops
					.filter(
						(op) =>
							op.kind === "CREATE_HLS_IFRAME_PLAYLIST" &&
							op.refs.manifestId === `manifest:${manifest.key}`,
					)
					.map((op) => (op.payload as { filename: string }).filename);
				iframeCount += iframeNames.length;
				const ordinary = hlsChildFiles(plan, manifest);
				expect(
					hlsStaticChildUris(plan, manifest),
					`${file}/${manifest.key}`,
				).toEqual([...new Set([...ordinary, ...iframeNames])]);
				for (const filename of iframeNames)
					expect(ordinary).not.toContain(filename);
			}
		}
		expect(iframeCount).toBeGreaterThan(0);
	});

	it.each([
		"disabled",
		"no-groups",
		"unselected",
		"per-title",
	])("omits I-frame files the compiler does not create: %s", (mode) => {
		const plan = fixture();
		const manifest = plan.manifests.find((m) => m.kind === "HLS");
		if (manifest?.kind !== "HLS") throw new Error("fixture");
		manifest.variantsPerAudioGroup = true;
		manifest.iframePlaylists = mode !== "disabled";
		for (const r of plan.renditions) {
			if (r.codec === "AAC" && mode !== "no-groups")
				r.hlsMedia = { groupId: r.key, name: r.key, uri: `${r.key}.m3u8` };
			if (r.codec === "H264" && mode === "per-title")
				r.mode = "PER_TITLE_TEMPLATE";
		}
		if (mode === "unselected") manifest.videoMuxingKind = "TS";
		expect(
			compilePlan(plan).filter(
				(op) => op.kind === "CREATE_HLS_IFRAME_PLAYLIST",
			),
		).toEqual([]);
		expect(hlsStaticChildUris(plan, manifest)).toEqual(
			hlsChildFiles(plan, manifest),
		);
	});
});

describe("hlsAudioMediaDefaults", () => {
	it("two defaulted audios: names carry the rendition key, URIs keep the bitrate", () => {
		const d = hlsAudioMediaDefaults(fixture(), HLS);
		expect(d.get("a128")).toEqual({
			name: "HLS Audio Media (a128)",
			uri: "audio_128000.m3u8",
			explicit: false,
		});
		expect(d.get("a64")).toEqual({
			name: "HLS Audio Media (a64)",
			uri: "audio_64000.m3u8",
			explicit: false,
		});
	});

	it("ONE defaulted audio keeps the vendor literal byte-for-byte", () => {
		// Every single-audio golden depends on this arm: the suffix must not
		// appear when there is nothing to disambiguate from.
		const plan = fixture();
		plan.renditions = plan.renditions.filter((r) => r.key !== "a64");
		const d = hlsAudioMediaDefaults(plan, HLS);
		expect(d.get("a128")).toEqual({
			name: "HLS Audio Media",
			uri: "audio_128000.m3u8",
			explicit: false,
		});
	});

	it("two defaulted audios at the SAME bitrate switch the URI to the key", () => {
		// 128k stereo and 128k 5.1 — a real ladder — collided on
		// `audio_128000.m3u8`, two media entries on one playlist.
		const plan = fixture();
		for (const r of plan.renditions) {
			if (r.key === "a64" && r.codec === "AAC") {
				r.bitrate = 128000;
			}
		}
		const d = hlsAudioMediaDefaults(plan, HLS);
		expect(d.get("a128")?.uri).toBe("audio_a128.m3u8");
		expect(d.get("a64")?.uri).toBe("audio_a64.m3u8");
	});

	it("an explicit hlsMedia block is returned verbatim, marked explicit", () => {
		const plan = fixture();
		for (const r of plan.renditions) {
			if (r.key === "a128" && r.codec === "AAC") {
				r.hlsMedia = { groupId: "audio", name: "English", uri: "en.m3u8" };
			}
		}
		const d = hlsAudioMediaDefaults(plan, HLS);
		expect(d.get("a128")).toEqual({
			name: "English",
			uri: "en.m3u8",
			explicit: true,
		});
		// The OTHER rendition is now the only defaulted one — no suffix.
		expect(d.get("a64")?.name).toBe("HLS Audio Media");
	});

	it("audioMediaUri applies to a single defaulted audio and is IGNORED for a shared group", () => {
		const one = fixture();
		one.renditions = one.renditions.filter((r) => r.key !== "a64");
		expect(
			hlsAudioMediaDefaults(one, { ...HLS, audioMediaUri: "audio.m3u8" }).get(
				"a128",
			)?.uri,
		).toBe("audio.m3u8");
		// Two defaulted: honoring the literal would put both on one playlist.
		const two = hlsAudioMediaDefaults(fixture(), {
			...HLS,
			audioMediaUri: "audio.m3u8",
		});
		expect(two.get("a128")?.uri).toBe("audio_128000.m3u8");
		expect(two.get("a64")?.uri).toBe("audio_64000.m3u8");
	});
});

/**
 * Review-323 I1: the population is the MANIFEST's, not the plan's. Two HLS
 * manifests partitioned by `audioMuxingKind` — the mechanism eight fixtures
 * already use — each with one dedicated audio rendition: neither has anything
 * to disambiguate, so neither may leave the vendor literal.
 */
function twoManifestPlan() {
	const plan = fixture();
	const a64 = plan.muxings.find((m) => m.key === "a64");
	if (a64?.kind !== "FMP4") {
		throw new Error("fixture drift: a64 is not an FMP4 muxing");
	}
	// a64 becomes the TS leg's audio — its own muxing, its own manifest.
	plan.muxings = plan.muxings.filter((m) => m.key !== "a64");
	plan.muxings.push({
		key: "a64",
		kind: "TS",
		streamKey: "a64",
		segmentLength: 6,
		segmentNaming: "seg_%number%.ts",
		destination: a64.destination,
	} as (typeof plan.muxings)[number]);
	const hls = plan.manifests[0];
	if (hls?.kind !== "HLS") {
		throw new Error("fixture drift: manifests[0] is not HLS");
	}
	hls.audioMuxingKind = "FMP4";
	hls.videoMuxingKind = "FMP4";
	plan.manifests.push({
		...hls,
		key: "hls-ts",
		manifestName: "stream-ts.m3u8",
		audioMuxingKind: "TS",
	} as (typeof plan.manifests)[number]);
	return plan;
}

describe("hlsAudioMediaDefaults — scoped to the manifest", () => {
	it("a second manifest's own audio does not rename this manifest's sole entry", () => {
		const plan = twoManifestPlan();
		const hls = plan.manifests[0];
		const hlsTs = plan.manifests[1];
		if (hls?.kind !== "HLS" || hlsTs?.kind !== "HLS") {
			throw new Error("twoManifestPlan drift: expected two HLS manifests");
		}
		expect(hlsAudioMediaDefaults(plan, hls).get("a128")?.name).toBe(
			"HLS Audio Media",
		);
		expect(hlsAudioMediaDefaults(plan, hls).has("a64")).toBe(false);
		expect(hlsAudioMediaDefaults(plan, hlsTs).get("a64")?.name).toBe(
			"HLS Audio Media",
		);
		expect(hlsAudioMediaDefaults(plan, hlsTs).has("a128")).toBe(false);
	});

	it("through the compiler: separate destinations preserve both vendor literals without collisions", () => {
		const plan = twoManifestPlan();
		const second = plan.manifests[1];
		if (!second) throw new Error("second manifest fixture required");
		second.destination = {
			...second.destination,
			path: "ts-manifest/",
		};
		const names = compilePlan(plan)
			.filter((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA")
			.map((op) => [op.step, (op.payload as { name: string }).name]);
		expect(names).toEqual([
			["hls-media:hls:a128", "HLS Audio Media"],
			["hls-media:hls-ts:a64", "HLS Audio Media"],
		]);
		const codes = validatePlan(plan)
			.map((i) => i.code)
			.filter((c) => /PLAN_HLS_MEDIA|PLAN_HLS_AUDIO_MEDIA/.test(c));
		expect(codes).toEqual([]);
	});

	it("rejects the old shared-destination fixture despite each master's unique audio population", () => {
		const plan = encodingPlanSchema.parse(twoManifestPlan());
		const videoUris = compilePlan(plan)
			.filter((op) => op.kind === "CREATE_HLS_STREAM_INFO")
			.map((op) => (op.payload as { uri: string }).uri);
		expect(videoUris).toHaveLength(4);
		expect(new Set(videoUris).size).toBe(2);
		expect(
			validatePlan(plan).filter(
				(i) => i.code === "PLAN_HLS_MEDIA_URI_COLLISION" && i.level === "error",
			),
		).toHaveLength(2); // Both masters generate each of the two video children.
	});

	it("audioMediaUri on a one-audio manifest is not 'shared' because another manifest has audio too", () => {
		// The validator's PLAN_HLS_AUDIO_MEDIA_URI_SHARED counted defaulted
		// audios plan-wide — the same scope error, one rule over.
		const plan = twoManifestPlan();
		const hls = plan.manifests[0];
		if (hls?.kind !== "HLS") {
			throw new Error("twoManifestPlan drift");
		}
		hls.audioMediaUri = "audio.m3u8";
		const codes = validatePlan(plan).map((i) => i.code);
		expect(codes).not.toContain("PLAN_HLS_AUDIO_MEDIA_URI_SHARED");
		expect(
			hlsAudioMediaDefaults(plan, hls).get("a128")?.uri,
			"the literal override applies to the sole entry",
		).toBe("audio.m3u8");
	});

	it("an audio rendition with NO muxing is not in any manifest's group", () => {
		// The same scope error one step earlier: a rendition the compiler emits
		// nothing for must not count toward "shared" either.
		const plan = fixture();
		plan.muxings = plan.muxings.filter((m) => m.key !== "a64");
		expect(hlsAudioMediaDefaults(plan, HLS).get("a128")?.name).toBe(
			"HLS Audio Media",
		);
	});
});

/**
 * 2026-08-29 paid re-audit HIGH-5 — 's other axis.
 *
 * #201 made the derived NAME and URI unique ACROSS renditions; both are keyed
 * BY rendition, so ONE rendition packaged into TWO legs of one manifest emitted
 * two EXT-X-MEDIA rows carrying identical values. The plan below is the whole
 * defect: one audio rendition, an fMP4 leg for DASH and a TS leg for HLS, and
 * an HLS manifest that pins neither — so it lists both.
 */
function multiLegPlan(pin?: "FMP4" | "TS") {
	const plan = fixture();
	const a128 = plan.muxings.find((m) => m.key === "a128");
	if (a128?.kind !== "FMP4") {
		throw new Error("fixture drift: a128 is not an FMP4 muxing");
	}
	plan.muxings.push({
		key: "a128-ts",
		kind: "TS",
		streamKey: "a128",
		segmentLength: 6,
		segmentNaming: "seg_%number%.ts",
		destination: a128.destination,
	} as (typeof plan.muxings)[number]);
	const hls = plan.manifests[0];
	if (hls?.kind !== "HLS") {
		throw new Error("fixture drift: manifests[0] is not HLS");
	}
	if (pin) {
		hls.audioMuxingKind = pin;
	}
	return plan;
}

const mediaOps = (plan: ReturnType<typeof fixture>) =>
	compilePlan(plan)
		.filter((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA")
		.map((op) => [
			op.step,
			(op.payload as { name: string; uri: string }).name,
			(op.payload as { name: string; uri: string }).uri,
		]);

describe("one audio rendition, several muxing legs (HIGH-5)", () => {
	it("emits ONE media entry per rendition, not one per muxing", () => {
		// Two rows here would share NAME and URI: RFC 8216 §4.3.4.1.1 refuses
		// the first, and the second means the encoder writes one playlist twice.
		expect(mediaOps(multiLegPlan())).toEqual([
			["hls-media:hls:a128", "HLS Audio Media (a128)", "audio_128000.m3u8"],
			["hls-media:hls:a64", "HLS Audio Media (a64)", "audio_64000.m3u8"],
		]);
	});

	it("the derivation still counts the rendition once — no phantom third audio", () => {
		const plan = multiLegPlan();
		const hls = plan.manifests[0];
		if (hls?.kind !== "HLS") {
			throw new Error("multiLegPlan drift");
		}
		expect([...hlsAudioMediaDefaults(plan, hls).keys()]).toEqual([
			"a128",
			"a64",
		]);
		expect(hlsAudioLegsByRendition(plan, hls).get("a128")).toEqual([
			"a128",
			"a128-ts",
		]);
	});

	it("the validator refuses the shape — the pin is the author's call, not ours", () => {
		const issue = validatePlan(multiLegPlan()).find(
			(i) => i.code === "PLAN_HLS_RENDITION_MULTI_LEG",
		);
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("a128, a128-ts");
		expect(issue?.message).toContain('rendition "a128"');
	});

	it("pinning audioMuxingKind selects ONE leg and the plan validates", () => {
		for (const pin of ["FMP4", "TS"] as const) {
			const plan = multiLegPlan(pin);
			expect(
				validatePlan(plan).map((i) => i.code),
				`${pin} pin`,
			).not.toContain("PLAN_HLS_RENDITION_MULTI_LEG");
			// The FMP4 pin keeps both renditions (a64 is fMP4 too), so both keep
			// the disambiguating suffix. The TS pin lists a128's TS leg ONLY —
			// a64 has no TS leg, so it leaves this manifest's group entirely and
			// a128 becomes the sole defaulted entry, back to the vendor literal
			// (review-323 I1: the population is the MANIFEST's).
			expect(mediaOps(plan), `${pin} pin`).toEqual(
				pin === "FMP4"
					? [
							[
								"hls-media:hls:a128",
								"HLS Audio Media (a128)",
								"audio_128000.m3u8",
							],
							[
								"hls-media:hls:a64",
								"HLS Audio Media (a64)",
								"audio_64000.m3u8",
							],
						]
					: [["hls-media:hls:a128-ts", "HLS Audio Media", "audio_128000.m3u8"]],
			);
		}
	});

	it("the same rail covers VIDEO legs — one variant uri, two muxings", () => {
		// `hlsVariantUri` is keyed by bitrate alone, so two legs of one video
		// rendition collide exactly as the audio ones do.
		const plan = fixture();
		const v360 = plan.muxings.find((m) => m.key === "v360");
		if (v360?.kind !== "FMP4") {
			throw new Error("fixture drift: v360 is not an FMP4 muxing");
		}
		plan.muxings.push({
			key: "v360-ts",
			kind: "TS",
			streamKey: "v360",
			segmentLength: 6,
			segmentNaming: "seg_%number%.ts",
			destination: v360.destination,
		} as (typeof plan.muxings)[number]);
		const issue = validatePlan(plan).find(
			(i) => i.code === "PLAN_HLS_RENDITION_MULTI_LEG",
		);
		expect(issue?.message).toContain("v360, v360-ts");
	});

	it("the untouched fixture is silent — the rail needs a SECOND leg", () => {
		expect(validatePlan(fixture()).map((i) => i.code)).not.toContain(
			"PLAN_HLS_RENDITION_MULTI_LEG",
		);
	});
});

describe("qcMirrorFilename (ledger #205)", () => {
	it("VP9 rides a progressive WebM; every other codec keeps the MP4 mirror", () => {
		// The provider refused a VP9 progressive MP4 with "Codec type not
		// supported" (paid audit 893eb66 case 9). One definition: the compiler
		// emits it, the VMAF runner's target enumeration reads it.
		expect(qcMirrorFilename("v1080", "VP9")).toBe("v1080.webm");
		for (const codec of ["H264", "H265", "AV1"]) {
			expect(qcMirrorFilename("v1080", codec)).toBe("v1080.mp4");
		}
	});
});

describe("video variants sharing a bitrate (row #325)", () => {
	function iframePlan(copies: number) {
		const plan = fixture();
		const video = plan.renditions.find((r) => r.key === "v540");
		const muxing = plan.muxings.find((m) => m.key === "v540");
		const manifest = plan.manifests.find((m) => m.kind === "HLS");
		if (!video || !muxing?.destination || manifest?.kind !== "HLS")
			throw new Error("fixture shape changed");
		for (let n = 1; n < copies; n += 1) {
			const key = `v540-${n}`;
			plan.renditions.push({ ...video, key });
			plan.muxings.push({
				...muxing,
				key,
				streamKey: key,
				destination: {
					...muxing.destination,
					path: `${muxing.destination.path}-${n}`,
				},
			});
		}
		for (const r of plan.renditions) {
			if (r.codec === "H264") r.hlsVariantLabel = "h264";
			if (r.codec === "AAC")
				r.hlsMedia = { groupId: r.key, name: r.key, uri: `${r.key}.m3u8` };
		}
		manifest.variantsPerAudioGroup = true;
		manifest.iframePlaylists = true;
		return { plan, manifest };
	}

	it.each([
		2, 3,
	])("gives %i same-label/height/bitrate I-frame writers unique names shared with static checks", (copies) => {
		const { plan, manifest } = iframePlan(copies);
		expect(
			validatePlan(encodingPlanSchema.parse(plan)).filter(
				(i) => i.level === "error",
			),
		).toEqual([]);
		const ops = compilePlan(plan);
		const iframes = ops.filter(
			(op) => op.kind === "CREATE_HLS_IFRAME_PLAYLIST",
		);
		const names = iframes.map(
			(op) => (op.payload as { filename: string }).filename,
		);
		expect(names.filter((name) => name.includes("540p"))).toEqual(
			Array.from(
				{ length: copies },
				(_, n) => `video_h264_540p_600000_iframe${n === 0 ? "" : `_${n}`}.m3u8`,
			),
		);
		// Two audio groups fan out ordinary variants, not I-frame writers.
		expect(iframes).toHaveLength(copies + 1);
		for (const op of iframes) {
			expect(op.refs.streamInfoId).toBe(
				`${op.step.replace("hls-iframe:", "hls-variant:")}:a128`,
			);
		}
		expect(hlsStaticChildUris(plan, manifest)).toEqual([
			...hlsChildFiles(plan, manifest),
			...names,
		]);
	});

	it("reserves ordinary video and explicit audio names before allocating I-frame suffixes", () => {
		const { plan, manifest } = iframePlan(2);
		const audios = plan.renditions.filter((r) => r.codec === "AAC");
		for (const [index, r] of audios.entries()) {
			r.hlsMedia = {
				groupId: "iframe",
				name: r.key,
				uri: `video_h264_540p_600000_iframe_${index + 2}.m3u8`,
			};
		}
		expect(
			validatePlan(encodingPlanSchema.parse(plan)).filter(
				(i) => i.level === "error",
			),
		).toEqual([]);
		const ordinary = hlsChildFiles(plan, manifest);
		const names = compilePlan(plan)
			.filter((op) => op.kind === "CREATE_HLS_IFRAME_PLAYLIST")
			.map((op) => (op.payload as { filename: string }).filename);
		expect(names.filter((name) => name.includes("540p"))).toEqual([
			"video_h264_540p_600000_iframe_4.m3u8",
			"video_h264_540p_600000_iframe_5.m3u8",
		]);
		for (const name of names) expect(ordinary).not.toContain(name);
		expect(new Set([...ordinary, ...names]).size).toBe(
			ordinary.length + names.length,
		);
		expect(hlsStaticChildUris(plan, manifest)).toEqual([...ordinary, ...names]);
	});

	it("get distinct child uris in the defaults, the compiler and the validator alike", () => {
		const plan = fixture();
		const v540 = plan.renditions.find((r) => r.key === "v540");
		const m540 = plan.muxings.find((m) => m.key === "v540");
		const hls = plan.manifests.find((m) => m.kind === "HLS");
		if (!v540 || !m540?.destination || !hls) {
			throw new Error("fixture shape changed");
		}
		const destination = m540.destination;
		plan.renditions.push({ ...v540, key: "v540b" });
		plan.muxings.push({
			...m540,
			key: "v540b",
			streamKey: "v540b",
			destination: { ...destination, path: `${destination.path}b` },
		});
		const files = hlsChildFiles(plan, hls);
		expect(files).toContain("video_600000.m3u8");
		expect(files).toContain("video_600000_1.m3u8");
		const emitted = compilePlan(plan)
			.filter((op) => op.kind === "CREATE_HLS_STREAM_INFO")
			.map((op) => (op.payload as { uri?: unknown }).uri);
		expect(emitted).toEqual(
			expect.arrayContaining(["video_600000.m3u8", "video_600000_1.m3u8"]),
		);
		expect(new Set(emitted).size).toBe(emitted.length);
		expect(validatePlan(plan).map((i) => i.code)).not.toContain(
			"PLAN_HLS_MEDIA_URI_COLLISION",
		);
	});

	it("keeps one rendition's duplicate legs duplicated so the multi-leg rail still sees them", () => {
		const plan = fixture();
		const m540 = plan.muxings.find((m) => m.key === "v540");
		const hls = plan.manifests.find((m) => m.kind === "HLS");
		if (!m540?.destination || !hls) throw new Error("fixture shape changed");
		const destination = m540.destination;
		plan.muxings.push({
			...m540,
			key: "v540-ts",
			kind: "TS",
			segmentNaming: "seg_%number%.ts",
			destination: { ...destination, path: `${destination.path}-ts` },
		} as (typeof plan.muxings)[number]);
		expect(
			hlsChildFiles(plan, hls).filter((u) => u.startsWith("video_600000")),
		).toEqual(["video_600000.m3u8"]);
		expect(validatePlan(plan).map((i) => i.code)).toContain(
			"PLAN_HLS_RENDITION_MULTI_LEG",
		);
	});
});
