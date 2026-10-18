import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VMAF_MODEL, encodingPlanSchema } from "@bitovp/core";
import { SAMPLE_PRESETS, samplePresetPlan } from "@bitovp/core/presets";
import { describe, expect, it } from "vitest";
import { buildPlan, type WizardState } from "./build-plan";
import { collectPlaceholders } from "./plan-import";
import { evaluateWizardState } from "./plan-preview";
import {
	clearSamplePlaceholders,
	describeFormGap,
	plansDeepEqual,
	planToWizardState,
	tryImportPresetIntoWizard,
} from "./plan-to-wizard";
import { parsePositions } from "./thumbnails-section";

function presetPlan(name: string): Record<string, unknown> {
	const plan = samplePresetPlan(name);
	if (!plan) {
		throw new Error(`missing preset fixture: ${name}`);
	}
	return plan;
}

const coreFixturesDir = join(
	__dirname,
	"../../../../../../packages/core/src/plan/__fixtures__",
);

describe("mixed-codec ladder round-trip (audit 893eb66 HIGH-9)", () => {
	it("mixed-codec-dash-hls rebuilds through the wizard exactly", () => {
		const raw = JSON.parse(
			readFileSync(
				join(coreFixturesDir, "mixed-codec-dash-hls.plan.json"),
				"utf8",
			),
		) as Record<string, unknown>;
		const state = planToWizardState(raw);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		const original = encodingPlanSchema.parse(raw);
		expect(rebuilt).toEqual(original);
		expect(plansDeepEqual(rebuilt, original)).toBe(true);
	});
});

describe("fixed WebM ladder round-trip (audit 893eb66 CRITICAL-2)", () => {
	it("vp9-webm-fixed-dash rebuilds through the wizard exactly", () => {
		/*
		 * The fixture is synthetic (no encoding examples), so the 56-preset loop
		 * above never sees it. It gets its own round-trip because the claim it
		 * backs is a UI one: "reproducible via the wizard" is the acceptance
		 * bar, and a WebM leg selected for DASH was exactly the thing the
		 * wizard could express and the compiler then dropped.
		 */
		const raw = JSON.parse(
			readFileSync(
				join(coreFixturesDir, "vp9-webm-fixed-dash.plan.json"),
				"utf8",
			),
		) as Record<string, unknown>;
		const state = planToWizardState(raw);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		const original = encodingPlanSchema.parse(raw);
		expect(rebuilt).toEqual(original);
		expect(plansDeepEqual(rebuilt, original)).toBe(true);
	});
});

/**
 * The importer and the builder read ONE derivation of the default HLS playlist
 * version  — widened to AUDIO legs by the 2026-08-29 paid
 * re-audit's HIGH-4. The two halves have to move together or a plan silently
 * changes version on a round trip: the importer drops "the default", so if it
 * computes a different default than the builder emits, an explicit value is
 * dropped and re-emitted as something else.
 *
 * The two halves of the widening are NOT equally covered, measured by reverting
 * each: pass `audios: []` to the importer's derivation and the whole 56-preset
 * round-trip stays green (the three audio-only fixtures spell V6, V8, V8, and
 * each round-trips under either derivation — the discriminating spelling, V4
 * where the new default is V6, appears in none of them), so the audio
 * POPULATION is pinned only by the arms below. Drop the `audioMuxingKind` pin
 * and `pertitle-h264-separate-av-inputs` falls out of the corpus loop — it pins
 * both kinds to TS while every rendition also has an fMP4 leg, so an importer
 * that ignores the audio pin sees an fMP4 leg the manifest never lists.
 */
describe("HLS default version lockstep — audio legs (2026-08-29 re-audit HIGH-4)", () => {
	/**
	 * The fixture with its HLS manifest FIRST. `readManifests` only treats an
	 * HLS manifest as the primary one when it leads the list (`isCanonical` +
	 * the `mans[0].kind === "HLS"` test) — the fixture ships DASH first and so
	 * rides the extra-manifest path, where versions are carried verbatim and no
	 * default is consulted at all. The wizard's OWN output for an audio-only
	 * plan is this order, which is where the defaulted version actually lands.
	 */
	const audioOnly = () => {
		const raw = JSON.parse(
			readFileSync(
				join(coreFixturesDir, "audio-only-aac-fmp4-hls-dash.plan.json"),
				"utf8",
			),
		) as Record<string, unknown>;
		const manifests = raw.manifests as Record<string, unknown>[];
		raw.manifests = [...manifests].sort((a, b) =>
			a.kind === "HLS" ? -1 : b.kind === "HLS" ? 1 : 0,
		);
		return raw;
	};
	const hlsOf = (raw: Record<string, unknown>) => {
		const hls = (raw.manifests as Record<string, unknown>[]).find(
			(m) => m.kind === "HLS",
		);
		if (!hls) {
			throw new Error("fixture drift: no HLS manifest");
		}
		return hls;
	};

	it("V6 IS this plan's default: the importer drops it and the builder re-emits it", () => {
		// Zero video legs, one fMP4 audio muxing. The old video-only derivation
		// could not reach V6 at all here, so the importer kept the fixture's V6
		// as an explicit override — this assertion is what says the derivation
		// now SEES the audio leg.
		const raw = audioOnly();
		expect(hlsOf(raw).masterVersion, "fixture drift").toBe("HLS_V6");
		const state = planToWizardState(raw);
		// Non-vacuous: `hls: true` says the PRIMARY path was taken (the extra
		// path sets it false and consults no default), and the whole options
		// bag is then absent because every value in it — versions included —
		// is now the derived default. A stale importer leaves V6 in it.
		expect(state.manifests.hls).toBe(true);
		expect(state.manifests.hlsOptions).toBeUndefined();
		expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(
			encodingPlanSchema.parse(raw),
		);
	});

	it("an EXPLICIT V4 survives — the importer must not mistake it for the default", () => {
		// The other direction, and the one a stale importer breaks: under the
		// video-only derivation V4 IS this plan's default, so the importer drops
		// it and the builder re-emits the (now V6) default — the manifest
		// changes version on an unrelated edit, with nothing reporting it.
		const raw = audioOnly();
		const hls = hlsOf(raw);
		hls.masterVersion = "HLS_V4";
		hls.mediaVersion = "HLS_V4";
		const state = planToWizardState(raw);
		expect(state.manifests.hlsOptions?.masterVersion).toBe("HLS_V4");
		expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(
			encodingPlanSchema.parse(raw),
		);
	});

	it("the audioMuxingKind pin is carried into the derivation", () => {
		// A TS-pinned manifest lists the TS leg only, so V4 is its default even
		// though the plan also has an fMP4 audio muxing. An importer that reads
		// the video pin and ignores the audio one derives V6 and keeps the V4
		// as explicit — same class of drift, one field over.
		const raw = audioOnly();
		const muxings = raw.muxings as Record<string, unknown>[];
		const fmp4 = muxings[0];
		if (fmp4?.kind !== "FMP4") {
			throw new Error("fixture drift: muxings[0] is not FMP4");
		}
		muxings.push({
			key: "a128-ts",
			kind: "TS",
			streamKey: fmp4.streamKey,
			segmentLength: fmp4.segmentLength,
			segmentNaming: "segment_%number%.ts",
			destination: fmp4.destination,
		});
		const hls = hlsOf(raw);
		hls.audioMuxingKind = "TS";
		hls.masterVersion = "HLS_V4";
		hls.mediaVersion = "HLS_V4";
		const state = planToWizardState(raw);
		expect(state.manifests.hlsOptions?.audioMuxingKind).toBe("TS");
		expect(state.manifests.hlsOptions?.masterVersion).toBeUndefined();
		expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(
			encodingPlanSchema.parse(raw),
		);
	});
});

