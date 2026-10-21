import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { renderWithQuery } from "@/test/render";
import {
	audioKeys,
	DEFAULT_WIZARD_QC,
	DEFAULT_WIZARD_STATE,
} from "./build-plan";
import { MuxingsSection } from "./muxings-section";
import { SpritesSection } from "./sprites-section";
import { ThumbnailsSection } from "./thumbnails-section";
import { EncodingOptionsSection, ManifestSection } from "./wizard-sections";

function render(node: React.ReactElement) {
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf: true }}>
			{node}
		</FeatureFlagsProvider>,
	);
}

describe("packaging and encoding audit regressions", () => {
	it("offers SPEKE on the default fMP4 container without requiring an explicit kind", () => {
		const onPatch = vi.fn();
		render(
			<MuxingsSection
				state={{ ...DEFAULT_WIZARD_STATE, audios: [] }}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByText("+ SPEKE"));
		expect(onPatch).toHaveBeenCalledWith({
			drm: [expect.objectContaining({ kind: "SPEKE", muxingKey: "v360" })],
		});
	});
	it("does not describe WebM Opus audio as an HLS audio group", () => {
		render(
			<MuxingsSection
				state={{
					...DEFAULT_WIZARD_STATE,
					videos: [],
					audios: [{ codec: "OPUS", bitrate: 64000, rate: 48000 }],
				}}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.queryByText(/EXT-X-MEDIA/)).toBeNull();
	});
	it.each([
		"thumbnail",
		"sprite",
	] as const)("shows and repairs a missing %s stream instead of showing another selection", (kind) => {
		const onPatch = vi.fn();
		const state = {
			...DEFAULT_WIZARD_STATE,
			thumbnails: [
				{
					key: "thumb1",
					streamKey: "removed-video",
					height: 360,
					positions: [0],
				},
			],
			sprites: [
				{
					key: "sprite1",
					streamKey: "removed-video",
					distance: 10,
					height: 90,
					filename: "sprite.jpg",
				},
			],
		};
		render(
			kind === "thumbnail" ? (
				<ThumbnailsSection state={state} onPatch={onPatch} />
			) : (
				<SpritesSection state={state} onPatch={onPatch} />
			),
		);
		const select = screen.getByLabelText("Stream");
		expect(select).toHaveValue("removed-video");
		expect(
			screen.getByRole("option", { name: /removed-video/ }),
		).toHaveTextContent(/missing/);
		fireEvent.change(select, { target: { value: "v360" } });
		expect(
			onPatch.mock.calls[0]?.[0][
				kind === "thumbnail" ? "thumbnails" : "sprites"
			][0].streamKey,
		).toBe("v360");
	});
	it("allocates an unused manifest key after deleting an earlier row", () => {
		const onPatch = vi.fn();
		render(
			<ManifestSection
				state={{
					...DEFAULT_WIZARD_STATE,
					manifests: {
						hls: false,
						dash: false,
						extra: [{ kind: "HLS", key: "hls2" }],
					},
				}}
				onPatch={onPatch}
			/>,
		);
		expect(screen.queryByRole("textbox", { name: "Key" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Add HLS" }));
		const rows = onPatch.mock.calls[0]?.[0].manifests.extra;
		expect(new Set(rows.map((row: { key: string }) => row.key)).size).toBe(
			rows.length,
		);
	});
	it("keeps imported or stale preview placement editable under post-encoding", () => {
		const onPatch = vi.fn();
		render(
			<ManifestSection
				state={{
					...DEFAULT_WIZARD_STATE,
					timing: "POST_ENCODING",
					manifests: {
						hls: true,
						dash: false,
						hlsOptions: { jitPlacement: "PREVIEW" },
					},
				}}
				onPatch={onPatch}
			/>,
		);
		const placement = screen.getByLabelText("Start placement");
		expect(placement).toHaveValue("PREVIEW");
		fireEvent.change(placement, { target: { value: "" } });
		expect(onPatch).toHaveBeenCalledWith(
			expect.objectContaining({
				manifests: expect.objectContaining({
					hlsOptions: { jitPlacement: undefined },
				}),
			}),
		);
	});
	it("exposes DRM attached to an audio container that is now suppressed", () => {
		const key = audioKeys(DEFAULT_WIZARD_STATE.audios)[0] ?? "a64";
		const onPatch = vi.fn();
		render(
			<MuxingsSection
				credentials={[]}
				state={{
					...DEFAULT_WIZARD_STATE,
					audios: DEFAULT_WIZARD_STATE.audios.map((a) => ({
						...a,
						muxing: { ownContainer: false },
					})),
					drm: [{ kind: "CENC", muxingKey: key, credentialId: "", kid: "" }],
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove encryption" }));
		expect(onPatch).toHaveBeenCalledWith({ drm: [] });
	});
	it("suspends AISA controls under QC-only and preserves their authored values", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...DEFAULT_WIZARD_STATE,
					qc: { ...DEFAULT_WIZARD_QC, vmaf: true, only: true },
					startOptions: {
						aiSceneAnalysis: { filename: "saved.json", path: "analysis" },
					},
				}}
				onPatch={onPatch}
			/>,
		);
		expect(document.querySelector("#wz-ai-enable")).toBeDisabled();
		expect(document.querySelector("#wz-ai-filename")).toBeDisabled();
		expect(document.querySelector("#wz-ai-filename")).toHaveValue("saved.json");
		expect(onPatch).not.toHaveBeenCalled();
	});
});
