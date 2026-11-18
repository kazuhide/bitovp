import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { type JobListItem, JobsClient } from "../vod/jobs/jobs-client";
import { ChannelsClient } from "./channels-client";
import type { LiveChannelListItem } from "./live-shared";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

function item(
	id: string,
	name: string,
	status: "RUNNING" | "ERROR",
	createdAt: string,
): JobListItem & LiveChannelListItem {
	return {
		id,
		name,
		status,
		createdAt,
		updatedAt: createdAt,
		bitmovinEncodingId: null,
		bitmovinAccountId: null,
		error: null,
		labels: [],
		region: null,
		doneSteps: 0,
		totalSteps: 1,
		qcVerdict: null,
		finishedAt: null,
	};
}

const newest = item(
	"00000000-0000-4000-8000-000000000021",
	"Newest running",
	"RUNNING",
	"2026-11-19T01:00:00.000Z",
);
const newerId = item(
	"00000000-0000-4000-8000-000000000023",
	"Zebra ended",
	"ERROR",
	"2026-11-18T01:00:00.000Z",
);
const olderId = item(
	"00000000-0000-4000-8000-000000000022",
	"Albatross ended",
	"ERROR",
	newerId.createdAt,
);

describe.each([
	{ surface: "VOD", List: JobsClient, endpoint: "/api/encoding-jobs" },
	{ surface: "Live", List: ChannelsClient, endpoint: "/api/live-channels" },
])("$surface list operations", ({ List, endpoint }) => {
	beforeEach(() => {
		localStorage.clear();
		apiFetch.mockReset();
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/auth/session") {
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			}
			if (url === endpoint) {
				return { items: [newest, newerId], nextCursor: newerId.id };
			}
			if (url === `${endpoint}?cursor=${newerId.id}`) {
				return { items: [olderId] };
			}
			throw new Error(`Unexpected request: ${url}`);
		});
	});

	it("shows the newest rows first and preserves the API's tie order across pages", async () => {
		const user = userEvent.setup();
		renderWithQuery(<List />);
		await screen.findByRole("link", { name: newest.name });
		const table = within(screen.getByRole("table"));
		expect(table.getAllByRole("link").map((link) => link.textContent)).toEqual([
			newest.name,
			newerId.name,
		]);
		await user.click(screen.getByRole("button", { name: "Load more" }));
		await table.findByRole("link", { name: olderId.name });
		expect(table.getAllByRole("link").map((link) => link.textContent)).toEqual([
			newest.name,
			newerId.name,
			olderId.name,
		]);
	});

	it("opens named deletion confirmation directly from the row and protects active rows", async () => {
		const user = userEvent.setup();
		renderWithQuery(<List />);
		await screen.findByRole("link", { name: newerId.name });
		const table = within(screen.getByRole("table"));
		expect(
			table.getByRole("button", { name: `Delete ${newest.name} (disabled)` }),
		).toBeDisabled();
		const row = within(table.getByRole("row", { name: /Zebra ended/ }));
		await user.click(
			row.getByRole("button", { name: `Delete ${newerId.name}` }),
		);
		const dialog = within(
			screen.getByRole("dialog", { name: `Delete “${newerId.name}”?` }),
		);
		expect(dialog.getByRole("button", { name: "Delete" })).toBeEnabled();
		await user.click(dialog.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "DELETE"),
		).toBe(false);
	});
});
