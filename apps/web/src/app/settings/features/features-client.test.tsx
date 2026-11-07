import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { renderWithQuery } from "@/test/render";
import VmafSettingsPage from "../vmaf/page";
import FeaturesSettingsPage from "./page";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

let currentSession: SessionDto;
let readSession: () => Promise<SessionDto>;
let enabled: boolean;
let flagReadError: boolean;
let saveError: boolean;

beforeEach(() => {
	currentSession = {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		role: "ADMIN",
		organizationId: "00000000-0000-4000-8000-000000000001",
	};
	readSession = async () => currentSession;
	enabled = false;
	flagReadError = false;
	saveError = false;
	apiFetch.mockReset();
	apiFetch.mockImplementation(
		async (url: string, options?: { method?: string; body?: string }) => {
			if (url === "/api/auth/session") return readSession();
			if (url === "/api/settings/features") {
				if (options?.method === "PATCH") {
					if (saveError) throw new Error("Could not save QC settings");
					enabled = JSON.parse(options.body ?? "{}").qcVmaf;
				} else if (flagReadError) {
					throw new Error("offline");
				}
				return { qcVmaf: enabled };
			}
			if (
				url === "/api/settings/vmaf-profiles" ||
				url === "/api/settings/vmaf-credentials"
			)
				return { items: [] };
			throw new Error(`Unexpected request: ${url}`);
		},
	);
});

function profileRequests() {
	return apiFetch.mock.calls.filter(([url]) =>
		/^\/api\/settings\/vmaf-(profiles|credentials)/.test(url),
	);
}

