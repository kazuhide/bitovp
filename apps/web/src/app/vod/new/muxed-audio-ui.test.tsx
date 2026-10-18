import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized, renderWithQuery } from "@/test/render";
import { DEFAULT_WIZARD_STATE, type WizardState } from "./build-plan";
import { MuxingsSection } from "./muxings-section";

/**
 * THE PICKER IS ON THE CARRIER — .
 *
 * A single "muxed into the video" select on the audio row could only broadcast
 * one track to every container of its kind. The owner rejected it on the case
 * that needs videoA←audioA, videoB←audioB, videoC←audioA, videoD←nothing, so
 * each video container now names the tracks it carries and each track says
 * whether it also ships standalone.
 *
 * Asserted on the rendered page: the last two defects this feature had were
 * both invisible to value-level tests.
 */

const state = (): WizardState =>
	({
		...DEFAULT_WIZARD_STATE,
		videos: [
			{ height: 360, bitrate: 800000, codec: "H264", muxing: { kind: "TS" } },
			{
				height: 720,
				bitrate: 2400000,
				codec: "H264",
				muxing: { kind: "FMP4" },
			},
		],
		audios: [
			{ codec: "AAC", bitrate: 128000, rate: 48000, muxing: { kind: "TS" } },
			{ codec: "AAC", bitrate: 64000, rate: 48000, muxing: { kind: "TS" } },
		],
	}) as WizardState;

function render(onPatch = vi.fn()) {
	renderLocalized(
		<MuxingsSection state={state()} credentials={[]} onPatch={onPatch} />,
	);
	return onPatch;
}

describe("a video container names the ONE track it carries", () => {
	it("offers every audio rendition, plus an explicit none", () => {
		render();
		const picker = screen.getByLabelText(/Muxed-in audio/) as HTMLSelectElement;
		expect([...picker.options].map((o) => o.value)).toEqual([
			"",
			"a128",
			"a64",
		]);
	});

	/**
	 * The owner's first report: checkboxes let two tracks into one container.
	 * A manifest references the CONTAINER, so the second is encoded, stored,
	 * delivered and unreachable. A select makes the state unaskable rather
	 * than merely discouraged.
	 */
	it("cannot hold two — selecting REPLACES rather than adds", async () => {
		// Starting from a state that ALREADY carries one is what makes this an
		// assertion. My first version selected twice against a mock `onPatch`
		// that discards the patch, so the component re-rendered from empty
		// state each time and an appending implementation passed it — the
		// mutation said SURVIVED and it was right.
		const onPatch = vi.fn();
		const carrying = {
			...state(),
			videos: [
				{
					height: 360,
					bitrate: 800000,
					codec: "H264",
					muxing: { kind: "TS", muxedAudioKeys: ["a128"] },
				},
			],
		} as WizardState;
		renderLocalized(
			<MuxingsSection state={carrying} credentials={[]} onPatch={onPatch} />,
		);
		await userEvent.selectOptions(
			screen.getByLabelText(/Muxed-in audio/) as HTMLSelectElement,
			"a64",
		);
		const patch = onPatch.mock.calls.at(-1)?.[0] as
			| { videos?: { muxing?: { muxedAudioKeys?: string[] } }[] }
			| undefined;
		expect(patch?.videos?.[0]?.muxing?.muxedAudioKeys).toEqual(["a64"]);
	});

	it("records the assignment on THAT container only", async () => {
		const onPatch = render();
		await userEvent.selectOptions(
			screen.getByLabelText(/Muxed-in audio/) as HTMLSelectElement,
			"a128",
		);
		const patch = onPatch.mock.calls.at(-1)?.[0] as
			| { videos?: { muxing?: { muxedAudioKeys?: string[] } }[] }
			| undefined;
		expect(patch?.videos?.[0]?.muxing?.muxedAudioKeys).toEqual(["a128"]);
		expect(patch?.videos?.[1]?.muxing?.muxedAudioKeys).toBeUndefined();
	});

	it("does not offer the picker on a container that cannot carry", () => {
		render();
		expect(screen.getAllByText(/Muxed-in audio/).length).toBe(1);
	});

	/**
	 * The owner's second report. Assign a track, then delete it from the
	 * ladder: the stored key outlives the rendition, and reading it RAW made
	 * the hint claim a track was being carried that no longer exists.
	 */
	it("does not count a key whose rendition was deleted from the ladder", () => {
		const stale = {
			...state(),
			videos: [
				{
					height: 360,
					bitrate: 800000,
					codec: "H264",
					// a64 was assigned and then removed from the ladder below.
					muxing: { kind: "TS", muxedAudioKeys: ["a64"] },
				},
			],
			audios: [
				{ codec: "AAC", bitrate: 128000, rate: 48000, muxing: { kind: "TS" } },
			],
		} as WizardState;
		renderLocalized(
			<MuxingsSection state={stale} credentials={[]} onPatch={vi.fn()} />,
		);
		const picker = screen.getByLabelText(/Muxed-in audio/) as HTMLSelectElement;
		expect(picker.value).toBe("");
		expect(screen.queryByText(/Carrying/)).toBeNull();
	});

	it("…and DOES say so when the rendition is still there", () => {
		// The counterfactual: a hint that never rendered would pass the arm
		// above while telling the operator nothing when it should.
		const live = {
			...state(),
			videos: [
				{
					height: 360,
					bitrate: 800000,
					codec: "H264",
					muxing: { kind: "TS", muxedAudioKeys: ["a128"] },
				},
			],
			audios: [
				{ codec: "AAC", bitrate: 128000, rate: 48000, muxing: { kind: "TS" } },
			],
		} as WizardState;
		renderLocalized(
			<MuxingsSection state={live} credentials={[]} onPatch={vi.fn()} />,
		);
		expect(screen.getAllByText(/Carrying a128/).length).toBeGreaterThan(0);
	});
});

