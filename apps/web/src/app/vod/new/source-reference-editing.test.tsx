import { compilePlan, encodingPlanSchema, validatePlan } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	remapEncodingKeyRefs,
	type WizardState,
} from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";
import { SourcesSection } from "./sources-section";
import { LadderSection } from "./wizard-sections";

function mount(
	initial: WizardState,
	ladder = false,
	locale: "en" | "ja" = "en",
) {
	function Harness() {
		const [state, setState] = useState(initial);
		const patch = (partial: Partial<WizardState>) =>
			setState((prev) => ({ ...prev, ...partial }));
		return (
			<>
				{ladder ? (
					<LadderSection state={state} credentials={[]} onPatch={patch} />
				) : (
					<SourcesSection state={state} onPatch={patch} />
				)}
				<output data-testid="state">{JSON.stringify(state)}</output>
			</>
		);
	}
	return render(<Harness />, locale);
}
it("adds a trim from ordinary video beside a named HDR video", () => {
	mount({
		...DEFAULT_WIZARD_STATE,
		sources: {
			hdr10PlusStreams: [
				{
					key: "video",
					videoInputFile: "main",
					metadataInputPath: "metadata.json",
					selectionMode: "AUTO",
				},
			],
		},
	});
	fireEvent.click(screen.getByText("Add input clip"));
	const trim = stateNow().sources?.trimmingStreams?.[0];
	expect(trim?.sourceKey).toBe("video-input-1");
	const source = document.getElementById("wz-trim-0-src") as HTMLSelectElement;
	expect(Array.from(source.options, (o) => o.value)).toContain(trim?.sourceKey);
	expect(buildPlan(stateNow()).ingest).toContainEqual(
		expect.objectContaining({
			key: trim?.sourceKey,
			selectionMode: "VIDEO_RELATIVE",
		}),
	);
});
it("keeps a referenced HDR source when its removal would silently switch the rendition to ordinary video", () => {
	mount({
		...DEFAULT_WIZARD_STATE,
		videos: [
			{
				height: 720,
				bitrate: 1000000,
				codec: "H265",
				extras: { source: "video-input-1" },
			},
		],
		sources: {
			hdr10PlusStreams: ["video", "video-input-1"].map((key, i) => ({
				key,
				videoInputFile: "main",
				metadataInputPath: `hdr${i}.json`,
				selectionMode: "AUTO",
			})),
		},
	});
	const remove = screen.getByRole("button", {
		name: "Remove stream wz-stream-hdr10Plus-1",
		hidden: true,
	});
	expect(remove).toBeDisabled();
	fireEvent.click(remove);
	expect(stateNow().sources?.hdr10PlusStreams?.[1]?.metadataInputPath).toBe(
		"hdr1.json",
	);
	expect(
		buildPlan(stateNow()).ingest?.some(
			(stream) => stream.key === "video-input-1",
		),
	).toBe(false);
});
it("keeps a named HDR source bound when another HDR source is added", () => {
	mount({
		...DEFAULT_WIZARD_STATE,
		videos: [
			{
				height: 720,
				bitrate: 1000000,
				codec: "H265",
				extras: { source: "hdr10plus1" },
			},
		],
		sources: {
			hdr10PlusStreams: [
				{
					key: "hdr10plus1",
					videoInputFile: "main",
					metadataInputPath: "original.json",
					selectionMode: "AUTO",
				},
			],
		},
	});
	const remove = screen.getByRole("button", {
		name: "Remove stream wz-stream-hdr10Plus-0",
		hidden: true,
	});
	expect(remove).toBeDisabled();
	fireEvent.click(remove);
	fireEvent.click(screen.getByText("Add HDR10+ video"));
	expect(stateNow().sources?.hdr10PlusStreams?.map((row) => row.key)).toEqual([
		"hdr10plus1",
		"hdr10plus2",
	]);
	expect(stateNow().sources?.hdr10PlusStreams?.[0]?.metadataInputPath).toBe(
		"original.json",
	);
	expect(stateNow().videos[0]?.extras?.source).toBe("hdr10plus1");
});
const stateNow = () =>
	JSON.parse(screen.getByTestId("state").textContent ?? "{}") as WizardState;
