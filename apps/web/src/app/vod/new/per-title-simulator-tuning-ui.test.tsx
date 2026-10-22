import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";

const fixed: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100000,
	maxBitrate: 2400000,
	countPolicy: { kind: "exact", count: 3 },
	rows: [
		{ id: "a", height: 240, minBitrate: 160000, maxBitrate: 200000 },
		{ id: "b", height: 480, minBitrate: 400000, maxBitrate: 480000 },
		{ id: "c", height: 720, minBitrate: 1000000, maxBitrate: 1200000 },
	],
};

function api() {
	return JSON.parse(
		screen.getByTestId("per-title-api-settings").textContent ?? "{}",
	);
}

describe("Per-Title field policy integration", () => {
	it.each([
		"VP9",
		"AV1",
	] as const)("projects unseeded %s settings without losing the cached H264 factors or row policies", (codec) => {
		const source: PerTitleGoal = {
			...fixed,
			targetQualityCrf: 21,
			codecMinBitrateFactor: 0.8,
			codecMaxBitrateFactor: 1.2,
			codecBufsizeFactor: 2,
			rows: fixed.rows?.map((row) =>
				row.id === "a"
					? { ...row, codecMaxBitrateFactor: 1.3, codecBufsizeFactor: 2.2 }
					: row,
			),
			adjustments: {
				global: {
					targetQualityCrf: { mode: "fixed" },
					codecMinBitrateFactor: { mode: "fixed" },
					codecMaxBitrateFactor: { mode: "fixed" },
					codecBufsizeFactor: { mode: "fixed" },
				},
				streams: {
					a: {
						minBitrate: { mode: "fixed" },
						codecMaxBitrateFactor: { mode: "fixed" },
						codecBufsizeFactor: { mode: "fixed" },
					},
				},
			},
		};
		const snapshot = structuredClone(source);
		renderLocalized(
			<PerTitleSimulator
				open
				initialGoal={source}
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: codec },
		});
		const target = api();
		for (const key of [
			"targetQualityCrf",
			"targetQualityQp",
			"codecMinBitrateFactor",
			"codecMaxBitrateFactor",
			"codecBufsizeFactor",
		])
			expect(target.global).not.toHaveProperty(key);
		expect(target.streams).toHaveLength(3);
		for (const row of target.streams) {
			expect(row.perTitleSettings).not.toHaveProperty("codecMaxBitrateFactor");
			expect(row.perTitleSettings).not.toHaveProperty("codecBufsizeFactor");
		}
		expect(target.streams.map((row: { height: number }) => row.height)).toEqual(
			[240, 480, 720],
		);
		expect(
			screen.getByRole("combobox", {
				name: "Minimum bitrate (kbps), rendition 1 adjustment",
			}),
		).toHaveValue("fixed");
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeEnabled();
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H264" },
		});
		expect(api().global).toMatchObject({
			targetQualityCrf: 21,
			codecMinBitrateFactor: 0.8,
			codecMaxBitrateFactor: 1.2,
			codecBufsizeFactor: 2,
		});
		expect(
			api().streams.find((row: { rowId: string }) => row.rowId === "a")
				.perTitleSettings,
		).toMatchObject({ codecMaxBitrateFactor: 1.3, codecBufsizeFactor: 2.2 });
		expect(source).toEqual(snapshot);
	});

	it("starts unseeded H264 quality at the encoder default instead of converting a cached HEVCv2 QP", () => {
		const source: PerTitleGoal = {
			...fixed,
			codec: "H265V2",
			targetQualityQp: 18,
			adjustments: { global: { targetQualityQp: { mode: "fixed" } } },
		};
		renderLocalized(
			<PerTitleSimulator
				open
				initialGoal={source}
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H264" },
		});
		expect(api().global).not.toHaveProperty("targetQualityQp");
		expect(api().global).not.toHaveProperty("targetQualityCrf");
		expect(
			screen.getByRole("spinbutton", { name: "Target quality (CRF)" }),
		).toHaveValue(null);
		expect(
			screen.getByRole("combobox", { name: "Target quality (CRF) adjustment" }),
		).toHaveValue("auto");
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeEnabled();
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H265V2" },
		});
		expect(api().global.targetQualityQp).toBe(18);
		expect(
			screen.getByRole("combobox", { name: "Target quality (QP) adjustment" }),
		).toHaveValue("fixed");
	});

	it.each([
		"en",
		"ja",
	] as const)("freezes an automatically scaled bound at its displayed value and keeps it through review (%s)", (locale) => {
		const props = {
			initialGoal: fixed,
			onOpenChange: vi.fn(),
			onApply: vi.fn(),
		};
		const { rerender } = renderLocalized(
			<PerTitleSimulator {...props} open />,
			locale,
		);
		const minimum =
			locale === "en" ? "Minimum bitrate (kbps)" : "最小ビットレート (kbps)";
		const maximum =
			locale === "en" ? "Maximum bitrate (kbps)" : "最大ビットレート (kbps)";
		const modeName = `${minimum} ${locale === "en" ? "adjustment" : "の調整"}`;
		fireEvent.change(screen.getByRole("combobox", { name: modeName }), {
			target: { value: "auto" },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: maximum }), {
			target: { value: "4800" },
		});
		expect(screen.getByRole("spinbutton", { name: minimum })).toHaveValue(200);
		fireEvent.change(screen.getByRole("combobox", { name: modeName }), {
			target: { value: "fixed" },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: maximum }), {
			target: { value: "9600" },
		});
		expect(screen.getByRole("spinbutton", { name: minimum })).toHaveValue(200);
		expect(api().global.minBitrate).toBe(200000);
		rerender(<PerTitleSimulator {...props} open={false} />);
		rerender(<PerTitleSimulator {...props} open />);
		expect(screen.getByRole("combobox", { name: modeName })).toHaveValue(
			"fixed",
		);
		expect(screen.getByRole("spinbutton", { name: minimum })).toHaveValue(200);
	});

	it("retains a captured fixed spacing value when count and strategy change", () => {
		renderLocalized(
			<PerTitleSimulator
				open
				initialGoal={fixed}
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByText("Bitrate spacing", { selector: "summary" }),
		);
		const field = screen.getByRole("spinbutton", {
			name: "Minimum bitrate ratio",
		});
		const value = (field as HTMLInputElement).valueAsNumber;
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Minimum bitrate ratio adjustment",
			}),
			{ target: { value: "fixed" } },
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Desired count" }),
			{ target: { value: "5" } },
		);
		fireEvent.change(
			screen.getByRole("combobox", { name: "What should Per-Title choose?" }),
			{ target: { value: "required-resolutions" } },
		);
		expect(field).toHaveValue(value);
		expect(api().global.minBitrateStepSize).toBe(value);
	});

	it("edits an implicit automatic template and retains its field policies separately by codec", () => {
		const automatic: PerTitleGoal = {
			...fixed,
			strategy: "automatic",
			countPolicy: { kind: "unrestricted" },
			rows: [],
		};
		renderLocalized(
			<PerTitleSimulator
				open
				initialGoal={automatic}
				goalsByCodec={{
					H264: automatic,
					H265: { ...automatic, codec: "H265" },
				}}
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByText("Per-Title settings", { selector: "summary" }),
		);
		const factorName = "Codec maximum bitrate factor, rendition 1";
		fireEvent.change(screen.getByRole("spinbutton", { name: factorName }), {
			target: { value: "1.4" },
		});
		expect(api().streams[0].perTitleSettings.codecMaxBitrateFactor).toBe(1.4);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H265" },
		});
		expect(screen.getByRole("spinbutton", { name: factorName })).toHaveValue(
			null,
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H264" },
		});
		expect(screen.getByRole("spinbutton", { name: factorName })).toHaveValue(
			1.4,
		);
		expect(
			screen.getByRole("combobox", { name: `${factorName} adjustment` }),
		).toHaveValue("fixed");
	});
});
