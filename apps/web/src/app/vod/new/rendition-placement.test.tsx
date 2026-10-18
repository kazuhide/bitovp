import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import type { ManifestPlacement } from "./rendition-editors";
import { RenditionPlacement } from "./rendition-editors";

// RenditionPlacement is the per-rendition manifest placement moved out of the
// Ladder into the Manifests step (round 2 #4). These guard that the relocated
// controls still render and patch extras.
const placement: ManifestPlacement = {
	variantsPerAudioGroup: false,
	dashAdaptationSets: [
		{
			key: "video-dv",
			type: "VIDEO",
			lang: undefined,
			label: undefined,
			manifestKeys: ["dash"],
		},
	],
	conflictingDashSetKeys: [],
};

describe("RenditionPlacement", () => {
	it("routes a rendition into a declared DASH adaptation set", () => {
		const onChange = vi.fn();
		render(
			<RenditionPlacement
				idBase="t"
				family="video"
				value={{}}
				placement={placement}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("DASH adaptation set"), {
			target: { value: "video-dv" },
		});
		expect(onChange).toHaveBeenCalledWith({ dashSetKey: "video-dv" });
	});

	it("shows a hint (no DASH select) when no adaptation sets are declared", () => {
		render(
			<RenditionPlacement
				idBase="t"
				family="video"
				value={{}}
				placement={{ ...placement, dashAdaptationSets: [] }}
				onChange={vi.fn()}
			/>,
		);
		expect(
			screen.queryByLabelText("DASH adaptation set"),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/DASH adaptation-set routing appears here/),
		).toBeInTheDocument();
	});

	it("emits an HLS variant label", () => {
		const onChange = vi.fn();
		render(
			<RenditionPlacement
				idBase="t"
				family="video"
				value={{}}
				placement={{ ...placement, dashAdaptationSets: [] }}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("HLS variant label"), {
			target: { value: "dv81" },
		});
		expect(onChange).toHaveBeenCalledWith({ hlsVariantLabel: "dv81" });
	});

	it("adds an HLS media entry", () => {
		const onChange = vi.fn();
		render(
			<RenditionPlacement
				idBase="t"
				family="audio"
				value={{}}
				placement={{ ...placement, dashAdaptationSets: [] }}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByText("Add HLS media entry"));
		expect(onChange).toHaveBeenCalledWith({
			hlsMedia: { groupId: "", name: "", uri: "" },
		});
	});
});
