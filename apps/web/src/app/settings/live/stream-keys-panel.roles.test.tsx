import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { StreamKeysPanel } from "./stream-keys-panel";

function session(role: "VIEWER" | "OPERATOR" | "ADMIN") {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		role,
	};
}

function stub(role: "VIEWER" | "OPERATOR" | "ADMIN"): void {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") return session(role);
		if (url.startsWith("/api/live/stream-keys?")) {
			return {
				items: [
					{
						id: "key-1",
						name: "Studio contribution key",
						type: "RESERVED",
						status: "UNASSIGNED",
						// A defensive fixture: even if an upstream list accidentally sends
						// a value, the VIEWER surface must not render it.
						value: "should-never-reach-viewer",
					},
				],
				totalCount: 1,
			};
		}
		return {};
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("StreamKeysPanel role split", () => {
	it("lets VIEWER read key metadata without reveal or mutation controls", async () => {
		stub("VIEWER");
		renderWithQuery(<StreamKeysPanel bitmovinAccountId="acct-1" />);
		expect(await screen.findByText("Studio contribution key")).toBeVisible();
		expect(screen.queryByText("should-never-reach-viewer")).toBeNull();
		for (const name of [
			"Reserve key",
			"Reveal key",
			"Delete",
			"Unassign by encoding",
		]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
	});

	it("shows the OPERATOR controls on the same readable list", async () => {
		stub("OPERATOR");
		renderWithQuery(<StreamKeysPanel bitmovinAccountId="acct-1" />);
		expect(await screen.findByText("Studio contribution key")).toBeVisible();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Reserve key" })).toBeVisible(),
		);
		expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
	});
});
