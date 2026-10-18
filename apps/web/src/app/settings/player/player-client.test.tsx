import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const access = vi.hoisted(() => ({ canAdmin: true }));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => access.canAdmin,
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { PlayerSettingsClient } from "./player-client";

const SETTINGS = {
	provider: "native" as const,
	playerLicenseKey: "saved-player-key",
	analyticsLicenseKey: "saved-analytics-key",
};

beforeEach(() => {
	vi.clearAllMocks();
	access.canAdmin = true;
	apiFetch.mockResolvedValue(SETTINGS);
});

describe("PlayerSettingsClient", () => {
	it("shows keys only for Bitmovin and retains them while switching modes", async () => {
		const user = userEvent.setup();
		renderWithQuery(<PlayerSettingsClient />);

		const provider = await screen.findByLabelText("Preview player");
		expect(
			screen.getByText("hls.js / Shaka Player (default)"),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("Player licence key")).toBeNull();
		expect(screen.queryByLabelText("Analytics licence key")).toBeNull();
		await user.click(
			screen.getByRole("button", { name: "Preview player — more information" }),
		);
		expect(
			screen.getByText(
				/Open-source previews do not send data to Bitmovin Analytics/,
			),
		).toBeInTheDocument();
		await user.keyboard("{Escape}");

		await user.selectOptions(provider, "bitmovin");
		expect(screen.getByLabelText("Player licence key")).toHaveValue(
			"saved-player-key",
		);
		expect(screen.getByLabelText("Analytics licence key")).toHaveValue(
			"saved-analytics-key",
		);

		await user.clear(screen.getByLabelText("Player licence key"));
		await user.type(screen.getByLabelText("Player licence key"), "draft-key");
		await user.selectOptions(provider, "native");
		expect(screen.queryByLabelText("Player licence key")).toBeNull();
		await user.selectOptions(provider, "bitmovin");
		expect(screen.getByLabelText("Player licence key")).toHaveValue(
			"draft-key",
		);
	});

	it("does not show unrelated Bitmovin keys to a read-only viewer", async () => {
		access.canAdmin = false;
		renderWithQuery(<PlayerSettingsClient />);

		expect(
			await screen.findByText("hls.js / Shaka Player (default)"),
		).toBeInTheDocument();
		expect(screen.queryByText("Player licence key")).toBeNull();
		expect(screen.queryByText("Analytics licence key")).toBeNull();
	});
});

it("locks the player draft until its save completes", async () => {
	const user = userEvent.setup();
	apiFetch.mockImplementation((_url: string, init?: RequestInit) =>
		init?.method === "PATCH"
			? new Promise(() => {})
			: Promise.resolve(SETTINGS),
	);
	renderWithQuery(<PlayerSettingsClient />);
	const provider = await screen.findByLabelText("Preview player");
	await user.selectOptions(provider, "bitmovin");
	await user.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() => expect(provider).toBeDisabled());
	expect(screen.getByLabelText("Player licence key")).toBeDisabled();
});

it("retries a failed player settings load in place", async () => {
	apiFetch
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue(SETTINGS);
	renderWithQuery(<PlayerSettingsClient />);
	await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
	expect(await screen.findByLabelText("Preview player")).toBeInTheDocument();
});
