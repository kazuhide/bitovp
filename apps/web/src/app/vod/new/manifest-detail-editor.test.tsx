import type { WizardHlsOptions } from "@bitovp/core/wizard";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import type { WizardDashOptions } from "./build-plan";
import {
	ManifestAdvancedEditor,
	type ManifestResources,
} from "./manifest-detail-editor";
import { DashAdaptationSetsEditor } from "./wizard-sections";

const resources: ManifestResources = {
	muxings: [{ value: "video", label: "720p · FMP4" }],
	keyframes: [{ value: "cue", label: "10 s" }],
	sprites: [],
	drm: [],
	encodings: [{ value: "default", label: "Encoding" }],
};
function Harness() {
	const [value, setValue] = useState<WizardHlsOptions>({});
	return (
		<>
			<ManifestAdvancedEditor
				kind="HLS"
				idBase="hls"
				value={value}
				onChange={setValue}
				resources={resources}
			/>
			<output data-testid="value">{JSON.stringify(value)}</output>
		</>
	);
}
function result() {
	return JSON.parse(screen.getByTestId("value").textContent ?? "{}");
}
function section(name: string) {
	const details = screen.getByText(name).closest("details");
	if (!details) throw new Error(`Missing section ${name}`);
	fireEvent.click(within(details).getByText(name));
	return within(details);
}

describe("manifest detailed controls", () => {
	it.each([
		"en",
		"ja",
	] as const)("%s: explains the public VTT URL limitation beside the input", async (locale) => {
		renderLocalized(<Harness />, locale);
		await userEvent.click(
			screen.getByText(
				locale === "en"
					? "Additional manifest options"
					: "マニフェストの詳細設定",
			),
		);
		const media = section("additionalMedia (0)");
		fireEvent.click(
			media.getByRole("button", { name: locale === "en" ? "Add" : "追加" }),
		);
		expect(media.getByLabelText("vttUrl")).toHaveAccessibleDescription(
			locale === "en"
				? "Use a public URL without credentials, query strings (?) or fragments (#). Signed URLs are not supported."
				: "認証不要の公開URLのみ（署名・?・#は不可）",
		);
	});
	it.each([
		"roles",
		"labels",
		"accessibilities",
		"customAttributes",
	] as const)("clears the final %s setting on an explicit adaptation set", (field) => {
		function MetadataHarness() {
			const [value, setValue] = useState<WizardDashOptions>({
				adaptationSets: [
					{
						key: "video",
						type: "VIDEO",
						roles: ["MAIN"],
						labels: [{ value: "Main", lang: "en" }],
						accessibilities: [{ schemeIdUri: "urn:test", value: "1" }],
						customAttributes: [{ key: "selectionPriority", value: "1" }],
					},
				],
			});
			return (
				<>
					<DashAdaptationSetsEditor
						idBase="sets"
						value={value}
						onChange={setValue}
					/>
					<output data-testid="metadata">{JSON.stringify(value)}</output>
				</>
			);
		}
		renderLocalized(<MetadataHarness />);
		if (field === "roles")
			fireEvent.change(screen.getByLabelText("roles"), {
				target: { value: "" },
			});
		else {
			const group = screen.getByText(`${field} (1)`).closest("details");
			if (!group) throw new Error("Missing metadata group");
			fireEvent.click(
				within(group).getByRole("button", { name: "Remove", hidden: true }),
			);
		}
		const current = JSON.parse(
			screen.getByTestId("metadata").textContent ?? "{}",
		).adaptationSets[0];
		expect(current).toMatchObject({ key: "video", type: "VIDEO" });
		expect(current).not.toHaveProperty(field);
	});
	it("keeps optional booleans distinct from false and allows comma-separated attributes", async () => {
		const user = userEvent.setup();
		renderLocalized(<Harness />);
		await userEvent.click(screen.getByText("Additional manifest options"));
		fireEvent.change(screen.getByLabelText("channelsAttributeForAudio"), {
			target: { value: "ALWAYS" },
		});
		const media = section("audioMedia");
		fireEvent.change(media.getByLabelText("isDefault"), {
			target: { value: "false" },
		});
		await user.type(
			media.getByLabelText("characteristics"),
			"public.accessibility.describes-video, public.accessibility.describes-music-and-sound",
		);
		expect(result()).toMatchObject({
			detailed: {
				channelsAttributeForAudio: "ALWAYS",
				audioMedia: {
					isDefault: false,
					characteristics: [
						"public.accessibility.describes-video",
						"public.accessibility.describes-music-and-sound",
					],
				},
			},
		});
		fireEvent.change(media.getByLabelText("isDefault"), {
			target: { value: "" },
		});
		expect(result().detailed.audioMedia).not.toHaveProperty("isDefault");
	});

	it("uses existing output selections and clears incompatible fields when the media type changes", async () => {
		renderLocalized(<Harness />);
		await userEvent.click(screen.getByText("Additional manifest options"));
		const media = section("additionalMedia (0)");
		fireEvent.click(media.getByRole("button", { name: "Add" }));
		expect(media.getByLabelText("vttUrl")).toBeInTheDocument();
		fireEvent.change(media.getByLabelText("type"), {
			target: { value: "VIDEO" },
		});
		expect(media.queryByLabelText("vttUrl")).toBeNull();
		fireEvent.change(media.getByLabelText("muxingKey"), {
			target: { value: "video" },
		});
		expect(result().detailed.additionalMedia[0]).toMatchObject({
			type: "VIDEO",
			muxingKey: "video",
			uri: "video.m3u8",
		});
		expect(result().detailed.additionalMedia[0]).not.toHaveProperty("vttUrl");
	});

	it("changes tag placement atomically without retaining incompatible placement fields", async () => {
		renderLocalized(<Harness />);
		await userEvent.click(screen.getByText("Additional manifest options"));
		const tags = section("streamCustomTags (0)");
		fireEvent.click(tags.getByRole("button", { name: "Add" }));
		fireEvent.change(tags.getByLabelText("positionMode"), {
			target: { value: "KEYFRAME" },
		});
		fireEvent.change(tags.getByLabelText("keyframeKey"), {
			target: { value: "cue" },
		});
		expect(result().detailed.streamCustomTags[0]).toEqual({
			positionMode: "KEYFRAME",
			keyframeKey: "cue",
			data: "#EXT-X-",
		});
		expect(tags.queryByLabelText("time")).toBeNull();
	});
});