const base: WizardState = {
	...DEFAULT_WIZARD_STATE,
	videos: [
		{
			height: 720,
			bitrate: 1000000,
			extras: {
				source: "trim1",
				filters: [{ filterKey: "deint1", position: 0 }],
			},
		},
	],
	filters: [{ key: "deint1" }],
	sources: {
		audioMixStreams: [
			{
				key: "mix",
				audioMixChannels: [
					{
						sourceKey: "trim1",
						outputChannelType: "FRONT_LEFT",
						sourceChannels: [{ type: "FRONT_LEFT" }],
					},
				],
			},
		],
		trimmingStreams: [
			{ key: "trim1", kind: "TIME_BASED", sourceKey: "video", duration: 10 },
		],
		concatenationStreams: [
			{
				key: "concat1",
				sources: [{ sourceKey: "trim1", position: 0, isMain: true }],
			},
		],
	},
};
describe("source resource editing", () => {
	it.each([
		"en",
		"ja",
	] as const)("edits and clears an imported encoder override in the existing owner row in %s", (locale) => {
		const plan = encodingPlanSchema.parse(
			buildPlan({
				...DEFAULT_WIZARD_STATE,
				name: "Owner version",
				timing: "POST_ENCODING",
				inputFiles: [
					{
						key: "main",
						inputKey: "main",
						kind: "S3",
						credentialId: "00000000-0000-4000-8000-000000000001",
						bucket: "input",
						path: "source.mp4",
					},
				],
				output: {
					...DEFAULT_WIZARD_STATE.output,
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "output",
					basePath: "owner-version",
				},
				videos: [
					{
						codec: "AV1",
						height: 720,
						bitrate: 1000000,
						av1: { detailPreservationMode: "ON" },
						extras: { encodingKey: "owner" },
					},
				],
				audios: [],
				sources: {
					encodings: [
						{ key: "owner", name: "Owner", encoderVersion: "2.287.0" },
					],
					implicitEncodingKeys: { video: "owner" },
				},
			}),
		);
		mount(planToWizardState(plan), false, locale);
		const input = screen.getByLabelText(
			locale === "ja" ? "エンコーダバージョン" : "Encoder version",
		);
		expect(input).toHaveValue("2.287.0");
		expect(input).toHaveAttribute(
			"placeholder",
			locale === "ja" ? "(プランの既定)" : "(plan default)",
		);
		const currentPlan = () => encodingPlanSchema.parse(buildPlan(stateNow()));
		const errors = () =>
			validatePlan(currentPlan()).filter((issue) => issue.level === "error");
		expect(errors()).toEqual([
			expect.objectContaining({ code: "PLAN_AV1_DETAIL_PRESERVATION_VERSION" }),
		]);
		fireEvent.change(input, { target: { value: "2.291.0" } });
		expect(stateNow().sources?.encodings?.[0]?.encoderVersion).toBe("2.291.0");
		expect(currentPlan().encodings?.[0]?.encoderVersion).toBe("2.291.0");
		expect(errors()).toEqual([]);
		fireEvent.change(input, { target: { value: "" } });
		expect(input).toHaveValue("");
		expect(currentPlan().encodings?.[0]).not.toHaveProperty("encoderVersion");
		expect(errors()).toEqual([]);
		expect(
			compilePlan(currentPlan()).find((op) => op.kind === "CREATE_ENCODING")
				?.payload.encoderVersion,
		).toBe("2.294.0");
	});

	it("keeps encoder override controls out of ordinary single-encoding sources", () => {
		mount(base);
		expect(screen.queryByLabelText("Encoder version")).not.toBeInTheDocument();
	});

	it("keeps the ordinary track and the named clip separate when a copied clip releases its reserved key", () => {
		mount({
			...DEFAULT_WIZARD_STATE,
			videos: [{ height: 720, bitrate: 1000000, extras: { source: "video" } }],
			sources: {
				trimmingStreams: [
					{
						kind: "TIME_BASED",
						key: "video",
						sourceKey: "video-input-1",
						duration: 3,
					},
				],
				concatenationStreams: [
					{
						key: "cut",
						sources: [{ sourceKey: "video", position: 0, isMain: true }],
					},
				],
			},
		});
		const key = document.getElementById("wz-trim-0-key") as HTMLInputElement;
		fireEvent.change(key, { target: { value: "video-input-1" } });
		fireEvent.blur(key);
		expect(stateNow().sources?.trimmingStreams?.[0]?.key).toBe("video");
		fireEvent.change(key, { target: { value: "picture-cut" } });
		fireEvent.blur(key);
		const saved = stateNow();
		expect(saved.videos[0]?.extras?.source).toBe("picture-cut");
		expect(
			saved.sources?.concatenationStreams?.[0]?.sources[0]?.sourceKey,
		).toBe("picture-cut");
		expect(saved.sources?.trimmingStreams?.[0]?.sourceKey).toBe("video");
		expect(buildPlan(saved).ingest).toContainEqual(
			expect.objectContaining({
				key: "video",
				selectionMode: "VIDEO_RELATIVE",
			}),
		);
	});

	it("allows a complete trim rename without losing focus and preserves references", async () => {
		const user = userEvent.setup();
		mount(base);
		const key = document.getElementById("wz-trim-0-key") as HTMLInputElement;
		key.closest("details")?.setAttribute("open", "");
		await user.clear(key);
		await user.type(key, "scene-a");
		expect(key).toHaveFocus();
		expect(key).toHaveValue("scene-a");
		fireEvent.blur(key);
		expect(stateNow().videos[0]?.extras?.source).toBe("scene-a");
		expect(
			stateNow().sources?.audioMixStreams?.[0]?.audioMixChannels[0]?.sourceKey,
		).toBe("scene-a");
		expect(
			stateNow().sources?.concatenationStreams?.[0]?.sources[0]?.sourceKey,
		).toBe("scene-a");
	});
	it.each([
		"audio",
		"video",
	])("keeps a trim rename from capturing implicit %s", (name) => {
		mount(base);
		const key = document.getElementById("wz-trim-0-key") as HTMLInputElement;
		fireEvent.change(key, { target: { value: name } });
		fireEvent.blur(key);
		expect(key).toHaveValue("trim1");
		expect(stateNow().sources?.trimmingStreams?.[0]?.key).toBe("trim1");
		expect(stateNow().sources?.trimmingStreams?.[0]?.sourceKey).toBe("video");
	});
	it("renames a concatenation source while preserving rendition references", async () => {
		const user = userEvent.setup();
		mount({
			...base,
			videos: [
				{ height: 720, bitrate: 1000000, extras: { source: "concat1" } },
			],
		});
		const key = document.getElementById("wz-concat-0-key") as HTMLInputElement;
		key.closest("details")?.setAttribute("open", "");
		await user.clear(key);
		await user.type(key, "joined-scenes");
		fireEvent.blur(key);
		expect(stateNow().sources?.concatenationStreams?.[0]?.key).toBe(
			"joined-scenes",
		);
		expect(stateNow().videos[0]?.extras?.source).toBe("joined-scenes");
	});
	it("renames filter definitions without detaching their consumers", () => {
		mount(base, true);
		const key = document.getElementById("wz-flt-0-key") as HTMLInputElement;
		fireEvent.change(key, { target: { value: "custom" } });
		fireEvent.blur(key);
		expect(stateNow().videos[0]?.extras?.filters?.[0]?.filterKey).toBe(
			"custom",
		);
	});
	it("shows missing sources and filters instead of claiming the implicit/default selection", () => {
		mount({ ...base, sources: {}, filters: [] }, true);
		expect(document.getElementById("wz-v-0-x-source")).toHaveValue("trim1");
		expect(document.getElementById("wz-v-0-x-flt-0")).toHaveValue("deint1");
	});
	it("keeps trim and concat encoding assignments consistent with partition renames and removal", () => {
		const state = {
			...base,
			sources: {
				...base.sources,
				trimmingStreams: base.sources?.trimmingStreams?.map((row) => ({
					...row,
					encodingKey: "enc1",
				})),
				concatenationStreams: base.sources?.concatenationStreams?.map(
					(row) => ({ ...row, encodingKey: "enc1" }),
				),
			},
		};
		for (const to of ["renamed", undefined]) {
			const patch = remapEncodingKeyRefs(state, "enc1", to);
			expect(patch.sources?.trimmingStreams?.[0]?.encodingKey).toBe(to);
			expect(patch.sources?.concatenationStreams?.[0]?.encodingKey).toBe(to);
		}
	});
	it("new streams use the imported primary file key", () => {
		mount({
			...base,
			inputFiles: [
				{
					key: "imported-main",
					inputKey: "main",
					kind: "S3",
					credentialId: "",
					bucket: "",
					path: "",
				},
			],
		});
		fireEvent.click(screen.getByText("Add ingest track"));
		expect(stateNow().sources?.tracks?.[0]?.inputFile).toBe("imported-main");
	});
});

