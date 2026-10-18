import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";

const dir = join(__dirname, "__fixtures__");

const FIXTURES = [
	"fixed-bitrate-hls-on-aws",
	"fixed-bitrate-dash-hls-streamcondition-on-aws",
	"dash-hls-sftp-output-just-in-time",
	"dash-hls-sftp-output-post-encoding",
	"mp4-fixed-bitrate-hls-on-aws",
	"mp4-fixed-bitrate-hls-on-azure",
	"fixed-bitrate-hls-on-azure",
	"fixed-bitrate-hls-streamcondition-on-aws",
	"fixed-bitrate-hls-streamcondition-on-azure",
	"fixed-bitrate-dash-hls-streamcondition-on-azure",
	"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws",
	"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-azure",
	"fixed-bitrate-hls-vtt-on-aws",
	"fixed-bitrate-hls-vtt-on-azure",
	"mp4-fixed-bitrate-hls-vtt-on-aws",
	"mp4-fixed-bitrate-hls-vtt-on-azure",
	"audio-only-aac-fmp4-hls-dash",
	// P2-PR2 — keyframes, TEMPLATE-vs-TIMELINE, filters
	"keyframes-segment-aligned",
	"keyframes-segment-non-aligned",
	"dash-template-and-timeline-on-aws",
	"deinterlace-filter",
	// P2-PR3 — per-title family + hdr10
	"pertitle-h264-fmp4-ts-dash-hls-on-aws",
	"pertitle-h265-fmp4-dash-hls-on-aws",
	"pertitle-vp9-webm-fmp4-dash-on-aws",
	"pertitle-h264-openapi",
	"pertitle-h264-separate-av-inputs",
	"hdr10-pertitle",
	// P2-PR4 — DRM family + forensic watermark
	"cenc-cbc-drm-on-aws",
	"pertitle-h264-fmp4-ts-drm-on-aws",
	"pertitle-h265-fmp4-drm-on-aws",
	"pertitle-vp9-webm-cenc-drm-on-aws",
	"pertitle-h264-mp4-smooth-drm-on-aws",
	"nexguard-watermarking",
	// P2-PR5 — dolby family (multi-encoding ladders, atmos, DV)
	"dolby-audio-only-atmos-damf",
	"dolby-audio-only-atmos-adm",
	"dolby-atmos-progressive-mp4",
	"dolby-dv-ddp-multi-audio",
	"dolby-dv-embedded-ddp",
	"dolby-dv-hdr10-sdr-2ladder-profile81",
	"dolby-dv-hdr10-sdr-3ladder-profile5-single-input",
	"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs",
	"dolby-dv-atmos-damf",
	"dolby-dv-atmos-damf-aac",
	"dolby-dv-atmos-adm",
	"dolby-dv-atmos-damf-https",
	"dolby-dv-atmos-adm-https",
	"dolby-dv-separated-metadata-adm",
	"ai-scene-analysis-passthrough",
	"ai-scene-analysis-pertitle",
	"ai-scene-analysis-passthrough-test",
	"ai-scene-analysis-pertitle-test",
	"ai-scene-analysis-batch-item",
	"dolby-dv-hdr10-sdr-2ladder-profile81-test",
	"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs-test",
	"dolby-dv-hdr10-sdr-3ladder-profile5-single-input-test",
	"dolby-dv-3ladder-profile5-dash-ondemand",
	// GenericS3 / GCS I/O: the template exporter models these input/output kinds
	// (the wizard preview emits them eagerly), so pin the YAML — secrets must
	// render as {{INPUT_*}}/{{OUTPUT_*}} placeholders, cloudRegion only for GCS.
	"generic-s3-akamai-io",
	"gcs-service-account-io",
	// Trick-play sprites: streams.<key>.sprites is template-representable, so
	// pin the YAML — the sprite grid/dimension/filename fields must emit and
	// secrets must render as {{OUTPUT_*}} placeholders.
	"sprites-trickplay",
	// AV1 codec configs (configurations.video.av1) are template-representable —
	// pin the YAML so the av1 config + preset/autoLevelSetup emit and secrets
	// render as {{INPUT_*}}/{{OUTPUT_*}} placeholders.
	"av1-fmp4-dash-hls",
	"pertitle-av1-fmp4-dash-on-aws",
	// Encoding labels/infrastructure + start tweaks/VFR + preview lists are
	// all template-schema keys — pin the emission.
	"labels-infrastructure-preview",
	// kantarWatermark is a template-schema node under the encoding — pin the
	// emission (login/password render as {{KANTAR_*}} placeholders).
	"kantar-audio-watermark",
];

