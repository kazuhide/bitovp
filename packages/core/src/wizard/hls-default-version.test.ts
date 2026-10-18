import { describe, expect, it } from "vitest";
import {
	hlsDefaultVersion,
	type WizardAudioRendition,
	type WizardVideoRendition,
} from "./build-plan";

/**
 * The derived HLS playlist-version default : V6 when the manifest
 * will enumerate an fMP4 leg (EXT-X-MAP is version 6, RFC 8216 §7), V4
 * otherwise — which is what the vendor's TS/MP4 samples use. One definition;
 * `buildPlan` emits it and `planToWizardState` drops exactly it on import.
 *
 * "an fMP4 LEG", not "an fMP4 video leg": `mediaVersion` is one value over
 * every child playlist the master lists, and an audio playlist carries
 * EXT-X-MAP for the same reason a video one does. The video-only scan made an
 * audio-only ladder default to V4 with no way to reach V6 (2026-08-29 paid
 * re-audit HIGH-4) — the arms below cover both families and the interaction.
 */
const state = (
	videos: WizardVideoRendition[],
	audios: WizardAudioRendition[] = [],
) => ({ videos, audios });
const audio = (
	muxing?: WizardAudioRendition["muxing"],
	extraMuxings?: WizardAudioRendition["extraMuxings"],
): WizardAudioRendition => ({
	bitrate: 128_000,
	rate: 48_000,
	...(muxing ? { muxing } : {}),
	...(extraMuxings ? { extraMuxings } : {}),
});

describe("hlsDefaultVersion — video legs", () => {
	it("V6 for the fMP4 default leg", () => {
		expect(
			hlsDefaultVersion(state([{ height: 1080, bitrate: 1 }]), undefined),
		).toBe("HLS_V6");
	});
	it("V4 when every video leg is TS", () => {
		expect(
			hlsDefaultVersion(
				state([{ height: 1080, bitrate: 1, muxing: { kind: "TS" } }]),
				undefined,
			),
		).toBe("HLS_V4");
	});
	it("V4 when the manifest pins a TS leg, even beside fMP4 legs", () => {
		// The manifest enumerates its pinned leg only; the fMP4 leg feeds DASH.
		expect(
			hlsDefaultVersion(
				state([
					{
						height: 1080,
						bitrate: 1,
						muxing: { kind: "FMP4" },
						extraMuxings: [{ kind: "TS" }],
					},
				]),
				{ videoMuxingKind: "TS" },
			),
		).toBe("HLS_V4");
	});
	it("V6 when an EXTRA leg is fMP4 and the manifest does not pin", () => {
		expect(
			hlsDefaultVersion(
				state([
					{
						height: 1080,
						bitrate: 1,
						muxing: { kind: "TS" },
						extraMuxings: [{ kind: "FMP4" }],
					},
				]),
				undefined,
			),
		).toBe("HLS_V6");
	});
	it("V6 for a MIXED ladder with no pin — the manifest lists every video leg (review-324)", () => {
		// The scan is deliberately over ALL videos, not a subset: an HLS manifest
		// with no `videoMuxingKind` enumerates every video muxing the plan has
		// (compiler: the kind filter is skipped when nothing is pinned), so "any
		// fMP4 among all legs" IS "any fMP4 among the legs this manifest lists".
		// The pinned case above is the one that narrows.
		expect(
			hlsDefaultVersion(
				state([
					{ height: 1080, bitrate: 1, muxing: { kind: "TS" } },
					{ height: 720, bitrate: 1, muxing: { kind: "FMP4" } },
				]),
				undefined,
			),
		).toBe("HLS_V6");
	});
});

describe("hlsDefaultVersion — audio legs (HIGH-4)", () => {
	it("V6 for an AUDIO-ONLY plan whose audio muxing is fMP4", () => {
		// The defect, exactly: zero video legs used to return V4 unconditionally
		// ("nothing carries an EXT-X-MAP"), and the corpus holds three audio-only
		// fixtures whose audio muxing is fMP4 and whose playlists do.
		expect(hlsDefaultVersion(state([], [audio()]), undefined)).toBe("HLS_V6");
	});

	it("V4 for an audio-only plan on a TS leg — no EXT-X-MAP there", () => {
		expect(
			hlsDefaultVersion(state([], [audio({ kind: "TS" })]), undefined),
		).toBe("HLS_V4");
	});

	it("V4 for a plan with no renditions at all", () => {
		expect(hlsDefaultVersion(state([]), undefined)).toBe("HLS_V4");
	});

	it("V6 when the VIDEO is TS but the audio rides its own fMP4 container", () => {
		// Cross-family, and the reason the rule is per-LEG: one `mediaVersion`
		// covers the audio media playlist too, so a V4 master here is wrong
		// even though every video playlist is a plain TS one.
		expect(
			hlsDefaultVersion(
				state(
					[{ height: 1080, bitrate: 1, muxing: { kind: "TS" } }],
					[audio()],
				),
				undefined,
			),
		).toBe("HLS_V6");
	});

	it("V4 when the manifest pins a TS audio leg beside the fMP4 one", () => {
		expect(
			hlsDefaultVersion(
				state([], [audio({ kind: "FMP4" }, [{ kind: "TS" }])]),
				{ audioMuxingKind: "TS" },
			),
		).toBe("HLS_V4");
	});

	it("V6 when the manifest pins the fMP4 audio leg", () => {
		expect(
			hlsDefaultVersion(
				state([], [audio({ kind: "FMP4" }, [{ kind: "TS" }])]),
				{ audioMuxingKind: "FMP4" },
			),
		).toBe("HLS_V6");
	});

	it("V4 when the audio rides INSIDE the TS video container (ledger #192)", () => {
		// `ownContainer: false` emits no standalone audio muxing, so there is no
		// audio media playlist to carry an EXT-X-MAP — and the row's nominal kind
		// is fMP4 (the default), which a naive `state.audios` scan would read as
		// "fMP4 leg". `planToWizardState` produces exactly this shape on every
		// muxed import, so getting it wrong would have flipped those plans to V6.
		expect(
			hlsDefaultVersion(
				state(
					[
						{
							height: 1080,
							bitrate: 1,
							muxing: { kind: "TS", muxedAudioKeys: ["a128"] },
						},
					],
					[audio({ ownContainer: false })],
				),
				undefined,
			),
		).toBe("HLS_V4");
	});

	it("V6 when ownContainer is false but NOTHING carries the track", () => {
		// The other half of  C1: a choice that cannot be honoured is
		// not honoured — the container IS emitted, so it does carry EXT-X-MAP.
		expect(
			hlsDefaultVersion(
				state(
					[{ height: 1080, bitrate: 1, muxing: { kind: "TS" } }],
					[audio({ ownContainer: false })],
				),
				undefined,
			),
		).toBe("HLS_V6");
	});

	it("a VMAF-only plan's audio rows imply nothing — they emit no container", () => {
		// Unreachable through a manifest today (qc-only plans carry none); the
		// arm exists so this derivation and `buildPlan`'s muxing emission keep
		// answering "which audio containers does this plan have" the same way.
		expect(
			hlsDefaultVersion(
				{
					...state(
						[{ height: 1080, bitrate: 1, muxing: { kind: "TS" } }],
						[audio()],
					),
					qc: { only: true, vmaf: true, psnr: false, model: "vmaf_v0.6.1" },
				},
				undefined,
			),
		).toBe("HLS_V4");
	});
});