it("new resource keys avoid existing keys after deletion", () => {
	const { unmount } = mount({
		...base,
		sources: { encodings: [{ key: "enc2", name: "encoding 2" }] },
	});
	fireEvent.click(screen.getByText("Add encoding"));
	const encodings = stateNow().sources?.encodings ?? [];
	expect(new Set(encodings.map((row) => row.key)).size).toBe(2);
	unmount();
	mount({ ...base, filters: [{ key: "deint2" }] }, true);
	fireEvent.click(screen.getByText("Add filter"));
	const filters = stateNow().filters ?? [];
	expect(new Set(filters.map((row) => row.key)).size).toBe(2);
});
it("missing separate audio and subtitle files remain visibly selected", () => {
	const { unmount } = mount({ ...base, audioInputFile: "removed" });
	expect(document.getElementById("wz-implicit-audio")).toHaveValue("removed");
	unmount();
	mount({ ...base, subtitles: [{ source: "removed" }] }, true);
	expect(document.getElementById("wz-s-0-src")).toHaveValue("removed");
});
it("duplicate target names do not rewrite references to another resource", () => {
	mount({
		...base,
		sources: {
			...base.sources,
			trimmingStreams: [
				...(base.sources?.trimmingStreams ?? []),
				{ key: "existing", kind: "TIME_BASED", sourceKey: "video" },
			],
		},
	});
	const key = document.getElementById("wz-trim-0-key") as HTMLInputElement;
	fireEvent.change(key, { target: { value: "existing" } });
	fireEvent.blur(key);
	expect(stateNow().videos[0]?.extras?.source).toBe("trim1");
});

