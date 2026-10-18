import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { AlertsPanel } from "./alerts-panel";

/**
 *  PR2 — settings editor: global create payload, toggle PATCH,
 * and the TWO-CLICK delete (the cascade warning is the button label — an
 * accidental single click cannot destroy history).
 */

const RULE = {
	id: "00000000-0000-4000-8000-0000000000d7",
	liveChannelId: null,
	metric: "INPUT_DISCONNECTED",
	threshold: null,
	windowPolls: 2,
	severity: "CRIT" as const,
	enabled: true,
};

function mockApi(rules: unknown[] = [RULE]) {
	apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => {
		if (!init?.method) {
			return rules;
		}
		return { id: RULE.id };
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("AlertsPanel (settings)", () => {
	it("lists rules with scope and severity", async () => {
		mockApi();
		renderWithQuery(<AlertsPanel />);
		// "global" exists ONLY in a listed row — the form's option text
		// ("Input disconnected") renders before the query resolves and
		// cannot gate on it (the schedule-panel lesson, same file family).
		expect(await screen.findByText("global")).toBeInTheDocument();
		// CRIT also exists as a severity <option>; the ROW's copy is the badge.
		expect(screen.getAllByText("CRIT").length).toBeGreaterThan(1);
	});

	it("creates a GLOBAL rule (no channel id in the payload)", async () => {
		mockApi([]);
		renderWithQuery(<AlertsPanel />);
		await screen.findByText(/No rules yet/);
		await userEvent.selectOptions(
			screen.getByLabelText("Metric"),
			"BITRATE_BELOW",
		);
		await userEvent.type(screen.getByLabelText("Threshold"), "500000");
		await userEvent.click(
			screen.getByRole("button", { name: "Add global rule" }),
		);
		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as RequestInit).body as string);
			expect(body).toMatchObject({
				liveChannelId: null,
				metric: "BITRATE_BELOW",
				threshold: 500_000,
				windowPolls: 2,
			});
		});
	});

	it("toggle PATCHes the inverse enabled state", async () => {
		mockApi();
		renderWithQuery(<AlertsPanel />);
		await screen.findByText("global");
		await userEvent.click(screen.getByRole("button", { name: "Disable" }));
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/alert-rules/${RULE.id}`,
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({ enabled: false }),
				}),
			);
		});
	});

	it("delete opens a REAL Dialog naming the cascade; even a double-click cannot delete through it (review-83b I6)", async () => {
		mockApi();
		renderWithQuery(<AlertsPanel />);
		await screen.findByText("global");
		const trigger = screen.getByRole("button", { name: /Delete/ });
		// The reviewer's probe: the old inline pattern rendered confirm at
		// the trigger's DOM position, so a double-click fired the DELETE and
		// cascade-erased the rule's history.
		await userEvent.dblClick(trigger);
		expect(
			apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
			),
		).toBeUndefined();
		// The Dialog is open, names the cascade, and only ITS destructive
		// button deletes.
		expect(
			screen.getByText(/also deletes its ENTIRE alert history/),
		).toBeInTheDocument();
		const dialog = screen.getByRole("dialog");
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Delete" }),
		);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(`/api/alert-rules/${RULE.id}`, {
				method: "DELETE",
			});
		});
	});

	it("renders Japanese", async () => {
		mockApi();
		renderWithQuery(<AlertsPanel />, "ja");
		expect(await screen.findByText("グローバル")).toBeInTheDocument();
		expect(screen.getByText("ライブアラートルール")).toBeInTheDocument();
	});
});

it("exposes the origin-to-edge delay threshold and drops it for threshold-free metrics", async () => {
	mockApi([]);
	renderWithQuery(<AlertsPanel />);
	await userEvent.selectOptions(
		screen.getByLabelText("Metric"),
		"ORIGIN_EDGE_DELAY_ABOVE",
	);
	await userEvent.type(screen.getByLabelText("Threshold"), "5");
	await userEvent.click(
		screen.getByRole("button", { name: "Add global rule" }),
	);
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, opts]) => opts?.method === "POST"),
		).toBe(true),
	);
	const call = apiFetch.mock.calls.find(([, opts]) => opts?.method === "POST");
	expect(JSON.parse(call?.[1].body)).toMatchObject({
		metric: "ORIGIN_EDGE_DELAY_ABOVE",
		threshold: 5,
	});
	await userEvent.type(screen.getByLabelText("Threshold"), "10");
	await userEvent.selectOptions(
		screen.getByLabelText("Metric"),
		"INPUT_DISCONNECTED",
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Add global rule" }),
	);
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.filter(([, opts]) => opts?.method === "POST"),
		).toHaveLength(2),
	);
});

it("reports alert load and toggle failures", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	renderWithQuery(<AlertsPanel />);
	const retry = await screen.findByRole("button", { name: "Retry" });
	mockApi();
	await userEvent.click(retry);
	apiFetch.mockImplementation((_url: string, opts?: RequestInit) =>
		opts?.method
			? Promise.reject(new Error("offline"))
			: Promise.resolve([RULE]),
	);
	await userEvent.click(await screen.findByRole("button", { name: "Disable" }));
	expect(await screen.findByRole("alert")).toBeInTheDocument();
});
