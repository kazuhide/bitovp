import { MUXING_CODEC_MATRIX } from "@bitovp/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized, renderWithQuery } from "@/test/render";
import { reconcileAutomaticAudioPackaging } from "./automatic-audio-packaging";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardMuxing,
	type WizardState,
	type WizardVideoCodec,
} from "./build-plan";
import { MuxingsSection } from "./muxings-section";

/**
 * PROGRESSIVE_TS, PROGRESSIVE_MOV and PROGRESSIVE_WEBM in the packaging step.
 *
 * A whole file is not a streaming container with a different name, and the
 * form has to say so in three places a value-level test cannot see: which rows
 * are offered the kind at all, which fields the kind has, and which controls
 * it must NOT have (encryption — the validator refuses it, so offering it
 * would be offering an error).
 *
 * The WebM file has a neighbour to be told apart from on this page: the `WEBM`
 * container with its "Single WebM file" switch, which holds one stream.
 */

const FILE_KINDS = [
	"PROGRESSIVE_TS",
	"PROGRESSIVE_MOV",
	"PROGRESSIVE_WEBM",
] as const;
type FileKind = (typeof FILE_KINDS)[number];

/** One video row; `audios: []` keeps the row's own fields the only ones on the page. */
function stateWith(
	muxing: WizardMuxing | undefined,
	over: Partial<WizardState> = {},
	codec: WizardVideoCodec = "H264",
): WizardState {
	return {
		...DEFAULT_WIZARD_STATE,
		videos: [
			{ height: 360, bitrate: 800000, codec, ...(muxing ? { muxing } : {}) },
		],
		audios: [],
		manifests: { hls: false, dash: false },
		...over,
	} as WizardState;
}
const oneAudio: Partial<WizardState> = {
	audios: [{ codec: "AAC", bitrate: 128000, rate: 48000 }],
};
const oneOpus: Partial<WizardState> = {
	audios: [{ codec: "OPUS", bitrate: 128000, rate: 48000 }],
};

/**
 * A row of this kind in codecs the kind holds: H.264 with AAC for a `.ts` or
 * `.mov`, VP9 with Opus for a `.webm`. `withAudio` adds the one audio track.
 */
function fileRow(
	kind: FileKind,
	muxing: WizardMuxing = {},
	withAudio = false,
): WizardState {
	const webm = kind === "PROGRESSIVE_WEBM";
	return stateWith(
		{ kind, ...muxing },
		withAudio ? (webm ? oneOpus : oneAudio) : {},
		webm ? "VP9" : "H264",
	);
}

function render(state: WizardState, onPatch = vi.fn()) {
	const view = renderLocalized(
		<MuxingsSection state={state} credentials={[]} onPatch={onPatch} />,
	);
	return { ...view, onPatch };
}

/** The video row's container select — video rows render before audio rows. */
const kindSelect = () =>
	screen.getAllByLabelText("Container")[0] as HTMLSelectElement;
const offeredKinds = () => [...kindSelect().options].map((o) => o.value);

/** The form with real state behind it, so an edit is read back by the next. */
function Harness({
	initial,
	latest,
}: {
	initial: WizardState;
	latest: { state: WizardState };
}) {
	const [value, setValue] = useState(initial);
	return (
		<MuxingsSection
			state={value}
			credentials={[]}
			onPatch={(patch) =>
				setValue((prev) => {
					const next = { ...prev, ...patch };
					latest.state = next;
					return next;
				})
			}
		/>
	);
}
function renderHarness(initial: WizardState) {
	const latest = { state: initial };
	renderLocalized(<Harness initial={initial} latest={latest} />);
	return latest;
}

