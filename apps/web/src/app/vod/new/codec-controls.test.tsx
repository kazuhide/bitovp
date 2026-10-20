import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import {
	mergeWizardDraft,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import { renderWithQuery as render } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardH264Options,
} from "./build-plan";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";
import { addVodVideo } from "./rendition-copy";
import { H264AdvancedEditor, H265AdvancedEditor } from "./rendition-editors";

afterEach(() => localStorage.clear());

it.each([
	"H264",
	"H265",
] as const)("edits and clears %s CRF without losing zero-valued siblings", (codec) => {
	function Editor() {
		const [value, setValue] = useState<
			Pick<WizardH264Options, "crf" | "minBitrate">
		>({
			crf: 23,
			minBitrate: 0,
		});
		return codec === "H264" ? (
			<H264AdvancedEditor idBase="codec" value={value} onChange={setValue} />
		) : (
			<H265AdvancedEditor
				idBase="codec"
				value={value}
				onChange={setValue}
				visionMetadataKeys={[]}
			/>
		);
	}
	render(<Editor />);
	const crf = screen.getByLabelText("Constant rate factor (0–51)");
	fireEvent.change(crf, { target: { value: "0" } });
	expect(crf).toHaveValue(0);
	expect(screen.getByLabelText("Min bitrate (bps)")).toHaveValue(0);
	fireEvent.change(crf, { target: { value: "" } });
	expect(crf).toHaveValue(null);
	expect(screen.getByLabelText("Min bitrate (bps)")).toHaveValue(0);
});

it.each([
	"H264",
	"H265",
] as const)("preserves %s controls through import, draft and isolated copy", (codec) => {
	const raw = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/plan/__fixtures__/av1-fmp4-dash-hls.plan.json",
			),
			"utf8",
		),
	);
	const controls = {
		crf: 0,
		minBitrate: 0,
		maxBitrate: 900000,
		bufsize: 1800000,
	};
	raw.renditions = raw.renditions.map(
		(r: {
			codec: string;
			key: string;
			ingestKey: string;
			height: number;
			bitrate: number;
		}) =>
			r.codec === "AV1"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						height: r.height,
						bitrate: r.bitrate,
						codec,
						...controls,
					}
				: r,
	);
	const plan = encodingPlanSchema.parse(raw);
	expect(tryImportPresetIntoWizard(plan).ok).toBe(true);
	const state = planToWizardState(plan);
	writeWizardDraft("codec", "vod", state, 2);
	const draft = readWizardDraft("codec", "vod");
	if (!draft) throw new Error("Missing draft");
	const restored = mergeWizardDraft(
		structuredClone(DEFAULT_WIZARD_STATE),
		draft.value,
		"vod",
	);
	const original = restored.videos[0];
	const copied = { ...restored, ...addVodVideo(restored, 0) };
	const duplicate = copied.videos.at(-1);
	if (!original || !duplicate) throw new Error("Missing video");
	const field = codec === "H264" ? "h264" : "h265";
	expect(duplicate[field]).toMatchObject(controls);
	expect(duplicate[field]).not.toBe(original[field]);
	const built = encodingPlanSchema.parse(buildPlan(copied));
	expect(built.renditions.filter((r) => r.codec === codec)).toHaveLength(3);
	for (const r of built.renditions.filter((r) => r.codec === codec))
		expect(r).toMatchObject(controls);
});