describe("plan-to-wizard coverage", () => {
	it("maps EVERY sample preset into the form (zero fall-back)", () => {
		// Waves 1-4 complete: every encoding examples scenario opens in the wizard.
		const fellBack = SAMPLE_PRESETS.filter(
			(preset) => !tryImportPresetIntoWizard(presetPlan(preset.name)).ok,
		).map((preset) => preset.name);
		expect(fellBack).toEqual([]);
		expect(SAMPLE_PRESETS.length).toBe(56);
	});

	it("every preset rebuilds the fixture byte-for-byte", () => {
		let rebuiltCount = 0;
		for (const preset of SAMPLE_PRESETS) {
			const raw = presetPlan(preset.name);
			if (!tryImportPresetIntoWizard(raw).ok) {
				continue;
			}
			rebuiltCount += 1;
			// The mapped state (before placeholder clearing) must reproduce the
			// fixture exactly. Cross-checked with vitest toEqual (independent of
			// plansDeepEqual) so an over-accepting gate bug can't hide here.
			const state = planToWizardState(raw);
			const rebuilt = encodingPlanSchema.parse(buildPlan(state));
			const original = encodingPlanSchema.parse(raw);
			expect(rebuilt, `${preset.name} did not round-trip`).toEqual(original);
			expect(plansDeepEqual(rebuilt, original)).toBe(true);
		}
		// Non-vacuous: all 56 map and round-trip.
		expect(rebuiltCount).toBe(SAMPLE_PRESETS.length);
	});

	it("opens the advanced families in the form (the Per-Title report)", () => {
		// The user's case: a Per-Title preset must no longer say "doesn't cover".
		for (const name of [
			"hdr10-pertitle", // Per-Title + HDR10
			"pertitle-h265-fmp4-dash-hls-on-aws", // Per-Title H265
			"cenc-cbc-drm-on-aws", // DRM
			"dolby-dv-hdr10-sdr-2ladder-profile81", // Dolby + multi-encoding
			"nexguard-watermarking", // forensic watermark
			"keyframes-segment-aligned", // ad-cue keyframes
			"ai-scene-analysis-passthrough", // AI Scene Analysis
		]) {
			expect(
				tryImportPresetIntoWizard(presetPlan(name)).ok,
				`${name} should open in the wizard form`,
			).toBe(true);
		}
	});

	it("maps placeholder-bearing presets into the form (not the fallback)", () => {
		// Dolby fixtures carry <INSERT…> sample paths; they now prefill the form
		// (Start is gated on them by the wizard) instead of falling back.
		const result = tryImportPresetIntoWizard(
			presetPlan("dolby-dv-separated-metadata-adm"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		// The sample-path tokens must survive into the form state (NOT silently
		// dropped) — they are what the wizard's Start-gate keys on.
		expect(
			collectPlaceholders(
				buildPlan(result.state) as unknown as Record<string, unknown>,
			).length,
		).toBeGreaterThan(0);
	});
});

describe("labels / infrastructure / start tweaks / preview placement round-trip", () => {
	// The P5 PR-2 fields bolted onto a known-mappable JIT preset (both primary
	// manifests) — the same shape as the infra-ops golden: labels +
	// infrastructure + tweaks/VFR + HLS VOD_AND_PREVIEW + DASH PREVIEW.
	const infraPlan = (): Record<string, unknown> => {
		const base = presetPlan("dash-hls-sftp-output-just-in-time");
		const bitmovin = base.bitmovin as Record<string, unknown>;
		const generation = base.generation as Record<string, unknown>;
		const manifests = base.manifests as Record<string, unknown>[];
		return {
			...base,
			bitmovin: {
				...bitmovin,
				labels: ["campaign-a", "uhd"],
				prewarmedEncoderPoolIds: ["00000000-0000-4000-8000-0000000000e2"],
				infrastructure: {
					infrastructureId: "00000000-0000-4000-8000-0000000000aa",
					cloudRegion: "EU_WEST_1",
				},
			},
			generation: {
				...generation,
				audioVideoSyncMode: "RESYNC_AT_START_AND_END",
				handleVariableInputFps: true,
			},
			manifests: manifests.map((m) =>
				m.kind === "HLS"
					? { ...m, jitPlacement: "VOD_AND_PREVIEW" }
					: { ...m, jitPlacement: "PREVIEW" },
			),
		};
	};

	it("reads every new field back into wizard state (plan → state)", () => {
		const state = planToWizardState(infraPlan());
		expect(state.labels).toEqual(["campaign-a", "uhd"]);
		expect(state.infrastructure).toEqual({
			infrastructureId: "00000000-0000-4000-8000-0000000000aa",
			cloudRegion: "EU_WEST_1",
		});
		expect(state.startOptions?.audioVideoSyncMode).toBe(
			"RESYNC_AT_START_AND_END",
		);
		expect(state.startOptions?.handleVariableInputFps).toBe(true);
		// The canonical primary pair stays primary (not demoted to extras) with
		// the placement riding the option bags.
		expect(state.manifests.hls).toBe(true);
		expect(state.manifests.dash).toBe(true);
		expect(state.manifests.hlsOptions?.jitPlacement).toBe("VOD_AND_PREVIEW");
		expect(state.manifests.dashOptions?.jitPlacement).toBe("PREVIEW");
	});

	it("rebuilds the plan byte-for-byte (plan → state → plan)", () => {
		const raw = infraPlan();
		const original = encodingPlanSchema.parse(raw);
		const rebuilt = encodingPlanSchema.parse(buildPlan(planToWizardState(raw)));
		expect(rebuilt).toEqual(original);
		expect(plansDeepEqual(rebuilt, original)).toBe(true);
		// …and the wizard's actual import gate accepts it (no fallback).
		expect(tryImportPresetIntoWizard(raw).ok).toBe(true);
	});

	it("round-trips state → plan → state (fields land back where they started)", () => {
		const state = planToWizardState(infraPlan());
		const reread = planToWizardState(
			buildPlan(state) as unknown as Record<string, unknown>,
		);
		expect(reread.labels).toEqual(state.labels);
		expect(reread.infrastructure).toEqual(state.infrastructure);
		expect(reread.startOptions?.audioVideoSyncMode).toBe(
			state.startOptions?.audioVideoSyncMode,
		);
		expect(reread.startOptions?.handleVariableInputFps).toBe(
			state.startOptions?.handleVariableInputFps,
		);
		expect(reread.manifests.hlsOptions?.jitPlacement).toBe("VOD_AND_PREVIEW");
		expect(reread.manifests.dashOptions?.jitPlacement).toBe("PREVIEW");
	});

	it("NORMALISES an explicit jitPlacement:'VOD' to unset — and the round-trip gate reports the byte difference (ledger #118c)", () => {
		// The twin options were compiler-identical (ridesVod accepts undefined
		// and "VOD" alike), so the select no longer offers "VOD"; the mapper
		// normalises rather than seeding an off-list select value. The rebuilt
		// plan therefore DIFFERS from the verbatim raw — which is exactly what
		// sends such an import down the imported-plan path, bytes preserved.
		const base = presetPlan("dash-hls-sftp-output-just-in-time");
		const manifests = base.manifests as Record<string, unknown>[];
		const raw = {
			...base,
			manifests: manifests.map((m) =>
				m.kind === "HLS" ? { ...m, jitPlacement: "VOD" } : m,
			),
		};
		const state = planToWizardState(raw);
		expect(state.manifests.hlsOptions?.jitPlacement).toBeUndefined();
		expect(state.manifests.dashOptions?.jitPlacement).toBeUndefined();
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).not.toEqual(encodingPlanSchema.parse(raw));
	});

	it("leaves the new state fields undefined when the plan carries none", () => {
		const state = planToWizardState(
			presetPlan("dash-hls-sftp-output-just-in-time"),
		);
		expect(state.labels).toBeUndefined();
		expect(state.infrastructure).toBeUndefined();
		expect(state.startOptions).toBeUndefined();
		expect(state.manifests.hlsOptions?.jitPlacement).toBeUndefined();
		expect(state.manifests.dashOptions?.jitPlacement).toBeUndefined();
	});
});

describe("qc (VMAF) round-trip", () => {
	// A known-mappable preset with a qc block bolted on — proves the QC toggle
	// reads back into wizard state AND rebuilds the same plan.qc byte-for-byte.
	const qcPlan = (qc: Record<string, unknown>): Record<string, unknown> => ({
		...presetPlan("fixed-bitrate-hls-on-aws"),
		qc,
	});

	it("round-trips a fully-set qc block (vmaf + 4k model + psnr)", () => {
		const raw = qcPlan({ vmaf: true, model: "vmaf_4k_v0.6.1", psnr: true });
		const original = encodingPlanSchema.parse(raw);
		const state = planToWizardState(raw);
		// The toggle populates from the plan (only defaults to false when absent).
		expect(state.qc).toEqual({
			vmaf: true,
			model: "vmaf_4k_v0.6.1",
			psnr: true,
			only: false,
		});
		// …and buildPlan reproduces the exact qc block (byte-for-byte plan).
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(original);
		expect(rebuilt.qc).toEqual({
			vmaf: true,
			model: "vmaf_4k_v0.6.1",
			psnr: true,
		});
		// The wizard's actual import gate accepts it (not the fallback path).
		const result = tryImportPresetIntoWizard(raw);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.state.qc).toEqual({
				vmaf: true,
				model: "vmaf_4k_v0.6.1",
				psnr: true,
				only: false,
			});
		}
	});

	it("round-trips a default-model vmaf-only qc block", () => {
		// model omitted ⇒ schema default materializes ⇒ buildPlan prunes it back.
		const raw = qcPlan({ vmaf: true });
		const original = encodingPlanSchema.parse(raw);
		const state = planToWizardState(raw);
		expect(state.qc).toEqual({
			vmaf: true,
			model: DEFAULT_VMAF_MODEL,
			psnr: false,
			only: false,
		});
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(original);
		expect(rebuilt.qc).toEqual({ vmaf: true, model: DEFAULT_VMAF_MODEL });
	});

	it("leaves qc off (no state, no plan key) when the plan has none", () => {
		const state = planToWizardState(presetPlan("fixed-bitrate-hls-on-aws"));
		expect(state.qc).toBeUndefined();
		expect("qc" in buildPlan(state)).toBe(false);
	});

	it("reads qc.only back and rebuilds the same VMAF-only plan", () => {
		// The dedicated golden is a minimal qc.only plan (no manifests).
		const raw = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../packages/core/src/plan/__fixtures__/vmaf-only-h264.plan.json",
				),
				"utf8",
			),
		) as Record<string, unknown>;
		const state = planToWizardState(raw);
		expect(state.qc).toEqual({
			vmaf: true,
			model: DEFAULT_VMAF_MODEL,
			psnr: false,
			only: true,
		});
		// buildPlan reproduces the qc block (only:true) and keeps manifests empty.
		const rebuilt = buildPlan(state);
		expect(rebuilt.qc).toEqual({ vmaf: true, only: true });
		expect(rebuilt.manifests).toEqual([]);
		// Byte-identical round-trip through the schema.
		expect(encodingPlanSchema.parse(rebuilt)).toEqual(
			encodingPlanSchema.parse(raw),
		);
	});
});

