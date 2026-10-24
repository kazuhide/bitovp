import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import {
	parsePerTitlePreset,
	serializePerTitlePreset,
} from "./per-title-simulator-preset";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const reference = {
	codec: "H264",
	global: {
		minBitrate: 80_000,
		maxBitrate: 5_000_000,
		minBitrateStepSize: 1.4,
		maxBitrateStepSize: 4,
	},
	streams: [
		{ id: "lower-candidate", mode: "PER_TITLE_TEMPLATE", height: 160 },
		...[
			{ id: "lower-first", height: 320, minimum: 200_000, maximum: 350_000 },
			{ id: "lower-second", height: 320, minimum: 500_000, maximum: 700_000 },
			{ id: "middle", height: 560, minimum: 1_000_000, maximum: 1_300_000 },
			{
				id: "upper-fixed",
				height: 800,
				minimum: 1_800_000,
				maximum: 2_300_000,
			},
		].map(({ id, height, minimum, maximum }) => ({
			id,
			height,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			perTitleSettings: { minBitrate: minimum, maxBitrate: maximum },
		})),
		{ id: "upper-candidate-a", mode: "PER_TITLE_TEMPLATE", height: 960 },
		{ id: "upper-candidate-b", mode: "PER_TITLE_TEMPLATE", height: 1280 },
	],
};
const requirements = { countPolicy: { kind: "exact", count: 6 } };
const contents = JSON.stringify({ version: 1, reference, requirements });
const parse = (value: unknown) =>
	parsePerTitlePreset(JSON.stringify(value), ["H264"]);

beforeEach(() => {
	vi.mocked(apiFetch).mockReset();
	vi.mocked(apiFetch).mockResolvedValue({ presets: [] });
});

describe("explicit preset count requirements", () => {
	it("loads six as a requirement while retaining all seven source templates", () => {
		const loaded = parsePerTitlePreset(contents, ["H264"]);
		expect(loaded.goal.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(loaded.goal.rows?.map(({ id }) => id)).toEqual([
			"lower-first",
			"lower-second",
			"middle",
			"upper-fixed",
		]);
		expect(loaded.goal.rows?.map(({ height }) => height)).toEqual([
			320, 320, 560, 800,
		]);
		expect(loaded.goal.automaticTemplates?.map(({ id }) => id)).toEqual([
			"lower-candidate",
			"upper-candidate-a",
			"upper-candidate-b",
		]);
		expect(loaded.reference).toEqual(reference);
		expect(
			parsePerTitlePreset(
				serializePerTitlePreset(loaded.goal, loaded.reference),
				["H264"],
			),
		).toEqual(loaded);
	});

	it("does not infer an output count from ordinary template candidates", () => {
		const loaded = parse({ version: 1, reference });
		expect(loaded.goal.countPolicy).toEqual({ kind: "unrestricted" });
		expect(loaded.goal.automaticTemplates).toHaveLength(3);
	});

	it.each([
		{ kind: "unrestricted" },
		{ kind: "exact", count: 5 },
		{ kind: "maximum", count: 6 },
	])("rejects conflicting count requirements instead of overriding an explicit goal %j", (countPolicy) => {
		const loaded = parse({ version: 1, reference });
		expect(() =>
			parse({
				version: 1,
				goal: { ...loaded.goal, countPolicy },
				reference,
				requirements,
			}),
		).toThrow("Invalid Per-Title preset.");
	});

	it("accepts agreeing explicit goal and requirement counts", () => {
		const loaded = parse({ version: 1, reference });
		const goal: PerTitleGoal = {
			...loaded.goal,
			countPolicy: { kind: "exact", count: 6 },
		};
		expect(parse({ version: 1, goal, reference, requirements }).goal).toEqual(
			goal,
		);
	});

	it.each([
		{ kind: "exact", count: 0 },
		{ kind: "maximum", count: 257 },
		{ kind: "exact", count: 6, nativeCount: 6 },
	])("rejects unsupported requirement counts %j", (countPolicy) => {
		expect(() =>
			parse({ version: 1, reference, requirements: { countPolicy } }),
		).toThrow("Invalid Per-Title preset.");
	});

	it.each([
		"en",
		"ja",
	] as const)("loads the explicit count into the simulator without treating candidates as outputs (%s)", async (locale) => {
		vi.mocked(apiFetch).mockResolvedValue({
			presets: [{ id: "mixed-reference", label: "Mixed reference", contents }],
		});
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={{
					strategy: "automatic",
					codec: "H264",
					minBitrate: 100_000,
					maxBitrate: 2_000_000,
					countPolicy: { kind: "unrestricted" },
				}}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Mixed reference" }),
		);
		expect(
			screen.getByRole("combobox", {
				name: locale === "ja" ? "レンディションの本数" : "Rendition count",
			}),
		).toHaveValue("exact");
		expect(
			screen.getByRole("spinbutton", {
				name: locale === "ja" ? "希望する本数" : "Desired count",
			}),
		).toHaveValue(6);
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "{}",
		);
		expect(api.streams).toHaveLength(7);
		expect(
			api.streams
				.filter(
					(stream: { mode: string }) => stream.mode === "PER_TITLE_TEMPLATE",
				)
				.map((stream: { rowId: string }) => stream.rowId),
		).toEqual(["lower-candidate", "upper-candidate-a", "upper-candidate-b"]);
		expect(onApply).not.toHaveBeenCalled();
	});
});
