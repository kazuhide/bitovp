import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { OverviewStrip } from "./overview-strip";

const BASE = {
	region: "EUROPE",
	labels: [],
	createdAt: "2026-08-17T00:00:00.000Z",
	bitmovinEncodingId: null,
};

describe("OverviewStrip — template provenance chip (ledger #109 §6)", () => {
	it("renders name + launched revision when the template still exists", () => {
		renderWithQuery(
			<OverviewStrip
				{...BASE}
				presetRevision={2}
				preset={{ name: "hardened-hls", revision: 2 }}
			/>,
		);
		expect(screen.getByText("Template")).toBeInTheDocument();
		expect(screen.getByText("hardened-hls (rev 2)")).toBeInTheDocument();
	});

	it("hints when the template has moved past the launched revision", () => {
		renderWithQuery(
			<OverviewStrip
				{...BASE}
				presetRevision={1}
				preset={{ name: "hardened-hls", revision: 3 }}
			/>,
		);
		expect(
			screen.getByText("hardened-hls (rev 1 → now 3)"),
		).toBeInTheDocument();
	});

	it("keeps the revision when the template was deleted (SetNull)", () => {
		renderWithQuery(
			<OverviewStrip {...BASE} presetRevision={2} preset={null} />,
		);
		expect(screen.getByText("Template deleted (rev 2)")).toBeInTheDocument();
	});

	it("renders NO template fact for ad-hoc / pre-#109 jobs", () => {
		renderWithQuery(<OverviewStrip {...BASE} presetRevision={null} />);
		expect(screen.queryByText("Template")).not.toBeInTheDocument();
	});
});
