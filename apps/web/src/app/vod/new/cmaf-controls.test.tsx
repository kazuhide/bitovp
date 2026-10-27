import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_WIZARD_STATE } from "@/app/live/new/build-live-plan";
import { LiveMuxingsSection } from "@/app/live/new/muxings-section";
import { renderWithQuery } from "@/test/render";
import { DEFAULT_WIZARD_STATE } from "./build-plan";
import { blankDrmRow } from "./drm-row-editor";
import { MuxingsSection } from "./muxings-section";

describe("CMAF container authoring", () => {
	it("selects CMAF on the existing VOD packaging row", () => {
		const onPatch = vi.fn();
		renderWithQuery(
			<MuxingsSection
				state={{ ...DEFAULT_WIZARD_STATE, audios: [] }}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		expect(screen.getByRole("option", { name: "CMAF" })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Container"), {
			target: { value: "CMAF" },
		});
		expect(onPatch.mock.calls[0]?.[0].videos[0].muxing.kind).toBe("CMAF");
	});
	it("exposes CMAF fields without offering unsupported DRM additions", () => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		state.audios = [];
		state.videos = state.videos.map((video) => ({
			...video,
			muxing: { kind: "CMAF" },
		}));
		renderWithQuery(
			<MuxingsSection state={state} credentials={[]} onPatch={vi.fn()} />,
		);
		expect(
			screen.getByLabelText("Init segment name template"),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Frames per CMAF chunk")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Add CENC" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add FairPlay" })).toBeNull();
		expect(screen.queryByText("+ SPEKE")).toBeNull();
	});
	it("selects CMAF and edits chunk frames in Live packaging", () => {
		const onPatch = vi.fn();
		const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
		state.audios = [];
		state.videos = state.videos.map((video) => ({
			...video,
			container: "CMAF",
		}));
		renderWithQuery(<LiveMuxingsSection state={state} onPatch={onPatch} />);
		expect(screen.getByRole("option", { name: "CMAF" })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Frames per CMAF chunk"), {
			target: { value: "8" },
		});
		expect(onPatch.mock.calls[0]?.[0].videos[0].cmaf.framesPerCmafChunk).toBe(
			8,
		);
	});
	it.each(["VOD", "Live"])("does not offer CMAF for HEVC in %s", (surface) => {
		if (surface === "VOD") {
			const state = structuredClone(DEFAULT_WIZARD_STATE);
			state.audios = [];
			state.videos = state.videos.map((video) => ({ ...video, codec: "H265" }));
			renderWithQuery(
				<MuxingsSection state={state} credentials={[]} onPatch={vi.fn()} />,
			);
		} else {
			const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
			state.audios = [];
			state.videos = state.videos.map((video) => ({ ...video, codec: "H265" }));
			renderWithQuery(<LiveMuxingsSection state={state} onPatch={vi.fn()} />);
		}
		expect(screen.queryByRole("option", { name: "CMAF" })).toBeNull();
	});
	it("keeps attached encryption removable after changing a VOD container to CMAF", () => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		state.audios = [];
		state.videos = state.videos.map((video) => ({
			...video,
			muxing: { kind: "CMAF" },
		}));
		state.drm = [blankDrmRow("CENC", "v360")];
		const onPatch = vi.fn();
		renderWithQuery(
			<MuxingsSection state={state} credentials={[]} onPatch={onPatch} />,
		);
		const details = screen.getByText("CENC").closest("details");
		if (!details)
			throw new Error("Attached DRM must remain visible in its section");
		details.open = true;
		fireEvent.click(screen.getByRole("button", { name: "Remove encryption" }));
		expect(onPatch).toHaveBeenCalledWith({ drm: [] });
	});
});
