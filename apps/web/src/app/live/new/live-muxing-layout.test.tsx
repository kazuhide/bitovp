import { liveChannelPlanSchema } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { mergeWizardDraft, projectWizardDraft } from "@/lib/wizard-draft";
import { renderLocalized, renderWithQuery } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { LiveLadderSection } from "./ladder-section";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";
import { LivePackagingSection } from "./packaging-section";

function Harness({ initial }: { initial: LiveWizardState }) {
	const [state, setState] = useState(initial);
	const [packaging, setPackaging] = useState(false);
	const onPatch = (patch: Partial<LiveWizardState>) =>
		setState((current) => ({ ...current, ...patch }));
	return (
		<>
			<button type="button" onClick={() => setPackaging(!packaging)}>
				Change step
			</button>
			{packaging ? (
				<LivePackagingSection
					state={state}
					credentials={[]}
					onPatch={onPatch}
				/>
			) : (
				<LiveLadderSection state={state} onPatch={onPatch} />
			)}
			<output data-testid="state">{JSON.stringify(state)}</output>
		</>
	);
}
function current(): LiveWizardState {
	return JSON.parse(screen.getByTestId("state").textContent ?? "{}");
}
function field(id: string): HTMLElement {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing ${id}`);
	return element;
}
function fixture(): LiveWizardState {
	const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	state.name = "Packaging example";
	state.accountId = "33333333-3333-4333-8333-333333333333";
	state.output.credentialId = "44444444-4444-4444-8444-444444444444";
	state.output.bucket = "example-media";
	state.manifests.dash.enabled = false;
	return state;
}

describe("Live muxing settings in Packaging", () => {
	it("edits naming and output paths directly in each output card with one shared segment length", () => {
		renderLocalized(<Harness initial={fixture()} />);
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		const video = screen.getByRole("region", { name: "v720" });
		for (const id of [
			"lw-v-0-container",
			"lw-v-0-media-segmentNamingTemplate",
			"lw-v-0-media-segmentNaming",
			"lw-v-0-media-initSegmentName",
			"lw-v-0-media-path",
		]) {
			expect(field(id)).toBeVisible();
			expect(video).toContainElement(field(id));
		}
		fireEvent.change(field("lw-v-0-media-segmentNamingTemplate"), {
			target: { value: "video_{rand_chars:8}_%number%.m4s" },
		});
		expect(field("lw-v-0-media-segmentNaming")).toBeDisabled();
		fireEvent.change(field("lw-v-0-media-path"), {
			target: { value: "media/primary" },
		});
		fireEvent.change(field("lw-seglen"), { target: { value: "4" } });
		const plan = buildLiveChannelPlan(current());
		expect(plan.muxings.find((muxing) => muxing.key === "v720")).toMatchObject({
			destination: { path: "media/primary" },
			segmentNamingTemplate: "video_{rand_chars:8}_%number%.m4s",
		});
		expect(
			plan.muxings.every(
				(muxing) => "segmentLength" in muxing && muxing.segmentLength === 4,
			),
		).toBe(true);
	});

	it("keeps per-output DRM actions connected to primary and additional manifests", () => {
		const initial = fixture();
		initial.manifests.additionalHls = [{ ...initial.manifests.hls }];
		initial.manifests.additionalDash = [{ ...initial.manifests.dash }];
		renderWithQuery(<Harness initial={initial} />);
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		const video = screen.getByRole("region", { name: "v720" });
		const disclosure = within(video).getByText("Encryption / DRM (0)");
		fireEvent.click(disclosure);
		fireEvent.click(within(video).getByRole("button", { name: "Add CENC" }));
		expect(current().drm).toHaveLength(1);
		expect(current().drm?.[0]?.muxingKey).toBe("v720");
		const manifests = () => [
			current().manifests.hls,
			current().manifests.dash,
			...(current().manifests.additionalHls ?? []),
			...(current().manifests.additionalDash ?? []),
		];
		expect(manifests().map((manifest) => manifest.drmKind)).toEqual([
			"CENC",
			"CENC",
			"CENC",
			"CENC",
		]);
		fireEvent.click(
			within(video).getByRole("button", { name: "Remove encryption" }),
		);
		expect(current().drm).toBeUndefined();
		expect(manifests().map((manifest) => manifest.drmKind)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it.each([
		"en",
		"ja",
	] as const)("keeps codec/input settings on Ladder and muxing controls in Packaging in %s", (locale) => {
		renderLocalized(<Harness initial={fixture()} />, locale);
		expect(field("lw-v-0-bitrate")).toBeInTheDocument();
		expect(field("lw-v-0-input-position")).toBeInTheDocument();
		for (const id of [
			"lw-v-0-container",
			"lw-a-0-container",
			"lw-a-0-own",
			"lw-v-0-media-path",
		])
			expect(document.getElementById(id)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		for (const id of [
			"lw-v-0-container",
			"lw-a-0-container",
			"lw-a-0-own",
			"lw-v-0-media-path",
		])
			expect(field(id)).toBeInTheDocument();
		expect(document.getElementById("lw-v-0-bitrate")).toBeNull();
		expect(document.getElementById("lw-v-0-input-position")).toBeNull();
	});

	it("preserves imported and restored muxing options across step navigation", () => {
		const state = fixture();
		const video = state.videos[0];
		if (!video) throw new Error("Missing video fixture");
		video.container = "CMAF";
		video.cmaf = {
			framesPerCmafChunk: 8,
			initSegmentNameTemplate: "init_{rand_chars:8}.mp4",
		};
		video.muxing = {
			path: "media/video",
			segmentNamingTemplate: "v_{rand_chars:8}_%number%.m4s",
		};
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		const imported = tryImportLiveChannelIntoWizard(plan);
		if (!imported.ok) throw new Error(imported.reasonKey);
		const restored = mergeWizardDraft(
			DEFAULT_LIVE_WIZARD_STATE,
			projectWizardDraft("live", imported.state),
			"live",
		);
		renderLocalized(<Harness initial={restored} />);
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		expect(field("lw-v-0-container")).toHaveValue("CMAF");
		expect(field("lw-v-0-cmaf-framesPerCmafChunk")).toHaveValue(8);
		expect(field("lw-v-0-media-segmentNamingTemplate")).toHaveValue(
			video.muxing.segmentNamingTemplate,
		);
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		expect(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(current())),
		).toEqual(plan);
	});

	it("keeps bundled audio identity when Packaging and Ladder are edited in turn", () => {
		renderLocalized(<Harness initial={fixture()} />);
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		fireEvent.change(field("lw-v-0-container"), { target: { value: "TS" } });
		fireEvent.change(field("lw-v-0-muxaudio"), { target: { value: "a128" } });
		expect(field("lw-a-0-own")).not.toBeChecked();
		fireEvent.change(field("lw-v-0-media-path"), {
			target: { value: "media/bundled" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		fireEvent.change(field("lw-a-0-bitrate"), { target: { value: "192000" } });
		fireEvent.click(screen.getByRole("button", { name: "Change step" }));
		expect(field("lw-v-0-muxaudio")).toHaveValue("a128");
		expect(field("lw-v-0-media-path")).toHaveValue("media/bundled");
		const plan = buildLiveChannelPlan(current());
		const muxing = plan.muxings.find((muxing) => muxing.kind === "TS");
		expect(muxing?.additionalStreamKeys).toEqual(["a128"]);
		expect(
			plan.muxings.filter((muxing) => muxing.streamKey === "a128"),
		).toEqual([]);
	});
});
