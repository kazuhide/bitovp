import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { InsertedContentStopPanel } from "./insertion-stop-panel";
import { SlateReservationsPanel } from "./slate-reservations-panel";

const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CONTENT_ID = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";

function users(role: "VIEWER" | "OPERATOR"): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		role,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("slate action role transitions", () => {
	it("keeps the reservation queue readable to a VIEWER without offering DELETE", async () => {
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === "/api/auth/session") {
				return users("VIEWER");
			}
			if (url.includes("/insertable-content/scheduled?")) {
				return {
					items: [
						{
							id: "22223333-4444-4555-8666-777788889999",
							name: "Future slate",
							contentId: CONTENT_ID,
							status: "SCHEDULED",
							runAt: "2026-09-07T12:00:00.000Z",
							durationInSeconds: 30,
						},
					],
					totalCount: 1,
				};
			}
			throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
		});

		renderWithQuery(
			<SlateReservationsPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);

		expect(await screen.findByText("Future slate")).toBeVisible();
		expect(
			screen.queryByRole("button", { name: /Cancel reservation/ }),
		).toBeNull();
		expect(
			apiFetch.mock.calls.some(
				([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
			),
		).toBe(false);
	});

	it("unmounts an open emergency-stop confirmation when the OPERATOR session fails", async () => {
		let session: SessionDto | "error" = users("OPERATOR");
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === "/api/auth/session") {
				if (session === "error") {
					throw new Error("session unavailable");
				}
				return session;
			}
			throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
		});

		const user = userEvent.setup();
		const rendered = renderWithQuery(
			<InsertedContentStopPanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
			/>,
		);
		const action = await screen.findByRole("button", {
			name: "Stop the playing inserted content and return to the live input",
		});
		await user.click(action);
		expect(await screen.findByRole("dialog")).toBeVisible();

		session = "error";
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
		});

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(
			screen.queryByRole("button", { name: action.textContent ?? "" }),
		).toBeNull();
		expect(
			apiFetch.mock.calls.some(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			),
		).toBe(false);
	});
});
