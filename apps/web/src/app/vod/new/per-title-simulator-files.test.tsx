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
});

describe("simulator requirement files", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps file operations in details without requesting local presets (%s)", async (locale) => {
		const { onLoad } = show(locale);
		expect(onLoad).not.toHaveBeenCalled();
		const name =
			locale === "en" ? "Load requirements file" : "要件ファイルを読み込む";
		expect(screen.getByRole("button", { name })).not.toBeVisible();
		fireEvent.click(
			screen.getByText(
				locale === "en"
					? "Import or export requirements"
					: "要件ファイルの読み書き",
			),
		);
		expect(screen.getByRole("button", { name })).toBeVisible();
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("loads a requirements file with its source reference", async () => {
		const { onLoad } = show();
		fireEvent.click(screen.getByText("Import or export requirements"));
		await userEvent
			.setup()
			.upload(
				screen.getByLabelText("Load requirements file"),
				new File(
					[JSON.stringify({ version: 1, goal, reference })],
					"requirements.json",
					{ type: "application/json" },
				),
			);
		await waitFor(() => expect(onLoad).toHaveBeenCalledOnce());
		expect(onLoad).toHaveBeenLastCalledWith(goal, reference);
	});

	it("rejects an unavailable codec without changing the current goal", async () => {
		const { onLoad } = show("en", ["H264"]);
		fireEvent.click(screen.getByText("Import or export requirements"));
		await userEvent.setup().upload(
			screen.getByLabelText("Load requirements file"),
			new File([JSON.stringify({ version: 1, goal })], "requirements.json", {
				type: "application/json",
			}),
		);
		await screen.findByRole("alert");
		expect(onLoad).not.toHaveBeenCalled();
		expect(screen.getByTestId("maximum")).toHaveTextContent("5000000");
	});

	it("rejects oversized files without reading or changing the goal", () => {
		const { onLoad } = show();
		fireEvent.click(screen.getByText("Import or export requirements"));
		fireEvent.change(screen.getByLabelText("Load requirements file"), {
			target: { files: [new File(["x".repeat(128 * 1024 + 1)], "large.json")] },
		});
		expect(screen.getByRole("alert")).toBeVisible();
		expect(onLoad).not.toHaveBeenCalled();
	});

	it("aborts a pending file when the editing context changes and ignores its late result", () => {
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
			const { onLoad } = show();
			fireEvent.change(screen.getByLabelText("Load requirements file"), {
				target: { files: [new File(["{}"], "slow.json")] },
			});
			fireEvent.click(screen.getByRole("button", { name: "Edit limit" }));
			act(() => readers[0]?.onload?.());
			expect(readers[0]?.abort).toHaveBeenCalled();
			expect(onLoad).not.toHaveBeenCalled();
			expect(screen.getByTestId("maximum")).toHaveTextContent("9000000");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