describe("a track says whether it also ships standalone", () => {
	it("offers the toggle on every audio row, defaulting to on", () => {
		render();
		const toggles = screen.getAllByLabelText(/Build one for this track/);
		expect(toggles).toHaveLength(2);
		expect((toggles[0] as HTMLInputElement).checked).toBe(true);
	});

	it("warns that turning it off would drop an uncarried track", () => {
		// Nothing carries a128 in this state, so the honest hint is that the
		// container gets built anyway rather than that the choice took effect.
		render();
		expect(
			screen.getAllByText(/A container of its own/).length,
		).toBeGreaterThan(0);
	});
});

describe("bundled audio defaults", () => {
	function Harness({
		initial = {
			...state(),
			videos: state().videos.slice(0, 1),
			audios: state().audios.map(({ muxing, ...audio }) => audio),
		},
	}: {
		initial?: WizardState;
	}) {
		const [value, setValue] = useState(initial);
		return (
			<MuxingsSection
				state={value}
				credentials={[]}
				onPatch={(patch) => setValue((prev) => ({ ...prev, ...patch }))}
			/>
		);
	}
	it("turns off redundant audio packaging, allows explicit override, and restores it when unbundled", async () => {
		renderLocalized(<Harness />);
		const picker = screen.getByLabelText(/Muxed-in audio/);
		const own = screen.getAllByLabelText(
			/Build one for this track/,
		)[0] as HTMLInputElement;
		await userEvent.selectOptions(picker, "a128");
		expect(own.checked).toBe(false);
		await userEvent.selectOptions(picker, "");
		expect(own.checked).toBe(true);
		await userEvent.selectOptions(picker, "a128");
		expect(own.checked).toBe(false);
		await userEvent.click(own);
		expect(own.checked).toBe(true);
		await userEvent.selectOptions(picker, "");
		await userEvent.selectOptions(picker, "a128");
		expect(own.checked).toBe(true);
	});
	it("keeps audio packaging when another video output still needs separate audio", async () => {
		renderLocalized(<Harness initial={state()} />);
		await userEvent.selectOptions(
			screen.getByLabelText(/Muxed-in audio/),
			"a128",
		);
		expect(
			(
				screen.getAllByLabelText(
					/Build one for this track/,
				)[0] as HTMLInputElement
			).checked,
		).toBe(true);
	});
	it("preserves an explicit HLS audio group container", async () => {
		const initial = { ...state(), videos: state().videos.slice(0, 1) };
		const audio = initial.audios[0];
		if (!audio) throw new Error("Audio fixture missing");
		initial.audios[0] = {
			...audio,
			extras: {
				hlsMedia: { groupId: "english", name: "English", uri: "audio.m3u8" },
			},
		};
		renderLocalized(<Harness initial={initial} />);
		await userEvent.selectOptions(
			screen.getByLabelText(/Muxed-in audio/),
			"a128",
		);
		expect(
			(
				screen.getAllByLabelText(
					/Build one for this track/,
				)[0] as HTMLInputElement
			).checked,
		).toBe(true);
	});
	it("preserves a DRM-owned audio container", async () => {
		const initial: WizardState = {
			...state(),
			videos: state().videos.slice(0, 1),
			drm: [
				{
					kind: "FAIRPLAY",
					muxingKey: "a128",
					key: "fairplay",
					credentialId: "drm-credential",
					iv: "00000000000000000000000000000000",
					uri: "https://example.com/key",
				},
			],
		};
		renderWithQuery(<Harness initial={initial} />);
		await userEvent.selectOptions(
			screen.getByLabelText(/Muxed-in audio/),
			"a128",
		);
		expect(
			(
				screen.getAllByLabelText(
					/Build one for this track/,
				)[0] as HTMLInputElement
			).checked,
		).toBe(true);
	});
});
