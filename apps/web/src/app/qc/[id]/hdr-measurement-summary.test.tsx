import { HDR_VMAF_MODELS } from "@bitovp/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { hdrMeasurementFixture } from "@/test/hdr-measurement";
import { renderLocalized } from "@/test/render";
import { HdrMeasurementSummary } from "./hdr-measurement-summary";

describe("HDR measurement scope", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows calibrated HLG display and base-layer scope in %s", async (locale) => {
		const evidence = hdrMeasurementFixture(true);
		const { container } = renderLocalized(
			<HdrMeasurementSummary results={[{ hdrMeasurement: evidence }]} />,
			locale,
		);
		expect(screen.getByText(/HLG.*PQ.*1000/)).toBeVisible();
		const scope = screen.getByText(
			locale === "ja" ? "HDRベース映像を計測" : "HDR base layer measured",
		);
		expect(scope).toBeVisible();
		const proof = container.querySelector("pre");
		expect(proof).not.toBeVisible();
		await userEvent.click(scope);
		expect(proof).toBeVisible();
		expect(JSON.parse(proof?.textContent ?? "null")).toEqual([evidence]);
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
