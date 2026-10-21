import type { PerTitleGoal } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulatorFiles } from "./per-title-simulator-files";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const goal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H265",
	minBitrate: 100_000,
	maxBitrate: 5_000_000,
	countPolicy: { kind: "maximum", count: 5 },
	rows: [
		{ id: "required", height: 540, minBitrate: 400_000, maxBitrate: 900_000 },
	],
	automaticTemplates: [
		{ id: "automatic", height: 1080, minBitrate: 1_000_000 },
	],
};
const reference = {
	codec: "H265",
	global: { minBitrate: goal.minBitrate, maxBitrate: goal.maxBitrate },
	streams: [
		{
			id: "required",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			height: 540,
			perTitleSettings: { minBitrate: 400_000, maxBitrate: 900_000 },
		},
		{
			id: "automatic",
			mode: "PER_TITLE_TEMPLATE",
			height: 1080,
			perTitleSettings: { minBitrate: 1_000_000 },
		},
	],
};
const preset = {
	id: "reference-hevc",
	label: "Reference HEVC",
	contents: JSON.stringify({ version: 1, goal }),
};

function show(
	locale: "en" | "ja" = "en",
	allowedCodecs: Array<"H264" | "H265"> = ["H264", "H265"],
) {
	const onLoad = vi.fn();
	function Harness() {
		const [current, setCurrent] = useState(goal);
		return (
			<>
				<PerTitleSimulatorFiles
					goal={current}
					allowedCodecs={allowedCodecs}
					onLoad={(next, source) => {
						onLoad(next, source);
						setCurrent(next);
					}}
				/>
				<button
					type="button"
					onClick={() => setCurrent({ ...current, maxBitrate: 9_000_000 })}
				>
					Edit limit
				</button>
				<output data-testid="maximum">{current.maxBitrate}</output>
			</>
		);
	}
	return { ...renderLocalized(<Harness />, locale), onLoad };
}

beforeEach(() => {
	vi.mocked(apiFetch).mockReset();
	vi.mocked(apiFetch).mockResolvedValue({ presets: [] });
});

describe("local simulator presets", () => {
	it.each([
		"en",
		"ja",
	] as const)("loads the named preset with one click and restores its original values on reuse (%s)", async (locale) => {
		vi.mocked(apiFetch).mockResolvedValue({ presets: [preset] });
		const { onLoad } = show(locale);
		const button = await screen.findByRole("button", {
			name: "Reference HEVC",
		});
		expect(onLoad).not.toHaveBeenCalled();
		expect(
			screen.getByText(locale === "en" ? "Test presets" : "テスト用プリセット"),
		).toBeVisible();
		expect(
			screen.getByRole("button", {
				name:
					locale === "en" ? "Load requirements file" : "要件ファイルを読み込む",
			}),
		).not.toBeVisible();
		await userEvent.setup().click(button);
		expect(onLoad).toHaveBeenLastCalledWith(goal, undefined);
		fireEvent.click(screen.getByRole("button", { name: "Edit limit" }));
		expect(screen.getByTestId("maximum")).toHaveTextContent("9000000");
		await userEvent.setup().click(button);
		expect(screen.getByTestId("maximum")).toHaveTextContent("5000000");
		expect(onLoad).toHaveBeenCalledTimes(2);
		expect(apiFetch).toHaveBeenCalledTimes(1);
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/per-title-simulator-presets",
			expect.objectContaining({
				cache: "no-store",
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("keeps file controls available when no local presets are configured", async () => {
		const { onLoad } = show();
		await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
		expect(screen.queryByText("Test presets")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Load requirements file" }),
		).toBeVisible();
		expect(onLoad).not.toHaveBeenCalled();
	});

	it("preserves reference-only metadata when loading a local preset", async () => {
		vi.mocked(apiFetch).mockResolvedValue({
			presets: [
				{
					...preset,
					contents: JSON.stringify({ version: 1, goal, reference }),
				},
			],
		});
		const { onLoad } = show();
		await userEvent
			.setup()
			.click(await screen.findByRole("button", { name: "Reference HEVC" }));
		expect(onLoad).toHaveBeenLastCalledWith(goal, reference);
	});

	it("rejects a codec that the current session does not allow", async () => {
		vi.mocked(apiFetch).mockResolvedValue({ presets: [preset] });
		const { onLoad } = show("en", ["H264"]);
		await userEvent
			.setup()
			.click(await screen.findByRole("button", { name: "Reference HEVC" }));
		expect(onLoad).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"This preset cannot be loaded.",
		);
	});

	it("aborts a pending file before loading the preset so that the file cannot overwrite it", async () => {
		const readers: Array<{
			result: string;
			onload?: () => void;
			abort: () => void;
		}> = [];
		class DelayedReader {
			static LOADING = 1;
			readyState = 1;
			result = JSON.stringify({
				version: 1,
				goal: { ...goal, maxBitrate: 20_000_000 },
			});
			onload?: () => void;
			constructor() {
				readers.push(this);
			}
			readAsText() {}
			abort = vi.fn(() => {
				this.readyState = 2;
			});
		}
		vi.stubGlobal("FileReader", DelayedReader);
		try {
			vi.mocked(apiFetch).mockResolvedValue({ presets: [preset] });
			const { onLoad } = show();
			const button = await screen.findByRole("button", {
				name: "Reference HEVC",
			});
			fireEvent.change(screen.getByLabelText("Load requirements file"), {
				target: { files: [new File(["{}"], "slow.json")] },
			});
			await userEvent.setup().click(button);
			act(() => readers[0]?.onload?.());
			expect(readers[0]?.abort).toHaveBeenCalled();
			expect(onLoad).toHaveBeenCalledOnce();
			expect(onLoad).toHaveBeenCalledWith(goal, undefined);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("ignores a late list response after unmount and cancels its request", async () => {
		let resolve!: (value: unknown) => void;
		vi.mocked(apiFetch).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const { unmount, onLoad } = show();
		expect(apiFetch).toHaveBeenCalledOnce();
		const signal = vi.mocked(apiFetch).mock.calls[0]?.[1]?.signal;
		unmount();
		expect(signal?.aborted).toBe(true);
		await act(async () => resolve({ presets: [preset] }));
		expect(onLoad).not.toHaveBeenCalled();
	});
});
