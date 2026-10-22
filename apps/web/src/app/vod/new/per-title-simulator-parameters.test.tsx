import type { PerTitleProposal } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleParameterView } from "./per-title-simulator-parameters";

function proposal(): PerTitleProposal {
	return {
		id: "baseline",
		codec: "H264",
		status: "unknown",
		applicable: false,
		evidence: "model-only",
		countGuarantee: false,
		diagnostics: [],
		scenarios: [],
		api: {
			global: {
				minBitrate: 100001,
				maxBitrate: 2400000,
				minBitrateStepSize: 1.23456789,
				maxBitrateStepSize: 3,
				autoRepresentations: {},
				fixedResolutionAndBitrateConfiguration: {
					forcedRenditionAboveHighestFixedRepresentation: 0,
					forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
					forcedRenditionAboveHighestFixedRepresentationCalculationMode:
						"LAST_CALCULATED_BITRATE",
				},
			},
			streams: [
				{
					rowId: "fixed",
					height: 360,
					width: 640,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: {
						minBitrate: 160001,
						maxBitrate: 200000,
						bitrateSelectionMode: "COMPLEXITY_RANGE",
						lowComplexityBoundaryForMaxBitrate: 1000000,
						highComplexityBoundaryForMaxBitrate: 2400000,
					},
				},
				{
					rowId: "resolution",
					height: 720,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
				},
				{ rowId: "automatic", mode: "PER_TITLE_TEMPLATE" },
			],
		},
	};
}

const globalValue = (key: string) => {
	const label = screen.getByText(key, { selector: "dt" });
	const container = label.parentElement;
	if (!container) throw new Error("Missing parameter pair");
	return container.querySelector("dd");
};

