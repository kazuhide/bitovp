import { fireEvent, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const mocks = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	canDiagnose: true,
	session: {
		configured: true,
		authenticated: true,
		mode: "users",
		organizationId: "00000000-0000-4000-8000-000000000001",
		actorUserId: "00000000-0000-4000-8000-000000000002",
		effectiveUserId: "00000000-0000-4000-8000-000000000002",
	},
}));
const apiFetch = mocks.apiFetch;
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => mocks.canDiagnose,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({ status: "success", data: mocks.session }),
}));

import { ClipEditingClient } from "./clip-editing-client";

beforeEach(() => {
	apiFetch.mockReset();
	mocks.canDiagnose = true;
	mocks.session.organizationId = "00000000-0000-4000-8000-000000000001";
});
const initial = {
	checkedAt: "2026-11-05T00:00:00Z",
	configuration: "CONFIGURED",
	profile: "nvidia",
	worker: { code: "NOT_CHECKED", readyCount: 0, failedCount: 0 },
	gateway: { code: "NOT_CHECKED", scope: "METADATA_ONLY" },
};

const diagnosed = () => ({
	...initial,
	checkedAt: new Date().toISOString(),
	worker: { code: "READY", readyCount: 1, failedCount: 0 },
	gateway: { code: "MODEL_MISMATCH", scope: "METADATA_ONLY" },
});

it("automatically diagnoses configured services when the settings page opens", async () => {
	apiFetch.mockResolvedValueOnce(initial).mockResolvedValueOnce({
		...diagnosed(),
	});
	renderWithQuery(<ClipEditingClient />);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Check connection" }),
		).toBeEnabled(),
	);
	await screen.findByText("Required model missing or different");
	expect(apiFetch).toHaveBeenCalledTimes(2);
	expect(apiFetch).toHaveBeenLastCalledWith(
		"/api/settings/clip-editing",
		expect.objectContaining({ method: "POST", body: "{}" }),
	);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(document.querySelector("details")?.open).toBe(false);
});

it("deduplicates the initial diagnostic and retains a manual recheck", async () => {
	apiFetch
		.mockResolvedValueOnce(initial)
		.mockResolvedValueOnce(diagnosed())
		.mockResolvedValueOnce(initial)
		.mockResolvedValueOnce({
			...diagnosed(),
			gateway: { code: "READY", scope: "METADATA_ONLY" },
		});
	renderWithQuery(
		<>
			<ClipEditingClient />
			<ClipEditingClient />
		</>,
	);
	await screen.findAllByText("Required model missing or different");
	expect(apiFetch).toHaveBeenCalledTimes(2);
	const [recheck] = screen.getAllByRole("button", { name: "Check connection" });
	if (!recheck) throw new Error("Missing diagnostic recheck");
	fireEvent.click(recheck);
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
	await waitFor(() =>
		expect(
			screen.queryByText("Required model missing or different"),
		).not.toBeInTheDocument(),
	);
});

it("shows checking without a healthy claim while the initial diagnosis is pending", async () => {
	let resolve!: (value: unknown) => void;
	apiFetch.mockResolvedValueOnce(initial).mockImplementationOnce(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	renderWithQuery(<ClipEditingClient />);
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
	expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
	expect(screen.queryByText("Ready")).not.toBeInTheDocument();
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	await act(async () => resolve(diagnosed()));
	await screen.findByText("Required model missing or different");
});

it("never probes without mutation permission", async () => {
	mocks.canDiagnose = false;
	apiFetch.mockResolvedValue(initial);
	renderWithQuery(<ClipEditingClient />);
	await screen.findByText("Configured");
	expect(
		screen.queryByRole("button", { name: "Check connection" }),
	).not.toBeInTheDocument();
	expect(apiFetch).toHaveBeenCalledTimes(1);
});

it("does not show an expired diagnostic as current readiness", async () => {
	apiFetch.mockResolvedValueOnce(initial).mockResolvedValueOnce({
		...diagnosed(),
		checkedAt: new Date(Date.now() - 46_000).toISOString(),
	});
	renderWithQuery(<ClipEditingClient />);
	await screen.findAllByText("Diagnosis expired");
	expect(screen.queryByText("Ready")).not.toBeInTheDocument();
	expect(screen.queryByText(/Ready: 1/)).not.toBeInTheDocument();
});

it("discards an old organization's pending diagnosis", async () => {
	let resolve!: (value: unknown) => void;
	apiFetch
		.mockResolvedValueOnce(initial)
		.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		)
		.mockResolvedValueOnce(initial)
		.mockResolvedValueOnce({
			...diagnosed(),
			gateway: { code: "READY", scope: "METADATA_ONLY" },
		});
	const view = renderWithQuery(<ClipEditingClient />);
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
	mocks.session.organizationId = "00000000-0000-4000-8000-000000000003";
	view.rerender(<ClipEditingClient />);
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
	await act(async () => resolve(diagnosed()));
	expect(
		screen.queryByText("Required model missing or different"),
	).not.toBeInTheDocument();
});

it("keeps diagnosis errors sanitized and allows recovery", async () => {
	apiFetch
		.mockResolvedValueOnce(initial)
		.mockRejectedValueOnce(new Error("private-token-and-host"))
		.mockResolvedValueOnce(initial)
		.mockResolvedValueOnce(diagnosed());
	renderWithQuery(<ClipEditingClient />);
	await screen.findByRole("alert");
	expect(screen.queryByText(/private-token/)).not.toBeInTheDocument();
	expect(screen.queryByText("Ready")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
	await screen.findByText("Required model missing or different");
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
