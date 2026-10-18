import type { UserRole } from "@bitovp/db";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { SessionDto } from "./dto";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { StandbyPoolsPanel } from "@/app/settings/live/standby-pools-panel";
import { StreamKeysPanel } from "@/app/settings/live/stream-keys-panel";
import { SESSION_QUERY_KEY } from "./use-session";

type SessionCase =
	| { readonly name: string; readonly session: SessionDto }
	| { readonly name: "unresolved"; readonly session: "error" };

function users(role: UserRole): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		role,
	};
}

const CASES: readonly SessionCase[] = [
	{ name: "VIEWER", session: users("VIEWER") },
	{ name: "unresolved", session: "error" },
	{ name: "OPERATOR", session: users("OPERATOR") },
	{ name: "ADMIN", session: users("ADMIN") },
	{
		name: "single-owner",
		session: {
			mode: "password",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
		},
	},
];

function mockPanelApi(session: SessionCase["session"]) {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") {
			if (session === "error") {
				throw new Error("session unavailable");
			}
			return session;
		}
		if (url.startsWith("/api/live/standby-pools?")) {
			return {
				items: [
					{
						id: "pool-1",
						name: "Read-only standby row",
						targetPoolSize: 2,
						readyEncodings: 1,
						preparingEncodings: 1,
						errorEncodings: 0,
						poolStatus: "HEALTHY",
					},
				],
				totalCount: 1,
			};
		}
		if (url.startsWith("/api/live/stream-keys?")) {
			return {
				items: [
					{
						id: "key-1",
						name: "Non-secret stream-key row",
						status: "UNASSIGNED",
						type: "RESERVED",
					},
				],
				totalCount: 1,
			};
		}
		return { items: [], totalCount: 0 };
	});
}