describe("which rows are offered a whole-file container", () => {
	it("an H264 row is, after the streaming kinds, spelled as the plan spells them", () => {
		render(stateWith(undefined));
		expect(offeredKinds()).toEqual([
			"FMP4",
			"CMAF",
			"MP4",
			"TS",
			"WEBM",
			"PROGRESSIVE_TS",
			"PROGRESSIVE_MOV",
		]);
		expect([...kindSelect().options].map((o) => o.textContent)).toEqual(
			offeredKinds(),
		);
	});

	it.each([
		"H264",
		"H265",
		"H265V2",
		"VP9",
		"AV1",
	] as const)("a %s row is offered them exactly when the validator's matrix allows that codec", (codec) => {
		// Read off the table `PLAN_MUXING_CODEC_MISMATCH` is raised from, so the
		// picker cannot offer a pairing the preview is certain to refuse — and
		// follows the table the day a row gains a codec.
		const planCodec = codec === "H265V2" ? "H265" : codec;
		render(stateWith(undefined, {}, codec));
		for (const kind of FILE_KINDS) {
			expect(offeredKinds().includes(kind), kind).toBe(
				MUXING_CODEC_MATRIX[kind].includes(planCodec),
			);
		}
		// The streaming kinds are not this change's to filter.
		expect(offeredKinds()).toContain("FMP4");
		expect(offeredKinds()).toContain("TS");
	});

	it("today that means H264 and H265 for the .ts and .mov files, and neither for the .webm file", () => {
		// The arm above would pass on an empty matrix row and on a full one.
		render(stateWith(undefined, {}, "H265"));
		expect(FILE_KINDS.filter((kind) => offeredKinds().includes(kind))).toEqual([
			"PROGRESSIVE_TS",
			"PROGRESSIVE_MOV",
		]);
	});

	it.each([
		"VP9",
		"AV1",
	] as const)("a %s row is offered the .webm file after the streaming kinds, and neither of the other two", (codec) => {
		render(stateWith(undefined, {}, codec));
		expect(offeredKinds()).toEqual([
			"FMP4",
			"MP4",
			"TS",
			"WEBM",
			"PROGRESSIVE_WEBM",
		]);
	});

	it("an audio row is never offered one — audio rides inside the video's file", () => {
		render(stateWith(undefined, oneAudio));
		const audioKinds = [
			...(screen.getAllByLabelText("Container")[1] as HTMLSelectElement)
				.options,
		].map((o) => o.value);
		expect(audioKinds).toEqual(["FMP4", "CMAF", "MP4", "TS"]);
	});

	it("an Opus row is not either: its own container stays the segmented WebM one", () => {
		render(stateWith(undefined, oneOpus, "VP9"));
		const audioKinds = [
			...(screen.getAllByLabelText("Container")[1] as HTMLSelectElement)
				.options,
		].map((o) => o.value);
		expect(audioKinds).toEqual(["WEBM"]);
	});
});