describe("calculated Per-Title parameter view", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows actual values with units and all stream modes (%s)", (locale) => {
		const value = proposal();
		const snapshot = structuredClone(value);
		const { container } = renderLocalized(
			<PerTitleParameterView proposal={value} />,
			locale,
		);
		expect(
			screen.getByRole("heading", {
				name:
					locale === "en"
						? "Calculated Per-Title settings"
						: "計算後のPer-Title設定",
			}),
		).toBeVisible();
		expect(screen.getByText("h264Configuration")).toBeVisible();
		expect(globalValue("minBitrate (kbps)")).toHaveTextContent("100.001");
		expect(globalValue("minBitrateStepSize")).toHaveTextContent("1.23456789");
		expect(
			globalValue("forcedRenditionAboveHighestFixedRepresentation"),
		).toHaveTextContent(/^0$/);
		expect(globalValue("autoRepresentations")).toHaveTextContent(
			locale === "en" ? "Included" : "指定あり",
		);
		const first = screen.getByRole("row", {
			name: locale === "en" ? /Rendition 1/ : /レンディション 1/,
		});
		expect(first).toHaveTextContent("640 × 360");
		expect(first).toHaveTextContent("160.001");
		expect(first).toHaveTextContent("COMPLEXITY_RANGE");
		expect(first).toHaveTextContent("1,000");
		expect(first).toHaveTextContent("2,400");
		expect(
			screen.getByRole("row", {
				name: locale === "en" ? /Rendition 2/ : /レンディション 2/,
			}),
		).toHaveTextContent("PER_TITLE_TEMPLATE_FIXED_RESOLUTION");
		const automatic = screen.getByRole("row", {
			name: locale === "en" ? /Rendition 3/ : /レンディション 3/,
		});
		expect(
			within(automatic).getAllByText(
				locale === "en" ? "Not applicable" : "対象外",
			),
		).toHaveLength(5);
		expect(automatic).not.toHaveTextContent("OPTIMIZED");
		expect(
			container.querySelectorAll("input,button,select,details"),
		).toHaveLength(0);
		expect(container).not.toHaveTextContent(
			/targetQualityCrf|complexityFactor|codecBufsizeFactor/,
		);
		expect(value).toEqual(snapshot);
	});
	it("separates stream metadata from the named fixed-settings column group", () => {
		renderLocalized(<PerTitleParameterView proposal={proposal()} />);
		const scroll = screen.getByRole("region", { name: "Streams" });
		expect(
			within(scroll).getByRole("table", { name: "Streams" }),
		).toBeVisible();
		expect(
			within(scroll).getByRole("columnheader", { name: "Mode" }),
		).toBeVisible();
		expect(
			within(scroll).getByRole("columnheader", { name: "Dimensions (px)" }),
		).toBeVisible();
		expect(
			within(scroll).getByRole("columnheader", {
				name: "perTitleSettings.fixedResolutionAndBitrateSettings",
			}),
		).toHaveAttribute("colspan", "5");
	});
	it("updates actual proposal values and codec context on rerender", () => {
		const before = proposal();
		const { rerender } = renderLocalized(
			<PerTitleParameterView proposal={before} />,
		);
		const after = proposal();
		after.codec = "H265V2";
		after.api.global.minBitrateStepSize = 2.5;
		after.api.global.maxBitrate = 4800000;
		if (after.api.streams[0]?.perTitleSettings)
			after.api.streams[0].perTitleSettings.highComplexityBoundaryForMaxBitrate = 4800000;
		rerender(<PerTitleParameterView proposal={after} />);
		expect(screen.getByText("h265V2Configuration")).toBeVisible();
		expect(screen.queryByText("h264Configuration")).toBeNull();
		expect(globalValue("minBitrateStepSize")).toHaveTextContent(/^2.5$/);
		expect(globalValue("maxBitrate (kbps)")).toHaveTextContent("4,800");
		expect(screen.getByRole("row", { name: /Rendition 1/ })).toHaveTextContent(
			"4,800",
		);
	});
	it("distinguishes absent fields from zero and does not invent selection defaults", () => {
		const value = proposal();
		delete value.api.global.autoRepresentations;
		value.api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 0,
		};
		value.api.streams = [
			{
				rowId: "empty",
				height: 360,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: {},
			},
		];
		renderLocalized(<PerTitleParameterView proposal={value} />);
		expect(globalValue("autoRepresentations")).toHaveTextContent("Unset");
		expect(
			globalValue("forcedRenditionAboveHighestFixedRepresentation"),
		).toHaveTextContent(/^0$/);
		expect(
			globalValue("forcedRenditionAboveHighestFixedRepresentationFactor"),
		).toHaveTextContent("Unset");
		expect(
			globalValue(
				"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
			),
		).toHaveTextContent("Unset");
		const row = screen.getByRole("row", { name: /Rendition 1/ });
		expect(within(row).getAllByText("Unset").length).toBeGreaterThanOrEqual(5);
		expect(row).not.toHaveTextContent("OPTIMIZED");
	});
	it("omits absent forced blocks and marks complexity fields irrelevant for optimized streams", () => {
		const value = proposal();
		delete value.api.global.fixedResolutionAndBitrateConfiguration;
		if (value.api.streams[0]?.perTitleSettings)
			value.api.streams[0].perTitleSettings.bitrateSelectionMode = "OPTIMIZED";
		renderLocalized(<PerTitleParameterView proposal={value} />);
		expect(
			screen.queryByText("forcedRenditionAboveHighestFixedRepresentation"),
		).toBeNull();
		const row = screen.getByRole("row", { name: /Rendition 1/ });
		expect(within(row).getAllByText("Not applicable")).toHaveLength(2);
	});
	it("labels invalid numbers without rendering nonfinite values as parameters", () => {
		const value = proposal();
		value.api.global.minBitrateStepSize = NaN;
		value.api.global.maxBitrate = Infinity;
		value.api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: -1,
			forcedRenditionAboveHighestFixedRepresentationFactor: Infinity,
		};
		value.api.streams = [
			{
				rowId: "invalid",
				height: NaN,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: {
					minBitrate: NaN,
					maxBitrate: Infinity,
					lowComplexityBoundaryForMaxBitrate: -1,
				},
			},
		];
		const { container } = renderLocalized(
			<PerTitleParameterView proposal={value} />,
		);
		expect(globalValue("minBitrateStepSize")).toHaveTextContent("Invalid");
		expect(globalValue("maxBitrate (kbps)")).toHaveTextContent("Invalid");
		expect(
			globalValue("forcedRenditionAboveHighestFixedRepresentation"),
		).toHaveTextContent("Invalid");
		expect(screen.getByRole("row", { name: /Rendition 1/ })).toHaveTextContent(
			"Invalid",
		);
		expect(container).not.toHaveTextContent(/NaN|Infinity/);
	});
	it("keeps global parameters visible for an empty stream list", () => {
		const value = proposal();
		value.api.streams = [];
		renderLocalized(<PerTitleParameterView proposal={value} />);
		expect(globalValue("maxBitrateStepSize")).toHaveTextContent(/^3$/);
		expect(screen.getByText("No streams")).toBeVisible();
	});
});