function mockStandbyDetailApi(initialSession: SessionCase["session"]) {
	let session = initialSession;
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url === "/api/auth/session") {
			if (session === "error") {
				throw new Error("session unavailable");
			}
			return session;
		}
		if (url === "/api/live/standby-pools?bitmovinAccountId=account-1") {
			return {
				items: [
					{
						id: "pool-1",
						name: "Read-only standby row",
						targetPoolSize: 2,
						readyEncodings: 1,
						preparingEncodings: 0,
						errorEncodings: 0,
						poolStatus: "HEALTHY",
					},
				],
				totalCount: 1,
			};
		}
		if (url === "/api/live/standby-pools/pool-1?bitmovinAccountId=account-1") {
			return {
				id: "pool-1",
				name: "Read-only standby row",
				encodingTemplateText: '{"name":"read-only-template"}',
			};
		}
		if (
			url ===
			"/api/live/standby-pools/pool-1/encodings?bitmovinAccountId=account-1&limit=100"
		) {
			return {
				items: [
					{
						id: "standby-encoding-1",
						encodingId: "encoding-read-1",
						status: "READY",
						createdAt: "2026-08-31T00:00:00.000Z",
					},
				],
				totalCount: 1,
			};
		}
		if (
			url ===
			"/api/live/standby-pools/pool-1/logs?bitmovinAccountId=account-1&limit=25"
		) {
			return {
				items: [
					{
						id: "standby-log-1",
						eventType: "INFO",
						message: "Read-only standby event",
						createdAt: "2026-08-31T00:00:00.000Z",
					},
				],
				totalCount: 1,
			};
		}
		if (
			url === "/api/live/standby-pools/pool-1/actions" &&
			init?.method === "POST"
		) {
			return {
				action: "acquire",
				encoding: {
					id: "standby-encoding-acquired",
					encodingId: "encoding-acquired-1",
					status: "ACQUIRED",
					ingestPoints: [
						{
							streamBaseUrl: "rtmp://encoder.example/live",
							streamKey: "secret-key-381",
						},
					],
				},
			};
		}
		return { items: [], totalCount: 0 };
	});
	return {
		failSession() {
			session = "error";
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("production mixed-page role controls", () => {
	it("lets a VIEWER inspect standby details without exposing ADMIN actions", async () => {
		mockStandbyDetailApi(users("VIEWER"));
		const user = userEvent.setup();
		renderWithQuery(<StandbyPoolsPanel bitmovinAccountId="account-1" />);

		await user.click(await screen.findByRole("button", { name: "Details" }));

		expect(await screen.findByText("encoding-read-1")).toBeVisible();
		expect(screen.getByText("Read-only standby event")).toBeVisible();
		expect(screen.getByText('{"name":"read-only-template"}')).toBeVisible();
		expect(
			screen.queryByRole("button", { name: "Acquire encoding" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Clear error encodings" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it("removes an acquired standby secret when the ADMIN session can no longer be resolved", async () => {
		const session = mockStandbyDetailApi(users("ADMIN"));
		const user = userEvent.setup();
		const rendered = renderWithQuery(
			<StandbyPoolsPanel bitmovinAccountId="account-1" />,
		);

		await user.click(await screen.findByRole("button", { name: "Details" }));
		await user.click(
			await screen.findByRole("button", { name: "Acquire encoding" }),
		);
		expect(await screen.findByText("secret-key-381")).toBeVisible();

		session.failSession();
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
		});
		await waitFor(() =>
			expect(screen.queryByText("secret-key-381")).toBeNull(),
		);
		expect(screen.queryByText("rtmp://encoder.example/live")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Acquire encoding" }),
		).toBeNull();
		// The failed privilege refresh must not destroy the VIEWER-safe detail.
		expect(screen.getByText("encoding-read-1")).toBeVisible();
		expect(screen.getByText("Read-only standby event")).toBeVisible();
	});

	it("removes the real ADMIN standby-pool Delete control while preserving its read-only row", async () => {
		for (const entry of CASES) {
			mockPanelApi(entry.session);
			const rendered = renderWithQuery(
				<StandbyPoolsPanel bitmovinAccountId="account-1" />,
			);
			expect(await screen.findByText("Read-only standby row")).toBeVisible();
			const deleteButton = screen.queryByRole("button", { name: "Delete" });
			const shouldRender =
				entry.name === "ADMIN" || entry.name === "single-owner";
			if (shouldRender) {
				expect(deleteButton, entry.name).toBeVisible();
			} else {
				expect(deleteButton, entry.name).toBeNull();
			}
			rendered.unmount();
			apiFetch.mockReset();
		}
	});

	it("removes both real OPERATOR stream-key dialogs for VIEWER/unresolved and opens them for authorized roles", async () => {
		for (const entry of CASES) {
			mockPanelApi(entry.session);
			const user = userEvent.setup();
			const rendered = renderWithQuery(
				<StreamKeysPanel bitmovinAccountId="account-1" />,
			);
			expect(
				await screen.findByText("Non-secret stream-key row"),
			).toBeVisible();
			const reserve = screen.queryByRole("button", { name: "Reserve key" });
			const unassign = screen.queryByRole("button", {
				name: "Unassign by encoding",
			});
			const shouldRender = !["VIEWER", "unresolved"].includes(entry.name);
			if (shouldRender) {
				expect(reserve, entry.name).toBeVisible();
				expect(unassign, entry.name).toBeVisible();
				await user.click(reserve as HTMLElement);
				expect(
					await screen.findByRole("dialog", { name: "Reserve stream key" }),
				).toBeVisible();
				await user.click(screen.getByRole("button", { name: "Close" }));
				await user.click(unassign as HTMLElement);
				expect(
					await screen.findByRole("dialog", { name: "Unassign stream keys" }),
				).toBeVisible();
			} else {
				expect(reserve, entry.name).toBeNull();
				expect(unassign, entry.name).toBeNull();
				expect(
					screen.queryByRole("dialog", { name: "Reserve stream key" }),
				).toBeNull();
				expect(
					screen.queryByRole("dialog", { name: "Unassign stream keys" }),
				).toBeNull();
			}
			rendered.unmount();
			apiFetch.mockReset();
		}
	});
});