describe("QC settings entry", () => {
	it("combines QC enablement and execution profiles under one page title for an ADMIN, even while QC is disabled", async () => {
		renderWithQuery(<FeaturesSettingsPage />);
		expect(
			await screen.findByRole("button", { name: "Add profile" }),
		).toBeInTheDocument();
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(
			screen.getByRole("heading", { level: 1, name: "Quality control (QC)" }),
		).toBeInTheDocument();
		for (const name of [
			"Enable QC",
			"Execution profiles",
			"Cloud compute credentials",
		]) {
			expect(
				screen.getByRole("heading", { level: 2, name }),
			).toBeInTheDocument();
		}
		expect(
			screen.getByRole("checkbox", { name: "VMAF lab and QC" }),
		).not.toBeChecked();
		expect(profileRequests().map(([url]) => url)).toEqual(
			expect.arrayContaining([
				"/api/settings/vmaf-profiles",
				"/api/settings/vmaf-credentials",
			]),
		);
	});

	it.each([
		["password", "password-form"],
		["none", "disabled"],
	] as const)("retains the QC toggle and execution profiles for the single owner in %s mode", async (mode, loginKind) => {
		currentSession = {
			mode,
			configured: true,
			authenticated: true,
			loginKind,
		};
		renderWithQuery(<FeaturesSettingsPage />);
		expect(
			await screen.findByRole("button", { name: "Add profile" }),
		).toBeInTheDocument();
		expect(
			await screen.findByRole("checkbox", { name: "VMAF lab and QC" }),
		).not.toBeChecked();
		expect(profileRequests().map(([url]) => url)).toEqual(
			expect.arrayContaining([
				"/api/settings/vmaf-profiles",
				"/api/settings/vmaf-credentials",
			]),
		);
	});

	it("preserves the legacy execution-profile page title and cloud-credential anchor", async () => {
		renderWithQuery(<VmafSettingsPage />);
		expect(
			await screen.findByRole("button", { name: "Add profile" }),
		).toBeInTheDocument();
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(
			screen.getByRole("heading", { level: 1, name: "VMAF compute profiles" }),
		).toBeInTheDocument();
		expect(document.getElementById("cloud-credentials")).toHaveTextContent(
			"Cloud compute credentials",
		);
	});

	it.each([
		"OPERATOR",
		"VIEWER",
	] as const)("keeps the QC state readable for %s without mounting the ADMIN profile APIs", async (role) => {
		currentSession.role = role;
		enabled = true;
		const { client } = renderWithQuery(<FeaturesSettingsPage />);
		await waitFor(() =>
			expect(client.getQueryState(SESSION_QUERY_KEY)?.status).toBe("success"),
		);
		expect(await screen.findByText("Enabled")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Add profile" }),
		).not.toBeInTheDocument();
		expect(profileRequests()).toEqual([]);
	});

	it("does not mount ADMIN controls while the session is unresolved", async () => {
		readSession = () => new Promise(() => {});
		renderWithQuery(<FeaturesSettingsPage />);
		expect(await screen.findByText("Disabled")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(profileRequests()).toEqual([]);
	});

	it("keeps profile APIs closed when the session cannot be read", async () => {
		readSession = async () => {
			throw new Error("session unavailable");
		};
		const { client } = renderWithQuery(<FeaturesSettingsPage />);
		await waitFor(() =>
			expect(client.getQueryState(SESSION_QUERY_KEY)?.status).toBe("error"),
		);
		expect(await screen.findByText("Disabled")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(profileRequests()).toEqual([]);
	});

	it("does not mount profile APIs for an impersonating ADMIN", async () => {
		currentSession.isImpersonating = true;
		const { client } = renderWithQuery(<FeaturesSettingsPage />);
		await waitFor(() =>
			expect(client.getQueryState(SESSION_QUERY_KEY)?.status).toBe("success"),
		);
		expect(await screen.findByText("Disabled")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(profileRequests()).toEqual([]);
	});

	it("removes cached ADMIN controls after a failed session refresh and stops profile refetches", async () => {
		const { client } = renderWithQuery(<FeaturesSettingsPage />);
		expect(
			await screen.findByRole("button", { name: "Add profile" }),
		).toBeInTheDocument();
		readSession = async () => {
			throw new Error("session refresh failed");
		};
		await act(() => client.refetchQueries({ queryKey: SESSION_QUERY_KEY }));
		await waitFor(() =>
			expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByRole("button", { name: "Add profile" }),
		).not.toBeInTheDocument();
		const previousRequests = profileRequests().length;
		await act(() =>
			client.invalidateQueries({ queryKey: ["vmaf-settings-profiles"] }),
		);
		await act(() =>
			client.invalidateQueries({ queryKey: ["vmaf-credentials"] }),
		);
		expect(profileRequests()).toHaveLength(previousRequests);
	});

	it("saves only the QC flag and retains the explicit reload confirmation", async () => {
		const { client } = renderWithQuery(<FeaturesSettingsPage />);
		const checkbox = await screen.findByRole("checkbox", {
			name: "VMAF lab and QC",
		});
		await userEvent.click(checkbox);
		await waitFor(() => expect(checkbox).toBeChecked());
		expect(client.getQueryData(["feature-flags"])).toEqual({ qcVmaf: true });
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/settings/features",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ qcVmaf: true }),
			}),
		);
		expect(
			screen.getByText(
				/Saved. Reload the page for the navigation and the wizard/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Reload now" }),
		).toBeInTheDocument();
		expect(apiFetch.mock.calls.some(([url]) => url === "/api/vmaf-jobs")).toBe(
			false,
		);
	});

	it("reports a failed QC save without pretending the flag changed", async () => {
		saveError = true;
		renderWithQuery(<FeaturesSettingsPage />);
		const checkbox = await screen.findByRole("checkbox", {
			name: "VMAF lab and QC",
		});
		await userEvent.click(checkbox);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not save QC settings",
		);
		expect(checkbox).not.toBeChecked();
	});

	it("can retry QC enablement loading without losing execution-profile settings", async () => {
		flagReadError = true;
		renderWithQuery(<FeaturesSettingsPage />);
		expect(
			await screen.findByRole("button", { name: "Add profile" }),
		).toBeInTheDocument();
		flagReadError = false;
		await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("checkbox", { name: "VMAF lab and QC" }),
		).not.toBeChecked();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
