import { liveChannelPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { mergeWizardDraft, projectWizardDraft } from "@/lib/wizard-draft";
import { renderLocalized } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { LiveManifestDetailEditor } from "./live-manifest-detail-editor";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";

function state(): LiveWizardState {
	const s = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	s.manifests.dash.enabled = true;
	s.name = "Detailed Live";
	s.accountId = "00000000-0000-4000-8000-000000000001";
	s.output.credentialId = "00000000-0000-4000-8000-000000000002";
	s.output.bucket = "test";
	s.output.basePath = "live/test/";
	return s;
}
function Harness({ kind }: { kind: "HLS" | "DASH" }) {
	const [value, setValue] = useState(state());
	return (
		<>
			{kind === "HLS" ? (
				<LiveManifestDetailEditor
					kind="HLS"
					state={value}
					idBase="hls"
					value={value.manifests.hls}
					onChange={(hls) =>
						setValue({ ...value, manifests: { ...value.manifests, hls } })
					}
				/>
			) : (
				<LiveManifestDetailEditor
					kind="DASH"
					state={value}
					idBase="dash"
					value={value.manifests.dash}
					onChange={(dash) =>
						setValue({ ...value, manifests: { ...value.manifests, dash } })
					}
				/>
			)}
			<output data-testid="value">
				{JSON.stringify(buildLiveChannelPlan(value))}
			</output>
		</>
	);
}
describe("Live detailed manifest editing", () => {
	it("defers unopened detail controls and keeps edited values after closing", async () => {
		renderLocalized(<Harness kind="DASH" />);
		expect(screen.queryByLabelText("minBufferTime")).toBeNull();
		const summary = screen.getByText("Additional manifest options");
		await userEvent.click(summary);
		fireEvent.change(screen.getByLabelText("minBufferTime"), {
			target: { value: "4.5" },
		});
		await userEvent.click(summary);
		await userEvent.click(summary);
		expect(screen.getByLabelText("minBufferTime")).toHaveValue(4.5);
		expect(
			liveChannelPlanSchema
				.parse(JSON.parse(screen.getByTestId("value").textContent ?? "{}"))
				.liveManifests.find((manifest) => manifest.kind === "DASH")?.detailed,
		).toMatchObject({ minBufferTime: 4.5 });
	});

	it("edits HLS creation fields with the existing compact controls", async () => {
		renderLocalized(<Harness kind="HLS" />);
		await userEvent.click(screen.getByText("Additional manifest options"));
		fireEvent.change(screen.getByLabelText("channelsAttributeForAudio"), {
			target: { value: "ALWAYS" },
		});
		const p = liveChannelPlanSchema.parse(
			JSON.parse(screen.getByTestId("value").textContent ?? "{}"),
		);
		expect(
			p.liveManifests.find((m) => m.kind === "HLS")?.detailed,
		).toMatchObject({ channelsAttributeForAudio: "ALWAYS" });
		expect(screen.queryByRole("option", { name: "KEYFRAME" })).toBeNull();
	});

	it("does not offer VOD-only output choices or keyframe references in Live", async () => {
		renderLocalized(<Harness kind="DASH" />);
		await userEvent.click(screen.getByText("Additional manifest options"));
		expect(screen.queryByRole("option", { name: "SPRITE" })).toBeNull();
		expect(
			screen.queryByRole("option", { name: "PROGRESSIVE_WEBM" }),
		).toBeNull();
		expect(screen.queryByLabelText("startKeyframeKey")).toBeNull();
		fireEvent.change(screen.getByLabelText("minBufferTime"), {
			target: { value: "0" },
		});
		const p = liveChannelPlanSchema.parse(
			JSON.parse(screen.getByTestId("value").textContent ?? "{}"),
		);
		expect(
			p.liveManifests.find((m) => m.kind === "DASH")?.detailed,
		).toMatchObject({ minBufferTime: 0 });
	});

	it("round-trips detailed manifests and recovers validated safe draft fields", () => {
		const s = state();
		s.manifests.hls.masterVersion = "HLS_V7";
		s.manifests.hls.mediaVersion = "HLS_V7";
		s.manifests.hls.detailed = {
			channelsAttributeForAudio: "ALWAYS",
			audioMedia: { isDefault: false, startSegmentNumber: 0 },
			streams: { forceFrameRateAttribute: false },
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: buildLiveChannelPlan(s).muxings[0]?.key ?? "missing",
					uri: "alternate.m3u8",
				},
				{
					type: "VTT",
					name: "Japanese",
					groupId: "subtitles",
					vttUrl: "https://example.test/sub.vtt",
					uri: "subtitles.m3u8",
				},
			],
			streamCustomTags: [
				{ positionMode: "SEGMENT", segment: 0, data: "#EXT-X-CUSTOM:1" },
			],
		};
		s.manifests.dash.detailed = {
			minBufferTime: 0,
			period: {
				start: 0,
				duration: 10,
				customXmlElements: ["<SupplementalProperty />"],
			},
			videoAdaptationSet: {
				labels: [{ value: "Video", lang: "en" }],
				roles: ["MAIN"],
			},
		};
		const p = liveChannelPlanSchema.parse(buildLiveChannelPlan(s)),
			imported = tryImportLiveChannelIntoWizard(p);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error(imported.reasonKey);
		expect(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
		).toEqual(p);
		const recovered = mergeWizardDraft(
			state(),
			projectWizardDraft("live", s),
			"live",
		);
		expect(recovered.manifests.hls.masterVersion).toBe("HLS_V7");
		expect(recovered.manifests.hls.detailed).toMatchObject({
			channelsAttributeForAudio: "ALWAYS",
			audioMedia: { isDefault: false, startSegmentNumber: 0 },
		});
		expect(recovered.manifests.hls.detailed?.additionalMedia).toEqual([
			{
				type: "VIDEO",
				name: "Alternate",
				groupId: "alternate",
				muxingKey: buildLiveChannelPlan(s).muxings[0]?.key,
				uri: "alternate.m3u8",
			},
		]);
		expect(recovered.manifests.dash.detailed).toMatchObject({
			minBufferTime: 0,
			period: { start: 0, duration: 10 },
		});
		expect(JSON.stringify(projectWizardDraft("live", s))).not.toContain(
			"https://example.test",
		);
		const malformed = projectWizardDraft("live", {
			...s,
			manifests: {
				...s.manifests,
				hls: { ...s.manifests.hls, detailed: { streams: { audioGroups: {} } } },
				dash: { ...s.manifests.dash, detailed: { representations: [{}] } },
			},
		});
		const safe = mergeWizardDraft(state(), malformed, "live");
		expect(safe.manifests.hls.detailed).toBeUndefined();
		expect(safe.manifests.dash.detailed).toBeUndefined();
	});
});