describe("the fields a whole file has", () => {
	it("a TS file: a filename and two optional numbers, and no segment naming", () => {
		render(stateWith({ kind: "PROGRESSIVE_TS" }));
		expect(screen.getByLabelText("Filename")).toBeTruthy();
		expect(screen.getByLabelText("Segment length (s)")).toBeTruthy();
		expect(screen.getByLabelText("Start offset (s)")).toBeTruthy();
		expect(screen.getByLabelText("Destination path")).toBeTruthy();
		expect(screen.queryByLabelText("Segment naming")).toBeNull();
		expect(screen.queryByLabelText("Init segment")).toBeNull();
	});

	it("a MOV file: a filename, and neither number", () => {
		render(stateWith({ kind: "PROGRESSIVE_MOV" }));
		expect(screen.getByLabelText("Filename")).toBeTruthy();
		expect(screen.getByLabelText("Destination path")).toBeTruthy();
		expect(screen.queryByLabelText("Segment length (s)")).toBeNull();
		expect(screen.queryByLabelText("Start offset (s)")).toBeNull();
	});

	it("a WebM file: a filename with its own default, neither number, and no single-file switch", async () => {
		render(fileRow("PROGRESSIVE_WEBM"));
		expect(screen.getByLabelText("Filename")).toBeTruthy();
		expect(screen.getByLabelText("Destination path")).toBeTruthy();
		expect(screen.queryByLabelText("Segment length (s)")).toBeNull();
		expect(screen.queryByLabelText("Start offset (s)")).toBeNull();
		expect(screen.queryByLabelText("Segment naming")).toBeNull();
		expect(screen.queryByLabelText("Init segment")).toBeNull();
		// The switch belongs to the WEBM container; a file has nothing to switch.
		expect(screen.queryByLabelText("Single WebM file")).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: "Filename — more information" }),
		);
		expect(screen.getByText("Default output.webm")).toBeTruthy();
	});

	it("the counterfactual — the WEBM container has the switch, and one stream", () => {
		render(stateWith({ kind: "WEBM" }, oneOpus, "VP9"));
		expect(screen.getAllByLabelText("Single WebM file").length).toBeGreaterThan(
			0,
		);
		expect(screen.queryByLabelText(/Muxed-in audio/)).toBeNull();
	});

	it("the counterfactual — segmented TS has the naming a file does not", () => {
		render(stateWith({ kind: "TS" }));
		expect(screen.getByLabelText("Segment naming")).toBeTruthy();
		expect(screen.queryByLabelText("Filename")).toBeNull();
		expect(screen.queryByLabelText("Start offset (s)")).toBeNull();
	});

	it("leaves both numbers empty rather than showing a default it would not send", () => {
		render(stateWith({ kind: "PROGRESSIVE_TS" }));
		expect(
			(screen.getByLabelText("Segment length (s)") as HTMLInputElement).value,
		).toBe("");
		expect(
			(screen.getByLabelText("Start offset (s)") as HTMLInputElement).value,
		).toBe("");
	});

	it("writes a zero start offset as a number, not as an absence", async () => {
		const { onPatch } = render(stateWith({ kind: "PROGRESSIVE_TS" }));
		await userEvent.type(screen.getByLabelText("Start offset (s)"), "0");
		const patch = onPatch.mock.calls.at(-1)?.[0] as Partial<WizardState>;
		expect(patch.videos?.[0]?.muxing).toEqual({
			kind: "PROGRESSIVE_TS",
			startOffset: 0,
		});
	});

	it("what is typed is what the plan carries", async () => {
		const latest = renderHarness(stateWith(undefined));
		await userEvent.selectOptions(kindSelect(), "PROGRESSIVE_TS");
		await userEvent.type(screen.getByLabelText("Filename"), "movie.ts");
		await userEvent.type(screen.getByLabelText("Segment length (s)"), "8");
		await userEvent.type(screen.getByLabelText("Start offset (s)"), "0");
		expect(buildPlan(latest.state).muxings).toEqual([
			{
				key: "v360",
				kind: "PROGRESSIVE_TS",
				streamKey: "v360",
				filename: "movie.ts",
				segmentLength: 8,
				startOffset: 0,
				destination: expect.objectContaining({ path: "video/360p" }),
			},
		]);
	});

	it("clearing a number hands the choice back to the encoder", async () => {
		const latest = renderHarness(
			stateWith({ kind: "PROGRESSIVE_TS", segmentLength: 8, startOffset: 10 }),
		);
		await userEvent.clear(screen.getByLabelText("Segment length (s)"));
		await userEvent.clear(screen.getByLabelText("Start offset (s)"));
		const [muxing] = buildPlan(latest.state).muxings;
		expect(muxing).not.toHaveProperty("segmentLength");
		expect(muxing).not.toHaveProperty("startOffset");
	});
});

