import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render, renderWithQuery } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { EncodingOptionsSection, LadderSection } from "./wizard-sections";

/**
 * : (a) the ladder-level stream-mode control writes EVERY video
 * rendition's mode at once (per-rendition select stays as the override; a
 * mixed ladder says Mixed instead of lying with either value); (b) the
 * define-and-attach gesture creates the plan-level DEINTERLACE resource AND
 * the rendition attachment in one click.
 */
function stateWith(videos: WizardState["videos"]): WizardState {
	return { ...DEFAULT_WIZARD_STATE, videos };
}

describe("ladder stream-mode control (ledger #119a)", () => {
	it("writes every video rendition's mode in one gesture", () => {
		const onPatch = vi.fn();
		render(
			<LadderSection
				state={stateWith([
					{ height: 720, bitrate: 3_000_000 },
					{ height: 1080, bitrate: 6_000_000 },
				])}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		const patch = onPatch.mock.calls.find((c) => c[0].videos)?.[0];
		expect(patch.videos).toHaveLength(2);
		for (const v of patch.videos) {
			expect(v.extras.mode).toBe("PER_TITLE_TEMPLATE");
			expect(v.bitrate).toBeNull();
		}
		expect(patch.startOptions).toEqual({
			perTitle: { h264: { autoRepresentations: true } },
		});
		expect(patch.timing).toBe("POST_ENCODING");
		const plan = buildPlan({ ...DEFAULT_WIZARD_STATE, ...patch });
		expect(plan.perTitle).toEqual({
			h264Configuration: { autoRepresentations: {} },
		});
		expect(plan.generation.timing).toBe("POST_ENCODING");
	});

	it("keeps tuning and other start options when enabling per-title for the chosen codec", () => {
		const onPatch = vi.fn();
		render(
			<LadderSection
				state={{
					...stateWith([{ codec: "H265", height: 720, bitrate: 300_000 }]),
					startOptions: {
						encodingMode: "THREE_PASS",
						perTitle: { h265: { minBitrate: 100_000 } },
					},
				}}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(onPatch.mock.lastCall?.[0].startOptions).toEqual({
			encodingMode: "THREE_PASS",
			perTitle: { h265: { minBitrate: 100_000, autoRepresentations: true } },
		});
	});

	it("back to Standard = mode undefined, the schema default", () => {
		const onPatch = vi.fn();
		render(
			<LadderSection
				state={stateWith([
					{
						height: 720,
						bitrate: null,
						extras: { mode: "PER_TITLE_TEMPLATE" },
					},
				])}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("radio", { name: "Standard" }));
		const patch = onPatch.mock.calls.find((c) => c[0].videos)?.[0];
		for (const v of patch.videos) {
			expect(v.extras.mode).toBeUndefined();
		}
	});

	it("per-rendition mode override applies the same safe defaults", () => {
		const onPatch = vi.fn();
		render(
			<LadderSection
				state={stateWith([{ height: 360, bitrate: 300_000 }])}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Stream mode"), {
			target: { value: "PER_TITLE_TEMPLATE" },
		});
		const patch = onPatch.mock.lastCall?.[0];
		expect(patch.videos[0].bitrate).toBeNull();
		expect(patch.startOptions.perTitle.h264).toEqual({
			autoRepresentations: true,
		});
		expect(patch.timing).toBe("POST_ENCODING");
	});

	it("a mixed ladder shows Mixed and checks NEITHER radio", () => {
		render(
			<LadderSection
				state={stateWith([
					{ height: 720, bitrate: 3_000_000 },
					{
						height: 1080,
						bitrate: null,
						extras: { mode: "PER_TITLE_TEMPLATE" },
					},
				])}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.getByText("Mixed")).toBeInTheDocument();
		expect(
			(screen.getByRole("radio", { name: "Standard" }) as HTMLInputElement)
				.checked,
		).toBe(false);
		expect(
			(screen.getByRole("radio", { name: "Per-Title" }) as HTMLInputElement)
				.checked,
		).toBe(false);
	});
});

describe("mixed-ladder Per-Title click preserves the FIXED variant (review-255 119-A1)", () => {
	it("STANDARD joins the family; an existing FIXED variant survives", () => {
		const onPatch = vi.fn();
		render(
			<LadderSection
				state={stateWith([
					{ height: 720, bitrate: 3_000_000 },
					{
						height: 1080,
						bitrate: 6_000_000,
						extras: {
							mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						},
					},
				])}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		const patch = onPatch.mock.calls.find((c) => c[0].videos)?.[0];
		expect(patch.videos[0].extras.mode).toBe("PER_TITLE_TEMPLATE");
		expect(patch.videos[1].extras.mode).toBe(
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		);
	});
});

describe("define-and-attach deinterlace (ledger #119b)", () => {
	it("one click creates the plan-level filter AND the rendition attachment", () => {
		const onPatch = vi.fn();
		render(
			<LadderSection
				state={stateWith([{ height: 720, bitrate: 3_000_000 }])}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(
			screen.getByText("Define a deinterlace filter and attach it"),
		);
		const filterPatch = onPatch.mock.calls.find((c) => c[0].filters)?.[0];
		expect(filterPatch.filters).toEqual([{ key: "din-1" }]);
		const videoPatch = onPatch.mock.calls.find((c) => c[0].videos)?.[0];
		expect(videoPatch.videos[0].extras.filters).toEqual([
			{ filterKey: "din-1", position: 0 },
		]);
	});
});

describe("account-gated HEVCv2 ladder", () => {
	it("hides HEVCv2 from ordinary accounts", () => {
		render(
			<LadderSection
				state={stateWith([{ codec: "H265", height: 720, bitrate: 1000000 }])}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("option", { name: "HEVCv2" })).toBeNull();
	});
	it("changes only the chosen rung and preserves legacy options for explicit validation", () => {
		const onPatch = vi.fn();
		render(
			<LadderSection
				hevcV2Available
				state={stateWith([
					{
						codec: "H265",
						height: 720,
						bitrate: 1000000,
						h265: { profile: "MAIN", rcLookahead: 30 },
					},
					{ codec: "H265", height: 360, bitrate: 300000 },
				])}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		const [codec] = screen.getAllByLabelText("Codec");
		if (!codec) throw new Error("codec control");
		fireEvent.change(codec, { target: { value: "H265V2" } });
		expect(onPatch.mock.lastCall?.[0].videos).toEqual([
			{
				codec: "H265V2",
				height: 720,
				bitrate: 1000000,
				h265: { profile: "MAIN", rcLookahead: 30 },
				encodingMode: "SMART_PASS",
			},
			{ codec: "H265", height: 360, bitrate: 300000 },
		]);
		expect(onPatch.mock.lastCall?.[0].internal.hevcV2.bcfVersion).toMatch(
			/^v2/,
		);
	});
	it("offers supported HEVCv2 controls without old H265 or HDR settings", () => {
		render(
			<LadderSection
				hevcV2Available
				state={stateWith([{ codec: "H265V2", height: 720, bitrate: 1000000 }])}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByText("Advanced HEVCv2"));
		expect(screen.getByLabelText("Frame rate (fps)")).toBeInTheDocument();
		expect(screen.getByLabelText("Pixel format")).toBeInTheDocument();
		expect(screen.queryByLabelText("Profile")).toBeNull();
		expect(screen.queryByText("HDR10")).toBeNull();
		expect(screen.getByRole("radio", { name: "Per-Title" })).toBeEnabled();
	});
});

it("switching Per-Title H265 to HEVCv2 preserves stream mode and fixed bitrate bounds", () => {
	const onPatch = vi.fn();
	const startOptions = { perTitle: { h265: { autoRepresentations: true } } };
	render(
		<LadderSection
			hevcV2Available
			state={{
				...stateWith([
					{
						codec: "H265",
						height: 720,
						bitrate: null,
						extras: {
							mode: "PER_TITLE_TEMPLATE",
							perTitleSettings: { minBitrate: 100000 },
						},
					},
				]),
				startOptions,
			}}
			credentials={[]}
			onPatch={onPatch}
		/>,
	);
	const [codec] = screen.getAllByLabelText("Codec");
	if (!codec) throw new Error("codec control");
	fireEvent.change(codec, { target: { value: "H265V2" } });
	const patch = onPatch.mock.lastCall?.[0];
	expect(patch.videos[0]).toMatchObject({
		codec: "H265V2",
		bitrate: null,
		extras: {
			mode: "PER_TITLE_TEMPLATE",
			perTitleSettings: { minBitrate: 100000 },
		},
	});
	expect(patch.startOptions).toBeUndefined();
	expect(
		buildPlan({ ...DEFAULT_WIZARD_STATE, startOptions, ...patch }).perTitle,
	).toEqual({
		h265V2Configuration: { autoRepresentations: {} },
	});
});

it("selects encoding mode per rendition and clears/disables job mode", () => {
	function Harness() {
		const [state, setState] = useState<WizardState>({
			...stateWith([{ codec: "H265", height: 720, bitrate: 1000000 }]),
			startOptions: { encodingMode: "TWO_PASS" },
		});
		return (
			<>
				<LadderSection
					state={state}
					credentials={[]}
					onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
				/>
				<EncodingOptionsSection
					state={state}
					onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
				/>
				<output data-testid="mode-state">
					{JSON.stringify(state.startOptions)}
				</output>
			</>
		);
	}
	renderWithQuery(<Harness />);
	const selects = screen.getAllByLabelText("Encoding mode");
	expect(selects).toHaveLength(2);
	const [rung, global] = selects;
	if (!rung || !global) throw new Error("mode controls");
	expect(global).toBeEnabled();
	expect(global).toHaveValue("TWO_PASS");
	fireEvent.change(rung, { target: { value: "SINGLE_PASS" } });
	expect(rung).toHaveValue("SINGLE_PASS");
	expect(global).toBeDisabled();
	expect(global).toHaveValue("");
	expect(screen.getByTestId("mode-state")).not.toHaveTextContent("TWO_PASS");
});
it("shows HEVCv2 SMART_PASS only on its codec and leaves the job mode blank", () => {
	const state = stateWith([{ codec: "H265V2", height: 720, bitrate: 1000000 }]);
	renderWithQuery(
		<>
			<LadderSection
				hevcV2Available
				state={state}
				credentials={[]}
				onPatch={vi.fn()}
			/>
			<EncodingOptionsSection state={state} onPatch={vi.fn()} />
		</>,
	);
	const [rung, global] = screen.getAllByLabelText("Encoding mode");
	expect(rung).toHaveValue("SMART_PASS");
	expect(global).toBeDisabled();
	expect(global).toHaveValue("");
});
it("disables job mode for the default H264 codec preset", () => {
	renderWithQuery(
		<EncodingOptionsSection state={DEFAULT_WIZARD_STATE} onPatch={vi.fn()} />,
	);
	expect(screen.getByLabelText("Encoding mode")).toBeDisabled();
	expect(screen.getByLabelText("Encoding mode")).toHaveValue("");
	expect(screen.getByLabelText("Encoding mode")).toHaveDisplayValue(
		"Use ladder encoding modes / presets",
	);
});

it("removing the H264 preset enables a job mode without adding a codec mode", () => {
	function Harness() {
		const [state, setState] = useState<WizardState>(
			stateWith([{ height: 720, bitrate: 1000000 }]),
		);
		const onPatch = (patch: Partial<WizardState>) =>
			setState((prev) => ({ ...prev, ...patch }));
		return (
			<>
				<LadderSection state={state} credentials={[]} onPatch={onPatch} />
				<EncodingOptionsSection state={state} onPatch={onPatch} />
				<output data-testid="built-plan">
					{JSON.stringify(buildPlan(state))}
				</output>
			</>
		);
	}
	renderWithQuery(<Harness />);
	fireEvent.click(screen.getByText("Advanced (H264)"));
	fireEvent.change(screen.getByLabelText("Preset configuration"), {
		target: { value: "" },
	});
	const global = screen.getAllByLabelText("Encoding mode")[1];
	if (!global) throw new Error("job mode");
	expect(global).toBeEnabled();
	fireEvent.change(global, { target: { value: "TWO_PASS" } });
	const plan = JSON.parse(screen.getByTestId("built-plan").textContent ?? "{}");
	expect(plan.generation.encodingMode).toBe("TWO_PASS");
	expect(plan.renditions[0].presetConfiguration).toBeNull();
	expect(plan.renditions[0].encodingMode).toBeUndefined();
	fireEvent.change(screen.getByLabelText("Preset configuration"), {
		target: { value: "VOD_STANDARD" },
	});
	expect(global).toBeDisabled();
	expect(global).toHaveDisplayValue("Use ladder encoding modes / presets");
	const withPreset = JSON.parse(
		screen.getByTestId("built-plan").textContent ?? "{}",
	);
	expect(withPreset.generation.encodingMode).toBeUndefined();
	expect(withPreset.renditions[0].presetConfiguration).toBe("VOD_STANDARD");
});
