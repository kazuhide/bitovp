import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readWizardDraft, writeWizardDraft } from "@/lib/wizard-draft";
import { renderLocalized as render } from "@/test/render";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { copiedHlsVideoUri } from "./hls-video-uri-copy";
import { HlsVideoUriField } from "./hls-video-uri-field";
import { evaluateWizardState, PlanPreview } from "./plan-preview";
import { addVodVideo } from "./rendition-copy";
import { RenditionPlacement } from "./rendition-editors";

const placement = {
	variantsPerAudioGroup: false,
	dashAdaptationSets: [],
	conflictingDashSetKeys: [],
};

function state() {
	const value = structuredClone(DEFAULT_WIZARD_STATE);
	value.name = "Synthetic playlist copy";
	value.accountId = "00000000-0000-4000-8000-000000000001";
	value.inputFiles = [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "synthetic",
			path: "input.mp4",
		},
	];
	value.output = {
		...value.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "synthetic",
		basePath: "output",
	};
	value.videos = [
		{
			height: 360,
			bitrate: 300000,
			extras: Object.assign({}, { hlsVariantUri: "main-video.m3u8" }),
		},
	];
	return value;
}

describe("video playlist URI form and persistence", () => {
	it("reserves concrete group filenames when copying a group pattern", () => {
		const uri = copiedHlsVideoUri(
			"main-{group}.m3u8",
			"copy",
			["video-copy-aac.m3u8"],
			["aac"],
		);
		expect(uri).toContain("{group}");
		expect(uri.replaceAll("{group}", "aac")).not.toBe("video-copy-aac.m3u8");
	});
	it("shows the Japanese video URI label", () => {
		render(
			<HlsVideoUriField
				id="ja-video-uri"
				value="main.m3u8"
				onChange={vi.fn()}
			/>,
			"ja",
		);
		expect(screen.getByLabelText("動画プレイリストURI")).toHaveValue(
			"main.m3u8",
		);
	});
	it("keeps Plan JSON available when a Per-Title override blocks YAML", () => {
		const value = state();
		const first = value.videos[0];
		if (!first) throw new Error("Missing video");
		first.extras = { ...first.extras, mode: "PER_TITLE_TEMPLATE" };
		const evaluation = evaluateWizardState(value);
		expect(
			evaluation.ok && evaluation.issues.map((issue) => issue.code),
		).toContain("PLAN_HLS_VIDEO_URI_PER_TITLE");
		render(<PlanPreview evaluation={evaluation} />);
		fireEvent.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(screen.getByTestId("plan-json")).toHaveTextContent(
			"main-video.m3u8",
		);
	});
	it("edits and clears a video filename without changing the other placement fields", () => {
		const onChange = vi.fn();
		const view = render(
			<RenditionPlacement
				idBase="uri"
				family="video"
				value={{ hlsVariantLabel: "sdr" }}
				placement={placement}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Video playlist URI"), {
			target: { value: "manual.m3u8" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			hlsVariantLabel: "sdr",
			hlsVariantUri: "manual.m3u8",
		});
		view.rerender(
			<RenditionPlacement
				idBase="uri"
				family="video"
				value={{ hlsVariantLabel: "sdr", hlsVariantUri: "manual.m3u8" }}
				placement={placement}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Video playlist URI"), {
			target: { value: "" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			hlsVariantLabel: "sdr",
			hlsVariantUri: undefined,
		});
	});
	it("does not offer a video URI override on audio placement", () => {
		render(
			<RenditionPlacement
				idBase="audio"
				family="audio"
				value={{}}
				placement={placement}
				onChange={vi.fn()}
			/>,
		);
		expect(
			screen.queryByLabelText("Video playlist URI"),
		).not.toBeInTheDocument();
	});
	it.each([
		"vod",
		"live",
	] as const)("preserves the optional filename in a %s local draft", (kind) => {
		const key = `synthetic-hls-uri-${kind}`;
		writeWizardDraft(key, kind, state(), 1);
		expect(readWizardDraft(key, kind)?.value.videos).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					extras: expect.objectContaining({ hlsVariantUri: "main-video.m3u8" }),
				}),
			]),
		);
		localStorage.removeItem(key);
	});
	it("copies explicit names independently and keeps the source name", () => {
		const value = state();
		Object.assign(value, addVodVideo(value, 0));
		Object.assign(value, addVodVideo(value, 0));
		const uris = value.videos.map((video) => video.extras?.hlsVariantUri);
		expect(uris[0]).toBe("main-video.m3u8");
		expect(new Set(uris).size).toBe(3);
		const plan = encodingPlanSchema.parse(buildPlan(value));
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});
	it("keeps copied filenames valid when a rendition key starts with punctuation", () => {
		const value = state();
		const first = value.videos[0];
		if (!first) throw new Error("Missing video");
		first.extras = { ...first.extras, key: "_manual" };
		Object.assign(value, addVodVideo(value, 0));
		expect(() => encodingPlanSchema.parse(buildPlan(value))).not.toThrow();
	});
	it("makes the Per-Title limit visible while allowing an existing override to be cleared", () => {
		const onChange = vi.fn();
		render(
			<HlsVideoUriField
				id="per-title-uri"
				perTitle
				value="remove-me.m3u8"
				onChange={onChange}
			/>,
		);
		expect(
			screen.getByText(
				/Individual video playlist filenames are unavailable for Per-Title/,
			),
		).toBeVisible();
		expect(screen.getByLabelText("Video playlist URI")).toBeEnabled();
		fireEvent.change(screen.getByLabelText("Video playlist URI"), {
			target: { value: "" },
		});
		expect(onChange).toHaveBeenCalledWith(undefined);
	});
});
