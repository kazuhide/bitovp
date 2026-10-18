import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { MyPresets } from "./my-presets";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async () => ({
	...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

afterEach(() => apiFetch.mockReset());

function mockOwnerApi(
	handler: (url: string, init?: RequestInit) => unknown | Promise<unknown>,
) {
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url === "/api/auth/session") {
			return {
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			};
		}
		return handler(url, init);
	});
}

describe("MyPresets", () => {
	it("shows an empty state when no presets are saved", async () => {
		mockOwnerApi(async () => []);
		renderWithQuery(<MyPresets />);
		expect(
			await screen.findByText(/No saved delivery presets yet/i),
		).toBeInTheDocument();
	});

	it("lists presets with a Load link to ?userPreset and a two-click delete", async () => {
		mockOwnerApi(async (url: string, init?: RequestInit) => {
			if (url === "/api/presets" && !init) {
				return [
					{
						id: "p1",
						name: "my-ladder",
						description: "2-rung H264",
						createdAt: "2026-06-19T00:00:00.000Z",
						category: "MEZZANINE",
					},
				];
			}
			if (url === "/api/presets/p1" && init?.method === "DELETE") {
				return { ok: true };
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<MyPresets />);

		const load = await screen.findByRole("link", { name: /Load in wizard/i });
		expect(load).toHaveAttribute("href", "/vod/new?userPreset=p1");

		// Delete requires a second click (inline confirm), then hits DELETE.
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				"/api/presets/p1",
				expect.objectContaining({ method: "DELETE" }),
			);
		});
	});

	it("lists categorized delivery rows without duplicating plain saved plans", async () => {
		mockOwnerApi(async () => [
			{ id: "plain", name: "Plain saved plan", category: null },
			{ id: "delivery", name: "Imported delivery", category: "MEZZANINE" },
		]);
		renderWithQuery(<MyPresets />);
		await screen.findByText("Imported delivery");
		expect(screen.queryByText("Plain saved plan")).not.toBeInTheDocument();
	});

	it("distinguishes a failed delivery read from empty and recovers on retry", async () => {
		let reads = 0;
		mockOwnerApi(async () => {
			if (++reads === 1) throw new Error("private diagnostics");
			return [
				{ id: "delivery", name: "Recovered delivery", category: "MEZZANINE" },
			];
		});
		const view = renderWithQuery(<MyPresets />);
		await waitFor(() =>
			expect(view.client.getQueryState(["plan-presets"])?.status).toBe("error"),
		);
		expect(
			screen.queryByText(/No saved delivery presets yet/i),
		).not.toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not load saved delivery presets.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByText("Recovered delivery");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it.each([
		409, 500,
	])("keeps a failed delivery delete visible and reports a friendly reason (%s)", async (status) => {
		const { ApiError } =
			await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
		mockOwnerApi(async (_, init) => {
			if (init?.method === "DELETE")
				throw new ApiError(status, "private diagnostics");
			return [
				{ id: "delivery", name: "Imported delivery", category: "MEZZANINE" },
			];
		});
		const view = renderWithQuery(<MyPresets />);
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		await waitFor(() =>
			expect(view.client.getMutationCache().getAll().at(-1)?.state.status).toBe(
				"error",
			),
		);
		expect(screen.getByText("Imported delivery")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(
			status === 409
				? "Watch rules reference this preset."
				: "Could not delete this preset.",
		);
		expect(screen.queryByText(/private diagnostics/)).not.toBeInTheDocument();
	});
});