describe("the audio that goes into the file", () => {
	it.each(
		FILE_KINDS,
	)("%s offers the picker, with a hint about a file rather than segments", (kind) => {
		render(fileRow(kind, {}, true));
		const picker = screen.getByLabelText(/Muxed-in audio/) as HTMLSelectElement;
		expect([...picker.options].map((o) => o.value)).toEqual(["", "a128"]);
		expect(
			screen.getByText(
				"The audio track written into this file together with the video.",
			),
		).toBeTruthy();
		// The streaming copy for this picker talks about segments and
		// EXT-X-MEDIA groups, neither of which a file has.
		expect(screen.queryByText(/travel INSIDE these segments/)).toBeNull();
	});

	it("the counterfactual — a segmented TS container keeps the streaming hint", () => {
		render(stateWith({ kind: "TS" }, oneAudio));
		expect(screen.getByText(/travel INSIDE these segments/)).toBeTruthy();
		expect(screen.queryByText(/written into this file/)).toBeNull();
	});

	it("says which track the file carries", () => {
		render(
			stateWith({ kind: "PROGRESSIVE_TS", muxedAudioKeys: ["a128"] }, oneAudio),
		);
		expect(screen.getByText("Carrying a128 inside this file.")).toBeTruthy();
		expect(screen.queryByText(/inside these segments/)).toBeNull();
	});

	it("the counterfactual — a segmented TS container keeps the streaming wording", () => {
		render(stateWith({ kind: "TS", muxedAudioKeys: ["a128"] }, oneAudio));
		expect(
			screen.getByText("Carrying a128 inside these segments."),
		).toBeTruthy();
		expect(screen.queryByText(/inside this file/)).toBeNull();
	});

	it("picking the track turns off the audio's own container, and the plan is one file", async () => {
		const latest = renderHarness(stateWith(undefined, oneAudio));
		await userEvent.selectOptions(kindSelect(), "PROGRESSIVE_TS");
		await userEvent.selectOptions(
			screen.getByLabelText(/Muxed-in audio/),
			"a128",
		);
		expect(
			(screen.getByLabelText(/Build one for this track/) as HTMLInputElement)
				.checked,
		).toBe(false);
		expect(buildPlan(latest.state).muxings).toEqual([
			expect.objectContaining({
				kind: "PROGRESSIVE_TS",
				streamKey: "v360",
				additionalStreamKeys: ["a128"],
				filename: "output.ts",
			}),
		]);
	});

	it("picking the Opus track for a WebM file does the same, and the track's row says where it went", async () => {
		const latest = renderHarness(stateWith(undefined, oneOpus, "VP9"));
		await userEvent.selectOptions(kindSelect(), "PROGRESSIVE_WEBM");
		await userEvent.type(screen.getByLabelText("Filename"), "movie.webm");
		await userEvent.selectOptions(
			screen.getByLabelText(/Muxed-in audio/),
			"a128",
		);
		expect(
			(screen.getByLabelText(/Build one for this track/) as HTMLInputElement)
				.checked,
		).toBe(false);
		// What an AAC track inside a .mov is told. The WebM row used to say
		// nothing here, because nothing could carry an Opus track.
		expect(
			screen.getByText(
				"No container of its own — this track ships only inside the video containers that carry it.",
			),
		).toBeTruthy();
		expect(buildPlan(latest.state).muxings).toEqual([
			expect.objectContaining({
				kind: "PROGRESSIVE_WEBM",
				streamKey: "v360",
				additionalStreamKeys: ["a128"],
				filename: "movie.webm",
			}),
		]);
		expect(buildPlan(latest.state).muxings[0]).not.toHaveProperty(
			"progressive",
		);
	});

	it.each(
		FILE_KINDS,
	)("the reconciler counts a %s file as a carrier", (kind) => {
		const state = fileRow(kind, { muxedAudioKeys: ["a128"] }, true);
		expect(reconcileAutomaticAudioPackaging(state)[0]?.muxing).toMatchObject({
			ownContainer: false,
			autoOwnContainer: true,
		});
	});

	it("…and not a kind that cannot hold audio, whatever keys it has stored", () => {
		// The keys outlive a kind change. Counting them here would switch off the
		// audio's only container for a WebM that carries nothing.
		const state = stateWith(
			{ kind: "WEBM", muxedAudioKeys: ["a128"] },
			oneAudio,
		);
		expect(
			reconcileAutomaticAudioPackaging(state)[0]?.muxing?.ownContainer,
		).toBeUndefined();
	});
});

describe("encryption is not offered on a file", () => {
	it.each(FILE_KINDS)("%s shows no encryption section", (kind) => {
		render(fileRow(kind));
		expect(screen.queryByText(/Encryption \/ DRM/)).toBeNull();
		expect(screen.queryByText("Add CENC")).toBeNull();
	});

	it("the counterfactual — a streaming container does", () => {
		render(stateWith({ kind: "FMP4" }));
		expect(screen.getByText(/Encryption \/ DRM \(0\)/)).toBeTruthy();
		expect(screen.getByText("Add CENC")).toBeTruthy();
	});

	it("a row left behind by a kind change stays on screen to be removed, with nothing to add", () => {
		// Hiding the section outright would leave the preview refusing the plan
		// (PLAN_DRM_MUXING_MISMATCH) with no control anywhere that could fix it.
		const onPatch = vi.fn();
		renderWithQuery(
			<MuxingsSection
				state={stateWith(
					{ kind: "PROGRESSIVE_TS" },
					{
						drm: [
							{
								kind: "FAIRPLAY",
								muxingKey: "v360",
								key: "fairplay",
								credentialId: "drm-credential",
								iv: "00000000000000000000000000000000",
								uri: "https://example.com/key",
							},
						],
					},
				)}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		expect(screen.getByText(/Encryption \/ DRM \(1\)/)).toBeTruthy();
		expect(screen.queryByText("Add CENC")).toBeNull();
		expect(screen.queryByText("Add FairPlay")).toBeNull();
	});
});
