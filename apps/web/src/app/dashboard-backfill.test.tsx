import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DashboardBackfill } from "./dashboard-backfill";

const apiFetch = vi.fn();
const allowed = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => allowed(),
}));
const job = {
	accountId: "a1",
	from: "2020-01-01",
	to: "2020-12-31",
	status: "completed",
	completedChunks: 30,
	totalChunks: 30,
	rowsUpserted: 200,
	error: null,
};
beforeEach(() => {
	vi.clearAllMocks();
	allowed.mockReturnValue(true);
});
it("imports the selected account/range and refreshes its usage on completion", async () => {
	apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => ({
		job: init?.method === "POST" ? job : null,
	}));
	const { client } = renderWithQuery(
		<DashboardBackfill accountId="a1" from="2020-01-01" to="2020-12-31" />,
	);
	const invalidate = vi.spyOn(client, "invalidateQueries");
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
	fireEvent.click(
		screen.getByRole("button", { name: "Import statistics for this period" }),
	);
	await screen.findByText(/Import complete/);
	expect(apiFetch).toHaveBeenCalledWith("/api/dashboard/usage/backfill", {
		method: "POST",
		body: JSON.stringify({
			accountId: "a1",
			from: "2020-01-01",
			to: "2020-12-31",
		}),
	});
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: ["dashboard-usage", "a1"],
	});
});
it("keeps provider writes hidden from a viewer", async () => {
	allowed.mockReturnValue(false);
	apiFetch.mockResolvedValue({ job: null });
	renderWithQuery(
		<DashboardBackfill accountId="a1" from="2020-01-01" to="2020-12-31" />,
	);
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
	expect(screen.queryByRole("button")).toBeNull();
});

it("keeps a previous import's dates visible when they differ from the displayed period", async () => {
	apiFetch.mockResolvedValue({ job });
	renderWithQuery(
		<DashboardBackfill accountId="a1" from="2026-10-01" to="2026-10-03" />,
	);
	const status = await screen.findByRole("status");
	expect(status).toHaveTextContent("2020-01-01 — 2020-12-31: Import complete");
});
it("shows a failed import with a retry action instead of reporting completion", async () => {
	apiFetch.mockResolvedValue({ job: { ...job, status: "failed" } });
	renderWithQuery(
		<DashboardBackfill accountId="a1" from="2020-01-01" to="2020-12-31" />,
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Could not import statistics",
	);
	expect(
		screen.getByRole("button", {
			name: "Import statistics for this period",
		}),
	).toBeEnabled();
	expect(screen.queryByText(/Import complete/)).toBeNull();
});
it("prevents a second import while the account job is active", async () => {
	apiFetch.mockResolvedValue({
		job: { ...job, status: "running", completedChunks: 2 },
	});
	renderWithQuery(
		<DashboardBackfill accountId="a1" from="2020-01-01" to="2020-12-31" />,
	);
	await screen.findByText(/Importing \(2\/30\)/);
	expect(
		screen.getByRole("button", {
			name: "Import statistics for this period",
		}),
	).toBeDisabled();
});

it("retains the queued POST result when an older status read resolves late and keeps polling", async () => {
	let finishOldRead!: (value: { job: null }) => void;
	const oldRead = new Promise<{ job: null }>((resolve) => {
		finishOldRead = resolve;
	});
	let reads = 0;
	const queued = { job: { ...job, status: "queued", completedChunks: 0 } };
	apiFetch.mockImplementation((_url: string, init?: RequestInit) => {
		if (init?.method === "POST") return Promise.resolve(queued);
		reads += 1;
		return reads === 1 ? oldRead : Promise.resolve({ job });
	});
	const { client } = renderWithQuery(
		<DashboardBackfill accountId="a1" from="2020-01-01" to="2020-12-31" />,
	);
	await waitFor(() => expect(reads).toBe(1));
	fireEvent.click(
		screen.getByRole("button", { name: "Import statistics for this period" }),
	);
	await screen.findByText(/Waiting to import/);
	await act(async () => {
		finishOldRead({ job: null });
		await oldRead;
	});
	expect(client.getQueryData(["dashboard-backfill", "a1"])).toEqual(queued);
	expect(
		screen.getByRole("button", {
			name: "Import statistics for this period",
		}),
	).toBeDisabled();
	await screen.findByText(/Import complete/, {}, { timeout: 3500 });
	expect(reads).toBe(2);
});

it("retries failed status reads without starting another import", async () => {
	apiFetch
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ job: null });
	renderWithQuery(
		<DashboardBackfill accountId="a1" from="2020-01-01" to="2020-12-31" />,
	);
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
