import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlatSection } from "@/app/live/[id]/flat-section";
import { InputIdPicker } from "@/app/live/[id]/input-id-picker";
import { RunsPanel } from "@/app/live/[id]/runs-panel";
import { StopFeederSessionDialog } from "@/app/live/feeders/stop-feeder-dialog";
import { renderWithQuery } from "@/test/render";

/**
 * Battery batch 2g : the live-side widgets no test had
 * mounted — the ledger-#30 server-side input search, the run history's
 * three states, the flat section chrome, and the feeder stop dialog.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("InputIdPicker (ledger #149 batch 2g)", () => {
	it("search is APPLIED, not per-keystroke — Enter refetches with &name=", async () => {
		apiFetch.mockResolvedValue({ items: [] });
		renderWithQuery(
			<InputIdPicker
				inputId="in-1"
				bitmovinAccountId="acct-1"
				value=""
				onChange={vi.fn()}
			/>,
		);
		await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
		const box = screen.getByLabelText("Search inputs by name");
		fireEvent.change(box, { target: { value: "srt" } });
		// Typing alone must NOT refetch .
		expect(apiFetch).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(box, { key: "Enter" });
		await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
		expect(String(apiFetch.mock.calls[1]?.[0])).toContain("name=srt");
	});

	it("a listing failure is worded, with the candidates gone", async () => {
		apiFetch.mockRejectedValue(new Error("down"));
		renderWithQuery(
			<InputIdPicker
				inputId="in-1"
				bitmovinAccountId="acct-1"
				value=""
				onChange={vi.fn()}
			/>,
		);
		expect(
			await screen.findByText(/Could not list this account's inputs/),
		).toBeInTheDocument();
	});
});

describe("RunsPanel (ledger #149 batch 2g)", () => {
	it("empty history says the channel has never started", async () => {
		apiFetch.mockResolvedValue({ runs: [] });
		renderWithQuery(<RunsPanel channelId="ch-1" />);
		expect(
			await screen.findByText(
				"No runs yet — this channel has never been started.",
			),
		).toBeInTheDocument();
	});

	it("a run row carries seq, status and safe recorded-failure copy", async () => {
		apiFetch.mockResolvedValue({
			runs: [
				{
					id: "run-1",
					seq: 3,
					status: "ERROR",
					createdAt: "2026-08-21T00:00:00.000Z",
					runningSince: "2026-08-21T00:01:00.000Z",
					endedAt: "2026-08-21T01:00:00.000Z",
					bitmovinEncodingId: "enc-123",
					outputPrefix: "",
					error: "encoder exploded",
				},
			],
		});
		renderWithQuery(<RunsPanel channelId="ch-1" />);
		expect(await screen.findByText("Run #3")).toBeInTheDocument();
		expect(screen.getByText("ERROR")).toBeInTheDocument();
		expect(
			screen.getByText(
				"The live operation encountered a problem. Check the activity history and current channel state, then retry if appropriate.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("encoder exploded")).not.toBeInTheDocument();
	});

	it("a re-aired run shows WHERE it wrote; a plan-paths run claims nothing (ledger #155)", async () => {
		apiFetch.mockResolvedValue({
			runs: [
				{
					id: "run-2",
					seq: 2,
					status: "STOPPED",
					createdAt: "2026-08-21T02:00:00.000Z",
					runningSince: "2026-08-21T02:01:00.000Z",
					endedAt: "2026-08-21T03:00:00.000Z",
					bitmovinEncodingId: "enc-456",
					outputPrefix: "output/live-x/runs/2-cafebabe",
					error: null,
				},
				{
					id: "run-1",
					seq: 1,
					status: "STOPPED",
					createdAt: "2026-08-21T00:00:00.000Z",
					runningSince: "2026-08-21T00:01:00.000Z",
					endedAt: "2026-08-21T01:00:00.000Z",
					bitmovinEncodingId: "enc-123",
					// Seq 1 / pre-#155: wrote at the plan's own paths — the
					// panel must NOT invent a location for it.
					outputPrefix: "",
					error: null,
				},
			],
		});
		renderWithQuery(<RunsPanel channelId="ch-1" />);
		expect(
			await screen.findByText("output/live-x/runs/2-cafebabe"),
		).toBeInTheDocument();
		expect(screen.getAllByText(/Run #/)).toHaveLength(2);
		expect(screen.queryAllByText(/runs\//)).toHaveLength(1);
	});
});

describe("FlatSection (ledger #149 batch 2g)", () => {
	it("renders the heading, the live summary line and the children", () => {
		renderWithQuery(
			<FlatSection id="sec-x" title="Ingest" summary="2 connected" tone="ok">
				<p>child content</p>
			</FlatSection>,
		);
		expect(screen.getByRole("heading", { name: /Ingest/ })).toBeInTheDocument();
		expect(screen.getByText("2 connected")).toBeInTheDocument();
		expect(screen.getByText("child content")).toBeInTheDocument();
	});
});

describe("StopFeederSessionDialog (ledger #149 batch 2g)", () => {
	it("confirm stops, cancel does not, stopping disables confirm", () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const { rerender } = renderWithQuery(
			<StopFeederSessionDialog
				open
				stopping={false}
				onCancel={onCancel}
				onConfirm={onConfirm}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onConfirm).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
		expect(onConfirm).toHaveBeenCalledOnce();
		rerender(
			<StopFeederSessionDialog
				open
				stopping
				onCancel={onCancel}
				onConfirm={onConfirm}
			/>,
		);
		expect(screen.getByRole("button", { name: "Stop session" })).toBeDisabled();
	});
});
