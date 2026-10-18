import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { TemplatesClient } from "./templates-client";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		ApiError: actual.ApiError,
		apiFetch: (...args: unknown[]) => apiFetch(...args),
	};
});

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
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

const ROW = {
	id: "11111111-2222-4333-8444-555555555555",
	name: "hardened-hls",
	description: "the 6-rung ladder we ship",
	category: null,
	createdAt: "2026-08-01T00:00:00.000Z",
	updatedAt: "2026-08-15T00:00:00.000Z",
	revision: 3,
	_count: { encodingJobs: 5, liveChannels: 0, watchRules: 2 },
};

describe("TemplatesClient (ledger #109 §6)", () => {
	it("shows the empty state with the save-from-wizard hint", async () => {
		mockOwnerApi(async () => []);
		renderWithQuery(<TemplatesClient />);
		expect(await screen.findByText(/No templates yet/i)).toBeInTheDocument();
		expect(screen.getByText(/save it as a preset/i)).toBeInTheDocument();
	});

	it("lists name, revision, USES (a computed count) and last-updated", async () => {
		mockOwnerApi(async (url: string) => (url === "/api/presets" ? [ROW] : []));
		renderWithQuery(<TemplatesClient />);
		expect(await screen.findByText("hardened-hls")).toBeInTheDocument();
		expect(screen.getByText("rev 3")).toBeInTheDocument();
		// 5 jobs + 0 channels + 2 rules = 7 — summed client-side from _count,
		// never a stored counter.
		expect(screen.getByText(/7 uses · updated 2026-08-15/)).toBeInTheDocument();
	});

	it("delivery presets (category-bearing rows) are NOT templates and never listed here (review-109pr1 P2)", async () => {
		mockOwnerApi(async (url: string) =>
			url === "/api/presets"
				? [
						ROW,
						{ ...ROW, id: "d1", name: "netflix-mezz", category: "MEZZANINE" },
					]
				: [],
		);
		renderWithQuery(<TemplatesClient />);
		expect(await screen.findByText("hardened-hls")).toBeInTheDocument();
		/* Delivery presets are managed separately and must not acquire template edit or delete controls. */
		expect(screen.queryByText("netflix-mezz")).not.toBeInTheDocument();
	});

	it("Edit links to the wizard's ?editPreset= mode", async () => {
		mockOwnerApi(async (url: string) => (url === "/api/presets" ? [ROW] : []));
		renderWithQuery(<TemplatesClient />);
		const edit = await screen.findByRole("link", { name: "Edit" });
		expect(edit).toHaveAttribute("href", `/vod/new?editPreset=${ROW.id}`);
	});

	it("surfaces the Restrict refusal when DELETE 409s (watch rules)", async () => {
		const { ApiError } =
			await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
		mockOwnerApi(async (url: string, init?: RequestInit) => {
			if (init?.method === "DELETE") {
				throw new ApiError(409, "Watch rules reference this template");
			}
			return url === "/api/presets" ? [ROW] : [];
		});
		renderWithQuery(<TemplatesClient />);
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: /Really delete/i }));
		expect(
			await screen.findByText(/Watch rules reference this template/i),
		).toBeInTheDocument();
	});

	it("the VOD CTA names the job it creates and opens the §4.1 dialog", async () => {
		mockOwnerApi(async (url: string) => {
			if (url === "/api/presets") {
				return [ROW];
			}
			if (url === "/api/presets?kind=LIVE_PLAN") {
				return [];
			}
			// The dialog's detail fetch — pending forever is fine here; the
			// launch-dialog test drives the loaded states.
			return new Promise(() => {});
		});
		renderWithQuery(<TemplatesClient />);
		fireEvent.click(
			await screen.findByRole("button", { name: "Create VOD job" }),
		);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(`/api/presets/${ROW.id}`);
		});
	});

	it("a LIVE row gets the channel badge, a live launch, and NO wizard edit (ledger #109 PR4)", async () => {
		const liveRow = {
			...ROW,
			id: "22222222-3333-4444-8555-666666666666",
			name: "eve-channel",
		};
		mockOwnerApi(async (url: string) => {
			if (url === "/api/presets") {
				return [];
			}
			if (url === "/api/presets?kind=LIVE_PLAN") {
				return [liveRow];
			}
			return new Promise(() => {});
		});
		renderWithQuery(<TemplatesClient />);
		expect(await screen.findByText("eve-channel")).toBeInTheDocument();
		expect(screen.getByText("Channel")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Edit" }),
		).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Create live channel" }),
		);
		// The LIVE dialog fetches the detail — same endpoint, different dialog;
		// the live-launch flow itself is covered by its own suite.
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(`/api/presets/${liveRow.id}`);
		});
	});

	it("the kind filter narrows the merged list", async () => {
		const liveRow = {
			...ROW,
			id: "22222222-3333-4444-8555-666666666666",
			name: "eve-channel",
		};
		mockOwnerApi(async (url: string) =>
			url === "/api/presets"
				? [ROW]
				: url === "/api/presets?kind=LIVE_PLAN"
					? [liveRow]
					: [],
		);
		renderWithQuery(<TemplatesClient />);
		expect(await screen.findByText("hardened-hls")).toBeInTheDocument();
		expect(screen.getByText("eve-channel")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Channel templates" }));
		await waitFor(() => {
			expect(screen.queryByText("hardened-hls")).not.toBeInTheDocument();
		});
		expect(screen.getByText("eve-channel")).toBeInTheDocument();
	});

	it("keeps VOD results visible after a live read fails and retries only the failed list", async () => {
		let liveReads = 0;
		mockOwnerApi(async (url) => {
			if (url === "/api/presets") return [ROW];
			if (url === "/api/presets?kind=LIVE_PLAN") {
				if (++liveReads === 1) throw new Error("private diagnostics");
				return [{ ...ROW, id: "live", name: "Recovered live" }];
			}
			return [];
		});
		renderWithQuery(<TemplatesClient />);
		await screen.findByText("hardened-hls");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not load live templates.",
		);
		expect(screen.queryByText(/No templates yet/i)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByText("Recovered live");
		expect(
			apiFetch.mock.calls.filter(([url]) => url === "/api/presets"),
		).toHaveLength(1);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("reports both list failures without claiming the saved list is empty", async () => {
		mockOwnerApi(async () => {
			throw new Error("private diagnostics");
		});
		const view = renderWithQuery(<TemplatesClient />);
		await waitFor(() =>
			expect(view.client.getQueryState(["live-presets"])?.status).toBe("error"),
		);
		expect(screen.queryByText(/No templates yet/i)).not.toBeInTheDocument();
		expect(screen.getAllByRole("alert")).toHaveLength(2);
		expect(
			screen.getByText("Could not load VOD templates."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Could not load live templates."),
		).toBeInTheDocument();
	});

	it("shows a friendly delete failure and invalidates both saved kinds after a successful retry", async () => {
		let attempts = 0;
		let deleted = false;
		mockOwnerApi(async (url, init) => {
			if (init?.method === "DELETE") {
				if (++attempts === 1) throw new Error("private diagnostics");
				deleted = true;
				return {};
			}
			return url === "/api/presets?kind=LIVE_PLAN" && !deleted
				? [{ ...ROW, id: "live", name: "Live workflow" }]
				: [];
		});
		const view = renderWithQuery(<TemplatesClient />);
		const invalidate = vi.spyOn(view.client, "invalidateQueries");
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: /Really delete/i }));
		await waitFor(() =>
			expect(view.client.getMutationCache().getAll().at(-1)?.state.status).toBe(
				"error",
			),
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not delete this template. Try again.",
		);
		expect(screen.queryByText(/private diagnostics/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Really delete/i }));
		await waitFor(() =>
			expect(screen.queryByText("Live workflow")).not.toBeInTheDocument(),
		);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["plan-presets"] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["live-presets"] });
	});
});
