import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { SessionDto } from "./dto";
import { SESSION_QUERY_KEY } from "./use-session";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { RoleAccess } from "./use-role-access";

function users(role: SessionDto["role"]): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		role,
	};
}

describe("RoleAccess", () => {
	it("shows an OPERATOR action to OPERATOR and ADMIN but not VIEWER", async () => {
		for (const [role, visible] of [
			["VIEWER", false],
			["OPERATOR", true],
			["ADMIN", true],
		] as const) {
			apiFetch.mockResolvedValueOnce(users(role));
			const rendered = renderWithQuery(
				<RoleAccess control="live.channels.create">
					<button type="button">Operate</button>
				</RoleAccess>,
			);
			if (visible) {
				expect(
					await screen.findByRole("button", { name: "Operate" }),
				).toBeVisible();
			} else {
				await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
				expect(screen.queryByRole("button", { name: "Operate" })).toBeNull();
			}
			rendered.unmount();
		}
	});

	it("fails closed while users-mode role resolution is unavailable", async () => {
		apiFetch.mockRejectedValue(new Error("database down"));
		const { container } = renderWithQuery(
			<RoleAccess control="live.channels.create">
				<button type="button">Operate</button>
			</RoleAccess>,
		);
		await act(async () => {
			await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
		});
		expect(container).toBeEmptyDOMElement();
	});

	it("stops trusting a cached ADMIN role when background session refresh fails", async () => {
		apiFetch.mockResolvedValueOnce(users("ADMIN"));
		const rendered = renderWithQuery(
			<RoleAccess control="settings.features">
				<button type="button">Admin action</button>
			</RoleAccess>,
		);
		expect(
			await screen.findByRole("button", { name: "Admin action" }),
		).toBeVisible();

		apiFetch.mockRejectedValueOnce(new Error("session refresh failed"));
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
		});
		await vi.waitFor(() =>
			expect(screen.queryByRole("button", { name: "Admin action" })).toBeNull(),
		);
	});

	it("preserves single-owner mode", async () => {
		apiFetch.mockResolvedValue({
			mode: "password",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
		} satisfies SessionDto);
		renderWithQuery(
			<RoleAccess control="settings.features">
				<button type="button">Admin action</button>
			</RoleAccess>,
		);
		expect(
			await screen.findByRole("button", { name: "Admin action" }),
		).toBeVisible();
	});
});
