import { HDR_VMAF_MODELS } from "@bitovp/core";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hdrMeasurementFixture } from "@/test/hdr-measurement";
import { renderLocalized } from "@/test/render";
import { HdrMeasurementSummary } from "./hdr-measurement-summary";

describe("HDR measurement scope", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows calibrated HLG display and base-layer scope in %s", (locale) => {
		const { container } = renderLocalized(
			<HdrMeasurementSummary
				results={[{ hdrMeasurement: hdrMeasurementFixture(true) }]}
			/>,
			locale,
		);
		expect(screen.getByText(/HLG.*PQ.*1000/)).toBeVisible();
		expect(container.textContent).toMatch(/RPU/);
		expect(container.textContent).toMatch(
			locale === "ja" ? /ベース映像/ : /base layer/i,
		);
	});
	it.each(
		HDR_VMAF_MODELS.filter((model) => model.id.includes("_hfr_")),
	)("keeps the HFR model $id visible in the condition summary", (model) => {
		const evidence = hdrMeasurementFixture();
		evidence.model = model.id;
		evidence.modelSha256 = model.sha256;
		evidence.reference.frameRate = "60/1";
		evidence.distorted.frameRate = "60/1";
		const { container } = renderLocalized(
			<HdrMeasurementSummary results={[{ hdrMeasurement: evidence }]} />,
		);
		expect(container.querySelector("summary")).toHaveTextContent(model.id);
		expect(screen.getByText(model.id)).toBeVisible();
	});
	it("does not claim HDR measurement without valid evidence", () => {
		const { container } = renderLocalized(
			<HdrMeasurementSummary results={[{}]} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
