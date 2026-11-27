import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { EncodingStatisticsClient } from "./statistics-client";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

const accountId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const endpoint = "/api/encoding-native/statistics";

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/bitmovin-accounts")
			return [
				{ id: accountId, label: "Studio" },
				{ id: otherId, label: "Archive" },
			];
		const query = new URL(url, "https://fixture.invalid").searchParams;
		const offset = Number(query.get("offset") ?? 0);
		if (query.has("from"))
			return {
				rows: [{ date: "2026-01-01", billableMinutes: 7 }],
				page: { offset: 0, totalCount: 6, received: 1, nextOffset: null },
			};
		return {
			rows: [
				{
					date: offset === 0 ? "2026-01-01" : "2026-01-02",
					billableMinutes: 7,
				},
			],
			page: {
				offset,
				totalCount: 2,
				received: 1,
				nextOffset: offset === 0 ? 1 : null,
			},
		};
	});
});

async function selectDaily() {
	renderWithQuery(<EncodingStatisticsClient />);
	await screen.findByRole("option", { name: "Studio" });
	fireEvent.change(screen.getByLabelText("Bitmovin account"), {
		target: { value: accountId },
	});
	fireEvent.change(screen.getByLabelText("Statistics"), {
		target: { value: "daily" },
	});
}

it("advances by the received provider count and clears results on account changes", async () => {
	await selectDaily();
	expect(apiFetch).toHaveBeenCalledTimes(1);
	fireEvent.click(screen.getByRole("button", { name: "Load statistics" }));
	expect(await screen.findByText("2026-01-01")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Next page" }));
	expect(await screen.findByText("2026-01-02")).toBeInTheDocument();
	expect(apiFetch).toHaveBeenCalledWith(
		`${endpoint}?view=daily&accountId=${accountId}&offset=1`,
		expect.objectContaining({ signal: expect.any(AbortSignal) }),
	);

	fireEvent.change(screen.getByLabelText("Bitmovin account"), {
		target: { value: otherId },
	});
	expect(screen.queryByText("2026-01-02")).toBeNull();
	expect(apiFetch).toHaveBeenCalledTimes(3);
});

it("shows a provider date-range prefix without offering an unsupported next page", async () => {
	await selectDaily();
	fireEvent.click(screen.getByLabelText("Use a date range"));
	fireEvent.change(screen.getByLabelText("From (UTC)"), {
		target: { value: "2026-01-01" },
	});
	fireEvent.change(screen.getByLabelText("To (UTC)"), {
		target: { value: "2026-02-10" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Load statistics" }));
	expect(
		await screen.findByText(
			"Bitmovin returned 1 of 6 entries for this date range.",
		),
	).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
});
