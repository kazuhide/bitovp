import { computePooled } from "@bitovp/core";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { referencePreparationEvidence } from "@/test/vmaf-reference-preparation";
import type { VmafResultDetail } from "../vmaf-shared";
import { ReferencePreparationSummary } from "./reference-preparation-summary";

const result: VmafResultDetail = {
	id: "result",
	renditionRef: { label: "1080p" },
	pooled: computePooled([{ frameNum: 0, vmaf: 95 }]),
	frames: [],
	frameCount: 14315,
	referencePreparation: referencePreparationEvidence,
};

describe("manual reference preparation disclosure", () => {
	it("states coded-raster comparison and ignored display scaling with inspectable proof", () => {
		const { container } = renderLocalized(
			<ReferencePreparationSummary results={[result]} />,
		);
		expect(
			screen.getByText(/coded-raster comparison.*display scaling ignored/i),
		).toBeVisible();
		expect(container.textContent).toMatch(
			/manual.*does not validate.*presentation/i,
		);
		expect(container.textContent).toContain("1080p");
		expect(container.textContent).toContain(
			referencePreparationEvidence.inputSha256,
		);
		expect(container.textContent).toContain('"packetTimingVerified": true');
		expect(container.querySelector("details")).not.toHaveAttribute("open");
	});
	it("discloses the same comparison boundary in Japanese", () => {
		const { container } = renderLocalized(
			<ReferencePreparationSummary results={[result]} />,
			"ja",
		);
		expect(
			screen.getByText("符号化ラスタで比較・表示用の拡縮を無視"),
		).toBeVisible();
		expect(container.textContent).toContain("手動指定");
		expect(container.textContent).toContain("表示後の見え方は検証していません");
	});

	it.each([
		undefined,
		{ ...referencePreparationEvidence, frameTimingVerified: false },
		{ ...referencePreparationEvidence, path: "/private/source.mov" },
	])("makes no preparation claim for absent or invalid proof", (referencePreparation) => {
		const { container } = renderLocalized(
			<ReferencePreparationSummary
				results={[{ ...result, referencePreparation } as VmafResultDetail]}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