it("type changes rename default filter keys without breaking attached renditions", () => {
	mount(
		{
			...base,
			filters: [{ key: "crop", kind: "CROP", left: 0 }],
			videos: [
				{
					height: 720,
					bitrate: 1000000,
					extras: { filters: [{ filterKey: "crop", position: 3 }] },
				},
			],
		},
		true,
	);
	fireEvent.change(screen.getByLabelText("Filter type"), {
		target: { value: "ROTATE" },
	});
	expect(screen.getByLabelText("Filter key")).toHaveValue("rotate");
	expect(stateNow().videos[0]?.extras?.filters).toEqual([
		{ filterKey: "rotate", position: 3 },
	]);
	fireEvent.change(screen.getByLabelText("Filter type"), {
		target: { value: "TEXT" },
	});
	expect(screen.getByLabelText("Filter key")).toHaveValue("text");
	expect(stateNow().videos[0]?.extras?.filters?.[0]?.filterKey).toBe("text");
});

it("allocates a free type-based key and preserves manually named keys across remounts", () => {
	const view = mount(
		{
			...base,
			filters: [
				{ key: "deint1" },
				{ key: "crop", kind: "CROP", left: 0 },
				{ key: "crop2", kind: "CROP", left: 0 },
			],
		},
		true,
	);
	fireEvent.change(
		screen.getByLabelText("Filter type", { selector: "#wz-flt-0-kind" }),
		{
			target: { value: "CROP" },
		},
	);
	expect(screen.getAllByLabelText("Filter key")[0]).toHaveValue("crop3");
	const key = screen.getByLabelText("Filter key", {
		selector: "#wz-flt-0-key",
	});
	// A deliberate type-looking name remains manual, even after leaving Ladder.
	fireEvent.change(key, { target: { value: "crop9" } });
	fireEvent.blur(key);
	const saved = stateNow();
	view.unmount();
	mount(saved, true);
	fireEvent.change(
		screen.getByLabelText("Filter type", { selector: "#wz-flt-0-kind" }),
		{
			target: { value: "TEXT" },
		},
	);
	expect(screen.getAllByLabelText("Filter key")[0]).toHaveValue("crop9");
	expect(stateNow().videos[0]?.extras?.filters?.[0]?.filterKey).toBe("crop9");
});

it("keeps a copied descriptive filter key when the type changes", () => {
	mount(
		{
			...base,
			filters: [
				{ key: "title-overlay", kind: "TEXT", text: "Title", x: "0", y: "0" },
			],
		},
		true,
	);
	fireEvent.change(screen.getByLabelText("Filter type"), {
		target: { value: "WATERMARK" },
	});
	expect(screen.getByLabelText("Filter key")).toHaveValue("title-overlay");
});
