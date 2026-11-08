import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));

import { ClipEditingClient } from "./clip-editing-client";

afterEach(() => vi.clearAllMocks());
const initial = {
	checkedAt: "2026-11-05T00:00:00Z",
	configuration: "CONFIGURED",
	profile: "nvidia",
	worker: { code: "NOT_CHECKED", readyCount: 0, failedCount: 0 },
	gateway: { code: "NOT_CHECKED", scope: "METADATA_ONLY" },
};

it("reads configuration on open and probes only after the operator clicks", async () => {
	apiFetch.mockResolvedValueOnce(initial).mockResolvedValueOnce({
		...initial,
		worker: { code: "READY", readyCount: 1, failedCount: 0 },
		gateway: { code: "MODEL_MISMATCH", scope: "METADATA_ONLY" },
	});
	renderWithQuery(<ClipEditingClient />);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Check connection" }),
		).toBeEnabled(),
	);
	expect(apiFetch).toHaveBeenCalledTimes(1);
	fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
	await screen.findByText("Required model missing or different");
	expect(apiFetch).toHaveBeenLastCalledWith(
		"/api/settings/clip-editing",
		expect.objectContaining({ method: "POST", body: "{}" }),
	);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(document.querySelector("details")?.open).toBe(false);
});

it("keeps editing off without settings and does not offer a cloud provider form", async () => {
	apiFetch.mockResolvedValue({
		...initial,
		configuration: "DISABLED",
		profile: undefined,
	});
	renderWithQuery(<ClipEditingClient />);
	await screen.findByText("Off");
	expect(
		screen.getByRole("button", { name: "Check connection" }),
	).toBeDisabled();
	expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	expect(apiFetch).toHaveBeenCalledTimes(1);
});
