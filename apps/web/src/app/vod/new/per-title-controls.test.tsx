import { compilePlan, encodingPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { EncodingOptionsSection, LadderSection } from "./wizard-sections";

const initialState: WizardState = {
	...DEFAULT_WIZARD_STATE,
	name: "Per-Title controls test",
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "input",
			path: "video.mp4",
			name: "Input",
		},
	],
	output: {
		...DEFAULT_WIZARD_STATE.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "output",
	},
};

function Harness({ initial }: { initial: WizardState }) {
	const [state, setState] = useState(initial);
	const onPatch = (patch: Partial<WizardState>) =>
		setState((previous) => ({ ...previous, ...patch }));
	return (
		<>
			<LadderSection
				state={state}
				credentials={[]}
				onPatch={onPatch}
				hevcV2Available
			/>
			<EncodingOptionsSection state={state} onPatch={onPatch} />
			<output data-testid="plan">{JSON.stringify(buildPlan(state))}</output>
		</>
	);
}

function renderedPlan() {
	return JSON.parse(screen.getByTestId("plan").textContent ?? "{}");
}

describe("Per-Title authoring through the VOD wizard", () => {
	it.each([
		"h264",
		"h265",
		"vp9",
		"av1",
	] as const)("edits and clears %s minBitrateStepSize in the START request", (codec) => {
		renderWithQuery(
			<Harness
				initial={{
					...initialState,
					videos: [
						{
							codec: codec.toUpperCase() as "H264" | "H265" | "VP9" | "AV1",
							height: 1080,
							bitrate: null,
							extras: { mode: "PER_TITLE_TEMPLATE" },
						},
					],
					startOptions: {
						perTitle: {
							[codec]: { maxBitrateStepSize: 2, autoRepresentations: true },
						},
					},
				}}
			/>,
		);
		fireEvent.click(screen.getByText("Per-Title configuration"));
		fireEvent.click(screen.getByText(`${codec}Configuration (on)`));
		const minimum = screen.getByLabelText("Min bitrate step size");
		expect(minimum).toHaveValue(null);
		fireEvent.change(minimum, { target: { value: "1.5" } });
		expect(minimum).toHaveValue(1.5);
		const plan = encodingPlanSchema.parse(renderedPlan());
		const start = compilePlan(plan).find(
			(step) => step.kind === "START_ENCODING",
		);
		expect(start?.payload).toMatchObject({
			perTitle: {
				[`${codec}Configuration`]: {
					minBitrateStepSize: 1.5,
					maxBitrateStepSize: 2,
				},
			},
		});
		fireEvent.change(minimum, { target: { value: "" } });
		const cleared = compilePlan(encodingPlanSchema.parse(renderedPlan())).find(
			(step) => step.kind === "START_ENCODING",
		);
		expect(JSON.stringify(cleared?.payload)).not.toContain(
			"minBitrateStepSize",
		);
	});

	it("selects a fixed-resolution template and emits it to CREATE_STREAM", () => {
		renderWithQuery(
			<Harness
				initial={{
					...initialState,
					videos: [{ height: 1080, bitrate: 6_000_000 }],
				}}
			/>,
		);
		const mode = screen.getByLabelText("Stream mode");
		expect(
			Array.from((mode as HTMLSelectElement).options).find(
				(option) => option.value === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			),
		).toBeEnabled();
		fireEvent.change(mode, {
			target: { value: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" },
		});
		expect(mode).toHaveValue("PER_TITLE_TEMPLATE_FIXED_RESOLUTION");
		const plan = renderedPlan();
		expect(plan.renditions[0]).toMatchObject({
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			height: 1080,
			bitrate: null,
		});
		expect(plan.perTitle.h264Configuration.autoRepresentations).toEqual({});
		expect(plan.generation.timing).toBe("POST_ENCODING");
		const stream = compilePlan(encodingPlanSchema.parse(plan)).find(
			(step) => step.kind === "CREATE_STREAM",
		);
		expect(stream?.payload).toMatchObject({
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		});
	});

	it.each([
		"h264",
		"h265",
		"vp9",
		"av1",
	] as const)("sets %s fixedResolutionAndBitrateConfiguration and emits it to START_ENCODING", (codec) => {
		renderWithQuery(
			<Harness
				initial={{
					...initialState,
					videos: [
						{
							codec: codec.toUpperCase() as "H264" | "H265" | "VP9" | "AV1",
							height: 1080,
							bitrate: null,
							extras: {
								mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
								perTitleSettings: {
									minBitrate: 6_000_000,
									maxBitrate: 6_000_000,
								},
							},
						},
					],
					startOptions: {
						perTitle: {
							[codec]: { minBitrate: 100_000, autoRepresentations: true },
						},
					},
				}}
			/>,
		);
		fireEvent.click(screen.getByText("Per-Title configuration"));
		fireEvent.click(screen.getByText(`${codec}Configuration (on)`));
		fireEvent.click(screen.getByText("fixedResolutionAndBitrateConfiguration"));
		fireEvent.change(screen.getByLabelText("Forced rendition above highest"), {
			target: { value: "0" },
		});
		fireEvent.change(screen.getByLabelText("Forced rendition factor"), {
			target: { value: "1.5" },
		});
		const mode = screen.getByLabelText("Forced rendition mode");
		expect(
			Array.from((mode as HTMLSelectElement).options, (option) => option.value),
		).toEqual(["", "LAST_CALCULATED_BITRATE", "MINIMUM", "MAXIMUM", "AVERAGE"]);
		fireEvent.change(mode, { target: { value: "MAXIMUM" } });
		const configuration = {
			forcedRenditionAboveHighestFixedRepresentation: 0,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode: "MAXIMUM",
		};
		const plan = renderedPlan();
		expect(plan.perTitle[`${codec}Configuration`]).toMatchObject({
			minBitrate: 100_000,
			autoRepresentations: {},
			fixedResolutionAndBitrateConfiguration: configuration,
		});
		const start = compilePlan(encodingPlanSchema.parse(plan)).find(
			(step) => step.kind === "START_ENCODING",
		);
		expect(start?.payload).toMatchObject({
			perTitle: {
				[`${codec}Configuration`]: {
					fixedResolutionAndBitrateConfiguration: configuration,
				},
			},
		});
	});
});

it("authors native HEVCv2 target QP and compiles all template settings after import", () => {
	renderWithQuery(
		<Harness
			initial={{
				...initialState,
				encoderVersion: "LATEST",
				timing: "POST_ENCODING",
				internal: { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } },
				videos: [
					{
						codec: "H265V2",
						height: 1080,
						bitrate: null,
						extras: {
							mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
							perTitleSettings: { minBitrate: 5000000, maxBitrate: 5000000 },
						},
					},
				],
				startOptions: {
					perTitle: {
						h265: { autoRepresentations: true, minBitrateStepSize: 1.25 },
					},
				},
			}}
		/>,
	);
	expect(screen.getByRole("radio", { name: "Per-Title" })).toBeEnabled();
	expect(screen.getByLabelText("Stream mode")).toBeEnabled();
	fireEvent.click(screen.getByText("Per-Title configuration"));
	fireEvent.click(screen.getByText("h265V2Configuration (on)"));
	expect(screen.queryByLabelText("Target quality CRF")).toBeNull();
	expect(screen.queryByLabelText("Codec bufsize factor")).toBeNull();
	fireEvent.change(screen.getByLabelText("Target quality QP"), {
		target: { value: "20" },
	});
	const ops = compilePlan(encodingPlanSchema.parse(renderedPlan()));
	expect(
		ops.find((step) => step.kind === "START_ENCODING")?.payload.perTitle,
	).toEqual({
		h265V2Configuration: {
			targetQualityQp: 20,
			minBitrateStepSize: 1.25,
			autoRepresentations: {},
		},
	});
	expect(
		ops.find((step) => step.kind === "CREATE_STREAM")?.payload,
	).toMatchObject({
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		perTitleSettings: {
			fixedResolutionAndBitrateSettings: {
				minBitrate: 5000000,
				maxBitrate: 5000000,
			},
		},
	});
});
