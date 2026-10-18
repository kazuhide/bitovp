import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

/**
 *  PR2 — the Settings page. Pins: the credential picker offers
 * ONLY NOTIFICATION_WEBHOOK rows (any other provider would bypass the C22
 * rails the POST route also gates on — two layers, same reason), the create
 * POST carries the selected kinds + label filter, and a failed delivery row
 * renders its reason.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { NotificationsClient } from "./notifications-client";

const CRED = "00000000-0000-4000-8000-0000000000d1";

function route(url: string): unknown {
	if (url === "/api/notifications/channels") {
		return [];
	}
	if (url === "/api/credentials") {
		return [
			{ id: CRED, label: "slack-ops", provider: "NOTIFICATION_WEBHOOK" },
			{ id: "x", label: "an-s3-bucket", provider: "AWS_S3" },
		];
	}
	if (url === "/api/notifications/deliveries") {
		return {
			failed: [
				{
					id: "1",
					state: "FAILED",
					kind: "JOB_ERROR",
					occurredAt: "2026-08-12T00:00:00.000Z",
					link: null,
					attemptsMade: 5,
					failedReason: "HTTP 500",
				},
			],
			completed: [],
		};
	}
	return {};
}

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockImplementation((url: string) => Promise.resolve(route(url)));
});

describe("NotificationsClient", () => {
	it("carries the page's ONE level-1 heading (E2E 2026-08-14 / review-206 I-1)", async () => {
		renderWithQuery(<NotificationsClient />, "ja");
		const h1s = await screen.findAllByRole("heading", { level: 1 });
		expect(h1s).toHaveLength(1);
		expect(h1s[0]).toHaveTextContent("通知");
	});

	it("offers ONLY NOTIFICATION_WEBHOOK credentials in the picker", async () => {
		renderWithQuery(<NotificationsClient />);
		expect(await screen.findByText("slack-ops")).toBeInTheDocument();
		expect(screen.queryByText("an-s3-bucket")).toBeNull();
	});

	it("creates a channel with the selected kinds and the label filter", async () => {
		renderWithQuery(<NotificationsClient />);
		await screen.findByText("slack-ops");
		await userEvent.type(screen.getByLabelText("Channel name"), "ops-alerts");
		await userEvent.selectOptions(
			screen.getByLabelText("Webhook credential"),
			CRED,
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: /Label filter/ }),
			"prod, drama",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Create channel" }),
		);
		await waitFor(() => {
			const post = apiFetch.mock.calls.find(
				(call) => call[1] && (call[1] as RequestInit).method === "POST",
			);
			expect(post).toBeDefined();
			const body = JSON.parse((post?.[1] as RequestInit).body as string);
			expect(body).toMatchObject({
				name: "ops-alerts",
				kind: "SLACK_WEBHOOK",
				credentialId: CRED,
			});
			expect(body.rules[0].events).toEqual(
				expect.arrayContaining(["JOB_ERROR", "CHANNEL_ERROR"]),
			);
			expect(body.rules[0].filter).toEqual({ labels: ["prod", "drama"] });
		});
	});

	it("renders a FAILED delivery with its reason and attempt count", async () => {
		renderWithQuery(<NotificationsClient />);
		expect(await screen.findByText("FAILED")).toBeInTheDocument();
		expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
		expect(screen.getByText(/5 attempts/)).toBeInTheDocument();
	});
});

it("shows recoverable query errors instead of an empty notification screen", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	renderWithQuery(<NotificationsClient />);
	expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
	expect(screen.queryByText(/need.*webhook credential/i)).toBeNull();
	apiFetch.mockImplementation((url: string) => Promise.resolve(route(url)));
	for (const retry of screen.getAllByRole("button", { name: "Retry" }))
		await userEvent.click(retry);
	expect(await screen.findByText("slack-ops")).toBeInTheDocument();
});

it("prevents duplicate channel creates while the first request is pending", async () => {
	apiFetch.mockImplementation((url: string, init?: RequestInit) =>
		init?.method === "POST"
			? new Promise(() => {})
			: Promise.resolve(route(url)),
	);
	renderWithQuery(<NotificationsClient />);
	await screen.findByText("slack-ops");
	await userEvent.type(screen.getByLabelText("Channel name"), "ops-alerts");
	await userEvent.selectOptions(
		screen.getByLabelText("Webhook credential"),
		CRED,
	);
	const create = screen.getByRole("button", { name: "Create channel" });
	await userEvent.click(create);
	await waitFor(() => expect(create).toBeDisabled());
	expect(screen.getByLabelText("Channel name")).toBeDisabled();
});

it("keeps failed channel actions visible and requires delete confirmation", async () => {
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
	apiFetch.mockImplementation((url: string, init?: RequestInit) => {
		if (init?.method) return Promise.reject(new Error("offline"));
		return Promise.resolve(
			url === "/api/notifications/channels"
				? [
						{
							id: "channel",
							name: "Ops",
							kind: "SLACK_WEBHOOK",
							credentialId: CRED,
							credentialLabel: "slack-ops",
							enabled: true,
							rules: [],
						},
					]
				: route(url),
		);
	});
	renderWithQuery(<NotificationsClient />);
	await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
	expect(confirm).toHaveBeenCalled();
	expect(apiFetch.mock.calls.some((call) => call[1]?.method === "DELETE")).toBe(
		false,
	);
	await userEvent.click(screen.getByRole("button", { name: "Disable" }));
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	confirm.mockRestore();
});