describe("planToEncodingTemplateYaml", () => {
	for (const name of FIXTURES) {
		it(`matches the golden template for ${name}`, () => {
			const yaml = planToEncodingTemplateYaml(loadPlan(name));
			const goldenPath = join(dir, `${name}.template.yaml`);
			if (process.env.UPDATE_GOLDEN) {
				if (process.env.CI) {
					throw new Error("Refusing to regenerate goldens in CI");
				}
				writeFileSync(goldenPath, yaml);
			}
			expect(existsSync(goldenPath)).toBe(true);
			expect(yaml).toBe(readFileSync(goldenPath, "utf8"));
		});
	}

	/** Walks a parsed YAML tree by dot path; throws on missing segments. */
	function at(tree: unknown, path: string): unknown {
		let node: unknown = tree;
		for (const segment of path.split(".")) {
			if (node === null || typeof node !== "object") {
				throw new Error(`missing path segment "${segment}" in ${path}`);
			}
			node = (node as Record<string, unknown>)[segment];
		}
		return node;
	}

	it("exports a MULTI-ENCODING Kantar plan: one node, only on audio-carrying encodings", () => {
		// Two independent bugs lived here: the singleton placeholders were
		// minted inside the per-encoding loop (second encoding → collision
		// THROW, reachable from the wizard preview, which builds the template
		// during render), and the node was emitted for every encoding while the
		// compiler emitted the op only where audio exists. A multi-encoding
		// Kantar plan was the one shape no test covered.
		const plan = loadPlan("dolby-dv-hdr10-sdr-3ladder-profile5-single-input");
		plan.kantar = {
			credentialId: "00000000-0000-4000-8000-0000000000b1",
			licenseId: 4711,
			channelName: "Demo",
			contentReference: "ep01",
			serverUrl: "https://kantar.example.com/watermark",
			reportDestination: {
				outputKey: plan.outputs[0]?.key ?? "origin",
				path: "reports",
			},
		};
		const AUDIO = ["AAC", "DOLBY_ATMOS", "DDPLUS", "DD"];
		const withAudio = new Set(
			plan.renditions
				.filter((r) => AUDIO.includes(r.codec))
				.map((r) => r.encodingKey ?? ""),
		);
		const allEncodings = (plan.encodings ?? []).map((e) => e.key);
		// The fixture must exercise the split or this proves nothing.
		expect(withAudio.size).toBeGreaterThan(0);
		expect(allEncodings.length).toBeGreaterThan(withAudio.size);

		// Must not throw (the placeholder collision did).
		const tree = parse(planToEncodingTemplateYaml(plan)) as unknown;
		for (const key of allEncodings) {
			const node = at(tree, `encodings.${key}`) as Record<string, unknown>;
			if (withAudio.has(key)) {
				expect(
					at(tree, `encodings.${key}.kantarWatermark.kantar.properties.login`),
					`${key} carries audio ⇒ Kantar node present`,
				).toBe("{{KANTAR_LOGIN}}");
			} else {
				expect(
					"kantarWatermark" in node,
					`${key} has no audio ⇒ no Kantar node (the compiler emits no op either)`,
				).toBe(false);
			}
		}
	});

	it("emits parseable YAML with $/ references and no secrets", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		const yaml = planToEncodingTemplateYaml(plan);
		const tree = parse(yaml) as unknown;

		expect(at(tree, "metadata")).toEqual({
			type: "VOD",
			name: "h264-aac-fmp4-fixed-bitrate-hls-aws",
		});
		expect(
			at(tree, "encodings.main.streams.v360.properties.codecConfigId"),
		).toBe("$/configurations/video/h264/v360");
		expect(
			at(tree, "encodings.main.streams.v360.properties.inputStreams.0.inputId"),
		).toBe("$/inputs/s3/main");
		expect(
			at(
				tree,
				"encodings.main.muxings.fmp4.v360.properties.streams.0.streamId",
			),
		).toBe("$/encodings/main/streams/v360");
		expect(at(tree, "encodings.main.start.properties.vodHlsManifests")).toEqual(
			[{ manifestId: "$/manifests/hls/hls" }],
		);

		// Vault material is placeholders only, section-prefixed because key
		// uniqueness is per-collection.
		expect(at(tree, "inputs.s3.main.properties.accessKey")).toBe(
			"{{INPUT_MAIN_ACCESS_KEY}}",
		);
		expect(yaml).not.toContain("credentialId");
	});

	it("emits SDK wire values where templates diverge from enum names", () => {
		const yaml = planToEncodingTemplateYaml(
			loadPlan("fixed-bitrate-dash-hls-streamcondition-on-aws"),
		);
		const tree = parse(yaml) as unknown;
		expect(
			at(tree, "configurations.audio.aac.a128.properties.channelLayout"),
		).toBe("STEREO");
		expect(
			at(tree, "manifests.hls.hls.properties.hlsMasterPlaylistVersion"),
		).toBe("4");
		expect(
			at(tree, "encodings.main.streams.a128.properties.conditions"),
		).toEqual({
			type: "CONDITION",
			attribute: "AUDIOSTREAMCOUNT",
			operator: ">",
			value: "0",
		});
		expect(yaml).not.toContain("CL_STEREO");
		expect(yaml).not.toContain("HLS_V4");
	});

	it("emits required empty properties on DASH period and video set", () => {
		const tree = parse(
			planToEncodingTemplateYaml(loadPlan("dash-hls-sftp-output-just-in-time")),
		) as unknown;
		expect(at(tree, "manifests.dash.dash.periods.period.properties")).toEqual(
			{},
		);
		expect(
			at(
				tree,
				"manifests.dash.dash.periods.period.adaptationsets.video.video_set.properties",
			),
		).toEqual({});
		expect(
			at(tree, "encodings.main.start.properties.vodDashManifests"),
		).toEqual([{ manifestId: "$/manifests/dash/dash" }]);
	});

	it("emits REST casing for the schema-blind key classes", () => {
		// additionalProperties is absent from the official schema, so the
		// ajv gate cannot catch misnamed keys — pin the known dangerous ones.
		const h265 = readFileSync(
			join(dir, "pertitle-h265-fmp4-dash-hls-on-aws.template.yaml"),
			"utf8",
		);
		expect(h265).toContain("maxCTUSize:");
		expect(h265).not.toContain("maxCtuSize:");
		const mp4 = readFileSync(
			join(dir, "mp4-fixed-bitrate-hls-on-aws.template.yaml"),
			"utf8",
		);
		expect(mp4).toContain("fragmentedMP4MuxingManifestType:");
		expect(mp4).not.toContain("fragmentedMp4MuxingManifestType:");
	});

	it("emits the dolby field classes the ajv gate cannot see", () => {
		// Omitted or miscased keys are invisible to ajv (no
		// additionalProperties) — pin presence + wire forms on the ladder
		// and sidecar goldens.
		const ladder = readFileSync(
			join(dir, "dolby-dv-hdr10-sdr-2ladder-profile81.template.yaml"),
			"utf8",
		);
		expect(ladder).toContain("dynamicRangeFormat: DOLBY_VISION_PROFILE_8_1");
		expect(ladder).toContain("dynamicRangeFormat: SDR");
		expect(ladder).toContain("maxBitrate:");
		expect(ladder).toContain("bufsize:");
		expect(ladder).toContain("meteringMode: ITU-R BS.1770-4");
		expect(ladder).not.toContain("ITU_R_BS_1770_4");
		expect(ladder).toContain("isDefault: false");
		expect(ladder).toContain("autoselect: true");
		expect(ladder).toContain("inputFormat: DAMF");
		expect(ladder).toContain("videoInputPath:");
		expect(ladder).toContain("metadataInputPath:");
		const sidecar = readFileSync(
			join(dir, "dolby-dv-separated-metadata-adm.template.yaml"),
			"utf8",
		);
		expect(sidecar).toContain("metadataSource: INPUT_STREAM");
		expect(sidecar).toContain("metadataInputStreamId:");
		expect(sidecar).toContain("dolbyVisionMetadataIngest:");
		// Progressive MP4 = no fragment fields (distinct artifact from
		// byte-range/Smooth fMP4 — the sample passes neither).
		const progressive = readFileSync(
			join(dir, "dolby-atmos-progressive-mp4.template.yaml"),
			"utf8",
		);
		expect(progressive).not.toContain("fragmentedMP4MuxingManifestType:");
		expect(progressive).not.toContain("fragmentDuration:");
	});

	it("emits the AISA/OnDemand field classes the ajv gate cannot see", () => {
		const aisa = readFileSync(
			join(dir, "ai-scene-analysis-pertitle.template.yaml"),
			"utf8",
		);
		expect(aisa).toContain("aiSceneAnalysis:");
		expect(aisa).toContain("features:");
		expect(aisa).toContain("assetDescription:");
		expect(aisa).toContain("automaticAdPlacement:");
		expect(aisa).toContain("allSceneBoundaries:");
		expect(aisa).toContain("isEnabled: true");
		expect(aisa).toContain("insertCueTags: true");
		// AiSceneAnalysisOutputLanguageCodes nests the array under its own key.
		expect(aisa).toContain("outputLanguageCodes:\n");
		expect(aisa).toContain("refFrames: 4");
		expect(aisa).toContain("bframes: 3");
		expect(aisa).toContain("cabac: true");
		expect(aisa).toContain("adaptiveSpatialTransform: true");
		expect(aisa).toContain("weightedPredictionPFrames: SMART");
		const onDemand = readFileSync(
			join(dir, "dolby-dv-3ladder-profile5-dash-ondemand.template.yaml"),
			"utf8",
		);
		expect(onDemand).toContain("profile: ON_DEMAND");
		expect(onDemand).toContain("levelHighTier: false");
		expect(onDemand).toContain("dolbyVisionConfiguration:");
		expect(onDemand).toContain("trackSampleEntryName: DVH1");
		expect(onDemand).toContain(
			"fragmentedMP4MuxingManifestType: DASH_ON_DEMAND",
		);
		expect(onDemand).toContain("type: SEGMENT_BASE");
		expect(onDemand).toContain("filePath: video/dv/2160p_15000000/video.mp4");
		// SegmentBase entries are mp4-section representations, not fmp4.
		expect(onDemand).toContain("mp4:");
		expect(onDemand).not.toContain("segmentPath:");
	});

	it("keeps header comments single-line for hostile plan names", () => {
		const base = loadPlan("fixed-bitrate-hls-on-aws");
		const evil = encodingPlanSchema.parse({
			...base,
			name: "evil\nmetadata: {}",
		});
		const yaml = planToEncodingTemplateYaml(evil);
		const lines = yaml.split("\n");
		const firstDoc = lines.findIndex((line) => !line.startsWith("#"));
		expect(lines[firstDoc]).toBe("metadata:");
		// The document itself round-trips the raw name safely.
		expect(at(parse(yaml) as unknown, "metadata.name")).toBe(
			"evil\nmetadata: {}",
		);
	});

	/**
	 * The MSL5 Digest placeholders — , review S6.
	 *
	 * A template that omits `publishingAuthentication` is not REPRODUCIBLE: the
	 * importer gets a channel that publishes unauthenticated, silently. That is
	 * the same state rail 3b warns about, reached by omission rather than by an
	 * empty vault, and a template is exactly where nobody is watching.
	 *
	 * The negative arm is the load-bearing one. Bitmovin REJECTS the field on
	 * MSL4 — the vendor's own test asserts the message — so emitting a
	 * placeholder an importer would dutifully fill is how you hand someone a
	 * 400. A single positive arm would pass with the version condition removed.
	 */
	const mslOutput = (mslVersion: "MSL4" | "MSL5") => {
		const base = loadPlan("akamai-netstorage-io");
		return encodingPlanSchema.parse({
			...base,
			outputs: [
				{
					key: "origin",
					kind: "AKAMAI_MSL",
					credentialId: "00000000-0000-4000-8000-000000000003",
					streamFormat: "HLS",
					mslVersion,
					name: "MSL",
				},
			],
		});
	};

	it("emits Digest placeholders for an MSL5 output — never the pair itself", () => {
		const tree = parse(
			planToEncodingTemplateYaml(mslOutput("MSL5")),
		) as unknown;
		const auth = at(
			tree,
			"outputs.akamaiMsl.origin.properties.publishingAuthentication",
		);
		expect(auth).toEqual({
			enabled: true,
			username: "{{OUTPUT_ORIGIN_MSL_PUBLISHING_USERNAME}}",
			password: "{{OUTPUT_ORIGIN_MSL_PUBLISHING_PASSWORD}}",
		});
		// The pair is not in the plan at all (it lives in the credential), so
		// there is nothing to leak — asserted anyway, because "cannot happen"
		// is the claim a canary is for.
		expect(planToEncodingTemplateYaml(mslOutput("MSL5"))).not.toMatch(
			/S3gm3nt|pub-user/,
		);
	});

	it("emits NOTHING for MSL4, which Bitmovin refuses the field on", () => {
		const tree = parse(
			planToEncodingTemplateYaml(mslOutput("MSL4")),
		) as unknown;
		expect(
			at(tree, "outputs.akamaiMsl.origin.properties.publishingAuthentication"),
		).toBeUndefined();
		// And the identity placeholders still ride, so this is not passing
		// because the whole block vanished.
		expect(at(tree, "outputs.akamaiMsl.origin.properties.streamId")).toBe(
			"{{OUTPUT_ORIGIN_MSL_STREAM_ID}}",
		);
	});

	it("post-encoding plans start without manifest refs and carry the note", () => {
		const yaml = planToEncodingTemplateYaml(
			loadPlan("dash-hls-sftp-output-post-encoding"),
		);
		expect(yaml).toContain("POST_ENCODING manifest generation");
		const tree = parse(yaml) as unknown;
		expect(at(tree, "encodings.main.start.properties")).toEqual({});
		expect(at(tree, "outputs.sftp.origin.properties.password")).toBe(
			"{{OUTPUT_ORIGIN_SFTP_PASSWORD}}",
		);
		expect(
			at(
				tree,
				"manifests.dash.dash.periods.period.adaptationsets.audio.audio_set.properties.lang",
			),
		).toBe("ja");
	});
});