describe("dual muxing legs / separate A-V inputs", () => {
	it("maps a rendition's extra muxing leg (fMP4 + TS from one stream)", () => {
		const result = tryImportPresetIntoWizard(
			presetPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const video = result.state.videos[0];
		expect(video?.extraMuxings ?? []).toHaveLength(1);
		expect(video?.extraMuxings?.[0]?.kind).toBe("TS");
		expect(video?.muxing?.kind ?? "FMP4").toBe("FMP4");
	});

	it("splits separate video/audio objects into input files", () => {
		const result = tryImportPresetIntoWizard(
			presetPlan("pertitle-h264-separate-av-inputs"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		// The primary input file is the video object; the implicit audio points
		// at a second input file (same bucket, different object).
		expect(result.state.inputFiles[0]?.path).toBe(
			"/path/to/your/input/video_only.mp4",
		);
		const audioFile = result.state.inputFiles.find(
			(f) => f.key === result.state.audioInputFile,
		);
		expect(audioFile?.path).toBe("/path/to/your/input/audio_only.wav");
	});

	it("gives an extra FMP4 leg a distinct key and evaluates DRM per leg", () => {
		// No fixture has an FMP4 extra leg or per-leg-asymmetric DRM; pin both:
		// the extra leg must keep its own key (not collapse onto the stream key),
		// and DRM ownership is decided per leg (only the encrypted leg omits its
		// destination).
		const base = planToWizardState(presetPlan("fixed-bitrate-hls-on-aws"));
		const [v0, ...restVideos] = base.videos;
		if (!v0) {
			throw new Error("fixture changed: no video rendition");
		}
		const realId = "11111111-2222-4333-8444-555555555555";
		const state: WizardState = {
			...base,
			videos: [
				{ ...v0, extraMuxings: [{ kind: "FMP4", key: "v360-alt", path: "x" }] },
				...restVideos,
			],
			drm: [
				{
					kind: "CENC",
					muxingKey: "v360",
					credentialId: realId,
					kid: "a".repeat(32),
				},
			],
		};
		const plan = encodingPlanSchema.parse(buildPlan(state)) as unknown as {
			muxings: Array<Record<string, unknown>>;
		};
		const primary = plan.muxings.find((m) => m.key === "v360");
		const extra = plan.muxings.find((m) => m.key === "v360-alt");
		expect(extra).toBeDefined(); // distinct key, not collapsed onto "v360"
		expect(extra?.streamKey).toBe("v360"); // same stream
		expect(primary?.destination).toBeUndefined(); // DRM leg owns its output
		expect(extra?.destination).toBeDefined(); // non-DRM leg keeps its own
	});
});

describe("storage (Azure / HTTPS)", () => {
	it("maps an Azure input+output preset (container, AZURE_BLOB creds cleared)", () => {
		const result = tryImportPresetIntoWizard(
			presetPlan("fixed-bitrate-hls-on-azure"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.state.inputFiles[0]?.kind).toBe("AZURE");
		expect(result.state.inputFiles[0]?.bucket).toBe("sample-input-container");
		expect(result.state.inputFiles[0]?.credentialId).toBe(""); // cleared
		expect(result.state.output.kind).toBe("AZURE");
		expect(result.state.output.bucket).toBe("sample-output-container");
		expect(result.state.output.credentialId).toBe("");
	});

	it("maps an HTTPS (credential-less) input + its S3 output", () => {
		const result = tryImportPresetIntoWizard(
			presetPlan("dolby-dv-atmos-adm-https"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.state.inputFiles[0]?.kind).toBe("HTTPS");
		expect(result.state.inputFiles[0]?.bucket).toBe(
			"apac-inputs.s3.ap-southeast-1.amazonaws.com",
		);
		// Mixed shape: HTTPS in / S3 out. The output keeps its kind and its
		// placeholder credential is cleared (the load-bearing clearing check —
		// asserting input.credentialId would be vacuous since HTTPS has none).
		expect(result.state.output.kind).toBe("S3");
		expect(result.state.output.credentialId).toBe("");
	});
});

describe("storage (GenericS3 / GCS encoding I/O, ledger #17)", () => {
	// A minimal H264+AAC plan parameterized by its input/output kind — the
	// wizard form models bucket+credential for every S3-family / GCS kind, so
	// each must read back AND rebuild byte-for-byte (no region — region-bearing
	// plans intentionally fall back, see planToWizardState gate notes).
	const planWith = (kind: string): Record<string, unknown> => ({
		planVersion: 1,
		name: "io test",
		bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1", encoderVersion: "STABLE" },
		inputs: [
			{
				key: "main",
				kind,
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "in-bucket",
				name: `${kind} Input`,
			},
		],
		outputs: [
			{
				key: "origin",
				kind,
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "out-bucket",
				name: `${kind} Output`,
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "video.mp4",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
			{
				key: "audio",
				inputKey: "main",
				inputPath: "video.mp4",
				selectionMode: "AUDIO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "v360",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 300000,
				level: null,
				presetConfiguration: "VOD_HIGH_QUALITY",
				mode: "STANDARD",
			},
			{
				key: "a128",
				codec: "AAC",
				ingestKey: "audio",
				bitrate: 128000,
				rate: 48000,
				channelLayout: "CL_STEREO",
			},
		],
		muxings: [
			{
				key: "v360",
				kind: "FMP4",
				streamKey: "v360",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: {
					outputKey: "origin",
					path: "output/io-test/video/360p",
					acl: "PUBLIC_READ",
				},
			},
			{
				key: "a128",
				kind: "FMP4",
				streamKey: "a128",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: {
					outputKey: "origin",
					path: "output/io-test/audio/128000",
					acl: "PUBLIC_READ",
				},
			},
		],
		manifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "stream.m3u8",
				name: "HLS Manifest",
				destination: {
					outputKey: "origin",
					path: "output/io-test/",
					acl: "PUBLIC_READ",
				},
				masterVersion: "HLS_V4",
				mediaVersion: "HLS_V4",
				audioGroupId: "audio",
				audioLanguage: "en",
				closedCaptions: "NONE",
			},
		],
		generation: { timing: "JUST_IN_TIME" },
	});

	for (const kind of ["GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT"] as const) {
		it(`round-trips a ${kind} input + output`, () => {
			const raw = planWith(kind);
			const original = encodingPlanSchema.parse(raw);
			const state = planToWizardState(raw);
			// The kind survives the readback for both the input file and output.
			expect(state.inputFiles[0]?.kind).toBe(kind);
			expect(state.inputFiles[0]?.bucket).toBe("in-bucket");
			expect(state.output.kind).toBe(kind);
			expect(state.output.bucket).toBe("out-bucket");
			// …and buildPlan rebuilds the exact plan byte-for-byte.
			const rebuilt = encodingPlanSchema.parse(buildPlan(state));
			expect(rebuilt, `${kind} did not round-trip`).toEqual(original);
			// The full wizard import gate accepts it (not the fallback path); the
			// sample credentials are cleared, the kind preserved.
			const imported = tryImportPresetIntoWizard(raw);
			expect(imported.ok).toBe(true);
			if (imported.ok) {
				expect(imported.state.output.kind).toBe(kind);
				expect(imported.state.output.credentialId).toBe("");
				expect(imported.state.inputFiles[0]?.credentialId).toBe("");
			}
		});
	}

	it("imports a region-bearing GCS plan into the form without losing its region", () => {
		// The optional region must survive the form import and rebuild gate.
		const raw = planWith("GCS");
		const firstInput = (raw.inputs as Array<Record<string, unknown>>)[0];
		if (!firstInput) {
			throw new Error("planWith should produce one input");
		}
		firstInput.region = "EUROPE_WEST_1";
		const result = tryImportPresetIntoWizard(raw);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.state.inputFiles[0]?.region).toBe("EUROPE_WEST_1");
	});
});

describe("thumbnails", () => {
	it("maps a per-stream thumbnail preset into state.thumbnails", () => {
		const result = tryImportPresetIntoWizard(
			presetPlan("fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const thumbs = result.state.thumbnails ?? [];
		expect(thumbs).toHaveLength(1);
		expect(thumbs[0]?.streamKey).toBe("v540");
		expect(thumbs[0]?.height).toBe(540);
		expect(thumbs[0]?.positions).toEqual([10]);
		expect(thumbs[0]?.path).toBe("thumbnail");
	});

	it("round-trips a non-default thumbnail (PERCENTS, pattern, multi-position, nested path)", () => {
		// The two fixtures are all-default; exercise the deviation branches that
		// no shipped fixture hits (nonDefault unit/pattern, multi-position, path).
		const base = planToWizardState(presetPlan("fixed-bitrate-hls-on-aws"));
		const thumb = {
			key: "t1",
			streamKey: "v540",
			height: 720,
			positions: [5, 25, 90],
			pattern: "thumb_%number%.png",
			unit: "PERCENTS" as const,
			path: "thumbs/720",
		};
		const state: WizardState = { ...base, thumbnails: [thumb] };
		const plan = encodingPlanSchema.parse(buildPlan(state));
		const readback = planToWizardState(
			plan as unknown as Record<string, unknown>,
		);
		expect(readback.thumbnails).toEqual([thumb]);
		// Full round-trip through the rebuilt state.
		expect(encodingPlanSchema.parse(buildPlan(readback))).toEqual(plan);
	});

	it("parsePositions drops blank/non-numeric tokens (no spurious 0)", () => {
		expect(parsePositions("0, 10, 30")).toEqual([0, 10, 30]);
		expect(parsePositions("0,10,")).toEqual([0, 10]); // trailing comma → no 0
		expect(parsePositions("")).toEqual([]);
		expect(parsePositions(" 5 , a , 7 ")).toEqual([5, 7]);
	});
});

describe("sprites", () => {
	it("round-trips a sprite (tiles, vtt, creationMode, nested path)", () => {
		// No shipped preset carries a sprite, so build one onto a base state and
		// exercise every deviation branch (grid, filenames, creationMode, path).
		const base = planToWizardState(presetPlan("fixed-bitrate-hls-on-aws"));
		// unit omitted: SECONDS is the schema default, so the wizard reads it
		// back as undefined (nonDefault) — exercise PERCENTS in the next test
		// for the non-default unit branch.
		const sprite = {
			key: "s1",
			streamKey: "v540",
			distance: 10,
			height: 90,
			hTiles: 10,
			vTiles: 10,
			spriteName: "sprite.jpg",
			filename: "sprite.jpg",
			vttName: "sprite.vtt",
			creationMode: "INTERVAL_START" as const,
			path: "sprites/540",
		};
		const state: WizardState = { ...base, sprites: [sprite] };
		const plan = encodingPlanSchema.parse(buildPlan(state));
		const readback = planToWizardState(
			plan as unknown as Record<string, unknown>,
		);
		expect(readback.sprites).toEqual([sprite]);
		// Full round-trip through the rebuilt state.
		expect(encodingPlanSchema.parse(buildPlan(readback))).toEqual(plan);
	});

	it("round-trips an images-per-file sprite with a non-default unit (PERCENTS)", () => {
		const base = planToWizardState(presetPlan("fixed-bitrate-hls-on-aws"));
		const sprite = {
			key: "s1",
			streamKey: "v540",
			distance: 5,
			unit: "PERCENTS" as const,
			width: 160,
			imagesPerFile: 100,
			filename: "sp.png",
		};
		const state: WizardState = { ...base, sprites: [sprite] };
		const plan = encodingPlanSchema.parse(buildPlan(state));
		// imagesPerFile path (no hTiles/vTiles) and the non-default unit branch.
		expect((plan.sprites?.[0] as { unit?: string })?.unit).toBe("PERCENTS");
		const readback = planToWizardState(
			plan as unknown as Record<string, unknown>,
		);
		expect(readback.sprites).toEqual([sprite]);
		expect(encodingPlanSchema.parse(buildPlan(readback))).toEqual(plan);
	});
});

describe("placeholder Start-gate", () => {
	// The wizard's formPlaceholders gate = collectPlaceholders(buildPlan(state));
	// it replaced the old "fall back on placeholders" behaviour, so a regression
	// where buildPlan stops preserving a sample path would silently un-gate Start
	// and let a <INSERT…> path reach Bitmovin. This pins the seam (no render).
	it("keeps placeholder path tokens in the rebuilt plan after creds are filled", () => {
		const rawTokens = collectPlaceholders(
			presetPlan("deinterlace-filter"),
		).length;
		expect(rawTokens).toBeGreaterThan(0);
		const result = tryImportPresetIntoWizard(presetPlan("deinterlace-filter"));
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const realId = "11111111-2222-4333-8444-555555555555";
		const withCreds: WizardState = {
			...result.state,
			accountId: realId,
			inputFiles: result.state.inputFiles.map((f) => ({
				...f,
				credentialId: realId,
			})),
			output: { ...result.state.output, credentialId: realId },
		};
		const evaluation = evaluateWizardState(withCreds);
		expect(evaluation.ok).toBe(true);
		if (!evaluation.ok) {
			return;
		}
		// Exactly what wizard.tsx computes for formPlaceholders.
		expect(
			collectPlaceholders(evaluation.plan as unknown as Record<string, unknown>)
				.length,
		).toBe(rawTokens);
	});
});

describe("clearSamplePlaceholders", () => {
	it("zeroes input/output/extraInputs/accountId placeholder ids", () => {
		const result = tryImportPresetIntoWizard(
			presetPlan("fixed-bitrate-hls-on-aws"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.state.inputFiles[0]?.credentialId).toBe("");
		expect(result.state.output.credentialId).toBe("");
		// Sample bucket + path stay as editable prefill.
		expect(result.state.inputFiles[0]?.bucket).toBe("sample-input-bucket");
		expect(result.state.inputFiles[0]?.path).toBe(
			"sintel/Sintel.2010.1080p.mkv",
		);
	});

	it("zeroes DRM and NexGuard credential placeholders", () => {
		const drm = tryImportPresetIntoWizard(presetPlan("cenc-cbc-drm-on-aws"));
		expect(drm.ok).toBe(true);
		if (drm.ok) {
			expect((drm.state.drm ?? []).length).toBeGreaterThan(0);
			for (const row of drm.state.drm ?? []) {
				expect(row.credentialId).toBe("");
			}
		}
		const nex = tryImportPresetIntoWizard(presetPlan("nexguard-watermarking"));
		expect(nex.ok).toBe(true);
		if (nex.ok) {
			const guarded = nex.state.videos.filter((v) => v.extras?.nexguard);
			expect(guarded.length).toBeGreaterThan(0);
			for (const v of guarded) {
				expect(v.extras?.nexguard?.credentialId).toBe("");
			}
		}
	});

	it("leaves real (non-placeholder) vault ids untouched", () => {
		const realId = "11111111-2222-4333-8444-555555555555";
		const altId = "22222222-3333-4444-8555-666666666666";
		const state = planToWizardState(presetPlan("fixed-bitrate-hls-on-aws"));
		const real: WizardState = {
			...state,
			// A second, non-primary input file with its own real credential: the
			// clear pass must spare every file's real id, not only inputFiles[0].
			inputFiles: [
				...state.inputFiles.map((f) => ({ ...f, credentialId: realId })),
				{
					key: "extra",
					inputKey: "extra",
					kind: "S3" as const,
					credentialId: altId,
					bucket: "real-bucket",
					path: "real/extra.mov",
					name: "Extra",
				},
			],
			drm: [
				{ kind: "CENC", muxingKey: "v360", credentialId: realId, kid: "a" },
			],
		};
		const cleared = clearSamplePlaceholders(real);
		expect(cleared.inputFiles[0]?.credentialId).toBe(realId);
		expect(cleared.inputFiles[1]?.credentialId).toBe(altId);
		expect(cleared.drm?.[0]?.credentialId).toBe(realId);
	});
});

describe("input-file split (one Bitmovin input, many objects)", () => {
	it("splits an input read at N objects into N files sharing the inputKey", () => {
		// This DV fixture declares a single `main` input read at four distinct
		// objects (DV video, DV metadata, Atmos, AAC mezzanine). The readback
		// must yield one input file per distinct object, all anchored to the
		// same Bitmovin input id, with unique wizard keys — the inverse of
		// buildPlan's inputKey dedupe. A regression here localizes to this
		// assertion instead of a whole-plan deep-equal diff.
		const state = planToWizardState(
			presetPlan("dolby-dv-hdr10-sdr-3ladder-profile5-single-input"),
		);
		expect(new Set(state.inputFiles.map((f) => f.inputKey))).toEqual(
			new Set(["main"]),
		);
		expect(state.inputFiles.length).toBe(4);
		expect(new Set(state.inputFiles.map((f) => f.key)).size).toBe(4);
		expect(new Set(state.inputFiles.map((f) => f.path)).size).toBe(4);
	});
});

describe("manifest mapping", () => {
	it("maps the canonical HLS+DASH ladder onto the primary toggles", () => {
		const result = tryImportPresetIntoWizard(
			presetPlan("fixed-bitrate-dash-hls-streamcondition-on-aws"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.state.manifests.hls).toBe(true);
		expect(result.state.manifests.dash).toBe(true);
		expect(result.state.manifests.extra ?? []).toEqual([]);
		expect(result.state.audioGuard).toBe(true);
	});

	it("preserves non-canonical manifest order via extra manifests", () => {
		// audio-only writes [dash, hls] — order the primary toggles can't produce.
		const result = tryImportPresetIntoWizard(
			presetPlan("audio-only-aac-fmp4-hls-dash"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect((result.state.manifests.extra ?? []).map((m) => m.kind)).toEqual([
			"DASH",
			"HLS",
		]);
		expect(result.state.timing).toBe("POST_ENCODING");
	});
});

describe("describeFormGap", () => {
	it("returns null for the now-covered advanced families", () => {
		const gapOf = (name: string) => {
			const parsed = encodingPlanSchema.safeParse(presetPlan(name));
			return parsed.success ? describeFormGap(parsed.data) : "PARSE_FAIL";
		};
		// DRM / Dolby / Per-Title / AI / keyframes / NexGuard are form-mappable.
		expect(gapOf("cenc-cbc-drm-on-aws")).toBeNull();
		expect(gapOf("dolby-dv-atmos-adm")).toBeNull();
		expect(gapOf("hdr10-pertitle")).toBeNull();
		expect(gapOf("ai-scene-analysis-passthrough")).toBeNull();
		expect(gapOf("nexguard-watermarking")).toBeNull();
		expect(gapOf("fixed-bitrate-hls-on-aws")).toBeNull();
		// Azure/HTTPS storage (Wave 2) and thumbnails (Wave 3) are covered too.
		expect(gapOf("fixed-bitrate-hls-on-azure")).toBeNull();
		expect(gapOf("dolby-dv-atmos-adm-https")).toBeNull();
		expect(
			gapOf("fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws"),
		).toBeNull();
	});

	it("returns null for every sample preset (no pre-gate form gaps remain)", () => {
		for (const preset of SAMPLE_PRESETS) {
			const parsed = encodingPlanSchema.safeParse(presetPlan(preset.name));
			if (parsed.success) {
				expect(describeFormGap(parsed.data), preset.name).toBeNull();
			}
		}
	});
});

describe("round-trip gate", () => {
	it("rejects a plan whose field the form can't carry", () => {
		// Passes describeFormGap but adds a per-VIDEO stream condition buildPlan
		// never emits — the readback drops it, so the gate must refuse it.
		const raw = structuredClone(presetPlan("fixed-bitrate-hls-on-aws"));
		const renditions = raw.renditions as Array<Record<string, unknown>>;
		const video = renditions.find((r) => r.codec === "H264");
		if (!video) {
			throw new Error("fixture changed: no H264 rendition");
		}
		video.conditions = {
			attribute: "WIDTH",
			operator: "GREATER_THAN",
			value: "0",
		};
		const parsed = encodingPlanSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error("mutated plan should still parse");
		}
		expect(describeFormGap(parsed.data)).toBeNull(); // no form-gap…
		const result = tryImportPresetIntoWizard(raw);
		expect(result.ok).toBe(false); // …but the gate refuses it
		if (!result.ok) {
			// The reason is a MESSAGE KEY now, not prose — it is spliced into a
			// localized frame, and an English clause inside a Japanese sentence was
			// the bug (review catch).
			expect(result.reasonKey).toMatch(
				/reasonUsesUnrepresented|reasonCannotBeRebuilt/,
			);
		}
	});

	it("rejects non-plan input", () => {
		const result = tryImportPresetIntoWizard({ not: "a plan" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reasonKey).toBe("wizardX.reasonNotAValidPlan");
		}
	});
});

describe("plansDeepEqual", () => {
	it("ignores undefined-valued keys (matches JSON / vitest toEqual)", () => {
		expect(plansDeepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
		expect(plansDeepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
	});
	it("treats null as distinct from absent", () => {
		expect(plansDeepEqual({ a: null }, {})).toBe(false);
		expect(plansDeepEqual({ a: null }, { a: undefined })).toBe(false);
	});
	it("is array-order sensitive, even when nested", () => {
		expect(plansDeepEqual({ m: [1, 2] }, { m: [2, 1] })).toBe(false);
		expect(plansDeepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
	});
	it("does not coerce scalars and catches real extra keys symmetrically", () => {
		expect(plansDeepEqual({ n: 300000 }, { n: "300000" })).toBe(false);
		expect(plansDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(plansDeepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
	});
	it("distinguishes arrays from objects", () => {
		expect(plansDeepEqual([], {})).toBe(false);
	});
});

describe("trimming + concatenation round-trip", () => {
	// A minimal video plan whose single rendition reads a trim/concat stream —
	// proves the wizard reads the new arrays back AND rebuilds them byte-for-byte.
	const base = {
		planVersion: 1,
		name: "trim test",
		bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1", encoderVersion: "STABLE" },
		inputs: [
			{
				key: "main",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "in",
				name: "Test S3 Input",
			},
		],
		outputs: [
			{
				key: "origin",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "out",
				name: "Test S3 Output",
			},
		],
		muxings: [
			{
				key: "v720",
				kind: "FMP4",
				streamKey: "v720",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: {
					outputKey: "origin",
					path: "output/trim/video/720p",
					acl: "PUBLIC_READ",
				},
			},
		],
		manifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "stream.m3u8",
				name: "HLS Manifest",
				destination: {
					outputKey: "origin",
					path: "output/trim/",
					acl: "PUBLIC_READ",
				},
				masterVersion: "HLS_V6",
				mediaVersion: "HLS_V6",
				audioGroupId: "audio",
				audioLanguage: "en",
				closedCaptions: "NONE",
			},
		],
		generation: { timing: "JUST_IN_TIME" },
	};

	it("round-trips a time-based trimming stream", () => {
		const raw = {
			...base,
			ingest: [
				{
					key: "video",
					inputKey: "main",
					inputPath: "video.mp4",
					selectionMode: "VIDEO_RELATIVE",
					position: 0,
				},
			],
			trimmingStreams: [
				{
					key: "trim",
					kind: "TIME_BASED",
					sourceKey: "video",
					offset: 10,
					duration: 30,
				},
			],
			renditions: [
				{
					key: "v720",
					codec: "H264",
					name: "H264 720p",
					ingestKey: "trim",
					height: 720,
					bitrate: 3000000,
				},
			],
		};
		const original = encodingPlanSchema.parse(raw);
		const state = planToWizardState(raw);
		expect(state.sources?.trimmingStreams).toEqual([
			{
				kind: "TIME_BASED",
				key: "trim",
				sourceKey: "video",
				offset: 10,
				duration: 30,
			},
		]);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(original);
	});

	it("round-trips a two-source concatenation stream", () => {
		const raw = {
			...base,
			ingest: [
				{
					key: "partA",
					inputKey: "main",
					inputPath: "part-a.mp4",
					selectionMode: "VIDEO_RELATIVE",
					position: 0,
				},
				{
					key: "partB",
					inputKey: "main",
					inputPath: "part-b.mp4",
					selectionMode: "VIDEO_RELATIVE",
					position: 0,
				},
			],
			concatenationStreams: [
				{
					key: "joined",
					sources: [
						{ sourceKey: "partA", isMain: true, position: 0 },
						{ sourceKey: "partB", position: 1 },
					],
				},
			],
			renditions: [
				{
					key: "v720",
					codec: "H264",
					name: "H264 720p",
					ingestKey: "joined",
					height: 720,
					bitrate: 3000000,
				},
			],
		};
		const original = encodingPlanSchema.parse(raw);
		const state = planToWizardState(raw);
		expect(state.sources?.concatenationStreams).toEqual([
			{
				key: "joined",
				sources: [
					{ sourceKey: "partA", isMain: true, position: 0 },
					{ sourceKey: "partB", position: 1 },
				],
			},
		]);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(original);
	});
});

describe("AV1 codec round-trip", () => {
	// AV1 fixtures are synthetic (excluded from SAMPLE_PRESETS), so round-trip
	// them directly off the golden plan.json files.
	const fixturesDir = join(
		__dirname,
		"../../../../../../packages/core/src/plan/__fixtures__",
	);
	const loadFixture = (name: string): Record<string, unknown> =>
		JSON.parse(readFileSync(join(fixturesDir, `${name}.plan.json`), "utf8"));

	it("imports an AV1 fMP4 DASH+HLS ladder into the form", () => {
		const raw = loadFixture("av1-fmp4-dash-hls");
		const result = tryImportPresetIntoWizard(raw);
		expect(result.ok).toBe(true);
	});

	for (const name of ["av1-fmp4-dash-hls", "pertitle-av1-fmp4-dash-on-aws"]) {
		it(`rebuilds ${name} byte-for-byte through buildPlan(planToWizardState)`, () => {
			const raw = loadFixture(name);
			const original = encodingPlanSchema.parse(raw);
			const state = planToWizardState(raw);
			const rebuilt = encodingPlanSchema.parse(buildPlan(state));
			expect(rebuilt, `${name} did not round-trip`).toEqual(original);
			expect(plansDeepEqual(rebuilt, original)).toBe(true);
		});
	}

	it("carries the AV1 preset/autoLevelSetup onto the rendition option bag", () => {
		const state = planToWizardState(loadFixture("av1-fmp4-dash-hls"));
		const v720 = state.videos?.find((v) => v.height === 720);
		expect(v720?.codec).toBe("AV1");
		expect(v720?.av1?.presetConfiguration).toBe("VOD_QUALITY");
		expect(v720?.av1?.autoLevelSetup).toBe("ENABLED");
	});
});

describe("kantar (audio watermarking) round-trip", () => {
	// The kantar golden is SYNTHETIC (excluded from SAMPLE_PRESETS / the preset
	// gallery), so round-trip it directly off the golden plan.json.
	const raw = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/plan/__fixtures__/kantar-audio-watermark.plan.json",
			),
			"utf8",
		),
	) as Record<string, unknown>;

	it("reads the plan-root block back into wizard state", () => {
		const state = planToWizardState(raw);
		// The report path lands RELATIVE to the base output path (AISA precedent)
		// and the PRIVATE report ACL survives even though the delivery
		// destinations are PUBLIC_READ — the two are modelled independently.
		expect(state.kantar).toEqual({
			credentialId: "00000000-0000-4000-8000-0000000000b1",
			licenseId: 4711,
			channelName: "Demo Channel JP",
			contentReference: "bbb-2026-08-06-ep01",
			serverUrl: "https://kantar.example.com/watermark",
			reportPath: "reports",
			reportPrivate: true,
		});
		expect(state.output.basePath).toBe("output/kantar-audio-watermark/");
		expect(state.output.publicRead).toBe(true);
	});

	it("rebuilds the golden byte-for-byte (plan → state → plan)", () => {
		const original = encodingPlanSchema.parse(raw);
		const rebuilt = encodingPlanSchema.parse(buildPlan(planToWizardState(raw)));
		expect(rebuilt).toEqual(original);
		expect(plansDeepEqual(rebuilt, original)).toBe(true);
	});

	it("round-trips state → plan → state (fields land back where they started)", () => {
		const state = planToWizardState(raw);
		const reread = planToWizardState(
			encodingPlanSchema.parse(buildPlan(state)) as unknown as Record<
				string,
				unknown
			>,
		);
		expect(reread.kantar).toEqual(state.kantar);
	});

	it("opens in the wizard FORM (not the imported-plan fallback)", () => {
		const result = tryImportPresetIntoWizard(raw);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// The placeholder KANTAR credential is zeroed like NexGuard's, so the
			// picker shows "Select credential…" instead of arming Start with a
			// vault id that doesn't exist. Everything else is prefill.
			expect(result.state.kantar?.credentialId).toBe("");
			expect(result.state.kantar?.licenseId).toBe(4711);
			expect(result.state.kantar?.reportPath).toBe("reports");
			expect(result.state.kantar?.reportPrivate).toBe(true);
		}
	});

	it("leaves the section off (no state, no plan key) for a kantar-less plan", () => {
		const state = planToWizardState(presetPlan("fixed-bitrate-hls-on-aws"));
		expect(state.kantar).toBeUndefined();
		expect("kantar" in buildPlan(state)).toBe(false);
	});

	it("reads an inherited (absent-PRIVATE) report ACL as reportPrivate unset", () => {
		// A report leg without an explicit PRIVATE reads back as "inherit", so the
		// checkbox is unticked and buildPlan re-emits the output's own ACL.
		const kantar = raw.kantar as Record<string, unknown>;
		const inherited = {
			...raw,
			kantar: {
				...kantar,
				reportDestination: {
					outputKey: "origin",
					path: "output/kantar-audio-watermark/reports",
					acl: "PUBLIC_READ",
				},
			},
		};
		const state = planToWizardState(inherited);
		expect(state.kantar?.reportPrivate).toBeUndefined();
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(encodingPlanSchema.parse(inherited));
	});
});

/**
 * QC gate round-trip : the editor carries the schema shape
 * VERBATIM through wizard state, so both directions must be byte-exact —
 * a gate that survives import but not rebuild would silently drop rules the
 * operator reviewed.
 */
describe("qc.gate round-trip", () => {
	const GATED: Record<string, unknown> = {
		planVersion: 1,
		name: "gate-rt",
		bitmovin: {},
		inputs: [
			{
				key: "main",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "in",
				name: "In",
			},
		],
		outputs: [
			{
				key: "origin",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "out",
				name: "Out",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "src.mkv",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
			{
				key: "audio",
				inputKey: "main",
				inputPath: "src.mkv",
				selectionMode: "AUDIO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "v360",
				ingestKey: "video",
				codec: "H264",
				height: 360,
				bitrate: 300000,
			},
			{
				key: "a64",
				ingestKey: "audio",
				codec: "AAC",
				bitrate: 64000,
				rate: 44100,
			},
		],
		muxings: [
			{
				key: "m360",
				kind: "FMP4",
				streamKey: "v360",
				destination: { outputKey: "origin", path: "./video/360" },
			},
			{
				key: "ma",
				kind: "FMP4",
				streamKey: "a64",
				destination: { outputKey: "origin", path: "./audio" },
			},
		],
		manifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "master.m3u8",
				destination: { outputKey: "origin", path: "./" },
			},
		],
		generation: { timing: "POST_ENCODING" },
		qc: {
			vmaf: true,
			gate: {
				rules: [
					{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 85 },
					{
						metric: "VMAF_MIN",
						scope: "PER_RENDITION",
						gte: 60,
						renditions: ["v360"],
					},
				],
				onFail: "BLOCK_MANIFESTS",
			},
		},
	};

	it("plan → state → plan keeps the gate byte-for-byte", () => {
		const state = planToWizardState(GATED);
		expect(state.qc?.gate).toEqual((GATED.qc as { gate: unknown }).gate);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(encodingPlanSchema.parse(GATED));
	});

	it("a malformed gate reads as ABSENT while vmaf survives (tolerant read)", () => {
		const mangled = {
			...GATED,
			qc: { vmaf: true, gate: { rules: [], onFail: "EXPLODE" } },
		};
		const state = planToWizardState(mangled);
		expect(state.qc?.vmaf).toBe(true);
		expect(state.qc?.gate).toBeUndefined();
	});

	it("turning qc off prunes the gate with the rest of the key", () => {
		const state = planToWizardState(GATED);
		const off = {
			...state,
			qc: {
				...(state.qc ?? { model: DEFAULT_VMAF_MODEL }),
				vmaf: false,
				psnr: false,
			},
		};
		const rebuilt = buildPlan(off as WizardState) as Record<string, unknown>;
		expect(rebuilt.qc).toBeUndefined();
	});
});
