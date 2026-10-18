import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GlobalError from "@/app/global-error";
import { LiveEncodingPicker } from "@/app/settings/live/live-encoding-picker";
import { CodecBadge, MuxingBadge } from "@/components/codec-badge";
import { CopyButton } from "@/components/copy-button";
import { renderLocalized, renderWithQuery } from "@/test/render";

/**
 * Battery batch 2h (ledger #149): the shell and atom components. Notable
 * absentee NOT here: NotFoundView already has its own test (it exists
 * BECAUSE the built-in 404 shipped English inside Japanese chrome), and
 * the ui primitives (Button, Dialog, Tabs, inputs) are exercised through
 * hundreds of component tests — a direct mount would re-prove what every
 * other file proves.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("GlobalError (ledger #149 batch 2h)", () => {
	it("names the failure, shows the digest, and offers retry + dashboard", () => {
		const reset = vi.fn();
		const error = Object.assign(new Error("boom"), { digest: "dg-42" });
		renderLocalized(<GlobalError error={error} reset={reset} />);
		// Deliberately English — this boundary is the handler for "the i18n
		// layer threw" and renders outside every provider.
		expect(
			screen.getByText("Something broke while rendering this page"),
		).toBeInTheDocument();
		expect(screen.getByText("dg-42")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(reset).toHaveBeenCalledOnce();
		expect(
			screen.getByRole("link", { name: "Back to the dashboard" }),
		).toHaveAttribute("href", "/");
	});
});

describe("badges (ledger #149 batch 2h)", () => {
	it("CodecBadge styles by the CORE family; MuxingBadge stays neutral", () => {
		renderLocalized(
			<>
				<CodecBadge codec="H264" family="video" />
				<CodecBadge codec="AAC" family="audio" />
				<MuxingBadge kind="FMP4" />
			</>,
		);
		const video = screen.getByText("H264");
		const audio = screen.getByText("AAC");
		expect(video.className).toContain("emerald");
		expect(audio.className).toContain("sky");
		expect(screen.getByText("FMP4").className).not.toContain("emerald");
	});
});

describe("CopyButton (ledger #149 batch 2h)", () => {
	it("writes the value to the clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		renderLocalized(<CopyButton value="enc-123" label="Copy encoding id" />);
		fireEvent.click(screen.getByRole("button", { name: "Copy encoding id" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("enc-123"));
	});

	it("announces a successful copy through a polite localized live region", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		renderLocalized(
			<CopyButton value="enc-456" label="エンコーディング ID をコピー" />,
			"ja",
		);
		fireEvent.click(
			screen.getByRole("button", { name: "エンコーディング ID をコピー" }),
		);

		const status = screen.getByRole("status");
		await waitFor(() => expect(status).toHaveTextContent("コピーしました"));
		expect(status).toHaveAttribute("aria-live", "polite");
	});
});

describe("LiveEncodingPicker (ledger #149 batch 2h)", () => {
	it("lists RUNNING channels first and lets local rows win the dedup", async () => {
		apiFetch.mockResolvedValue({
			items: [
				{
					id: "ch-a",
					name: "stopped-first-by-date",
					status: "STOPPED",
					bitmovinEncodingId: "enc-stopped",
				},
				{
					id: "ch-b",
					name: "running-later",
					status: "RUNNING",
					bitmovinEncodingId: "enc-running",
				},
				// No encoder yet — must not appear as a candidate at all.
				{
					id: "ch-c",
					name: "draft",
					status: "DRAFT",
					bitmovinEncodingId: null,
				},
			],
		});
		renderWithQuery(
			<LiveEncodingPicker
				inputId="lep-1"
				value=""
				onChange={vi.fn()}
				extraCandidates={[
					// Duplicate of a local row (local wins) + one genuinely extra.
					{ id: "enc-running", label: "stale-copy" },
					{ id: "enc-extra", label: "from-alert-rule" },
				]}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("running-later")).toBeInTheDocument(),
		);
		const items = [...document.querySelectorAll("li")].map(
			(li) => li.textContent ?? "",
		);
		const runningIndex = items.findIndex((s) => s.includes("running-later"));
		const stoppedIndex = items.findIndex((s) =>
			s.includes("stopped-first-by-date"),
		);
		expect(runningIndex).toBeGreaterThanOrEqual(0);
		expect(runningIndex).toBeLessThan(stoppedIndex);
		// The duplicate extra lost to the local row; the genuine extra survives.
		expect(screen.queryByText("stale-copy")).toBeNull();
		expect(screen.getByText("from-alert-rule")).toBeInTheDocument();
		// The encoder-less channel contributed nothing.
		expect(screen.queryByText("draft")).toBeNull();
	});
});
