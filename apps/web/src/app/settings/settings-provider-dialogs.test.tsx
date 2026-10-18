import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { CloudConnectPanel } from "./infrastructure/cloud-connect-panel";
import { PrewarmedPoolsPanel } from "./infrastructure/prewarmed-pools-panel";
import { StaticIpsPanel } from "./infrastructure/static-ips-panel";
import { DnsMappingsSettingsPanel } from "./live/dns-mappings-settings-panel";
import { StandbyPoolsPanel } from "./live/standby-pools-panel";
import { StreamKeysPanel } from "./live/stream-keys-panel";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));
vi.mock("./live/live-encoding-picker", () => ({
	LiveEncodingPicker: ({
		inputId,
		onChange,
	}: {
		inputId: string;
		onChange: (id: string) => void;
	}) => <input id={inputId} onChange={(e) => onChange(e.target.value)} />,
}));
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
beforeEach(() =>
	apiFetch
		.mockReset()
		.mockImplementation((_url: string, options?: RequestInit) =>
			options?.method === "POST"
				? Promise.reject(new Error("offline"))
				: Promise.resolve({ items: [], totalCount: 0 }),
		),
);

it.each([
	[
		"Cloud Connect",
		CloudConnectPanel,
		/Add AWS account/i,
		{ accountNumber: "123456789012", roleName: "encoder" },
	],
	["prewarmed pool", PrewarmedPoolsPanel, /Create pool/i, {}],
	["static IP", StaticIpsPanel, /Request static IP/i, {}],
	[
		"DNS mapping",
		DnsMappingsSettingsPanel,
		/Add mapping/i,
		{ subdomain: "stage" },
	],
	[
		"standby pool",
		StandbyPoolsPanel,
		/Create pool/i,
		{ name: "stage", encodingTemplate: "{}" },
	],
	["stream key", StreamKeysPanel, /Reserve key/i, {}],
] as const)("shows %s creation failure inside its dialog", async (name, Component, openLabel, values) => {
	renderWithQuery(
		<Component bitmovinAccountId="00000000-0000-4000-8000-000000000001" />,
	);
	await userEvent.click(screen.getByRole("button", { name: openLabel }));
	const dialog = screen.getByRole("dialog");
	for (const [field, value] of Object.entries(values)) {
		const input = dialog.querySelector(`[name="${field}"]`);
		if (!input) throw new Error(`Missing ${field}`);
		fireEvent.change(input, { target: { value } });
	}
	if (name === "DNS mapping")
		fireEvent.change(
			within(dialog).getByRole("textbox", { name: /encoding/i }),
			{ target: { value: "00000000-0000-4000-8000-000000000002" } },
		);
	const form = dialog.querySelector("form");
	if (!form) throw new Error("Missing form");
	fireEvent.submit(form);
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, opts]) => opts?.method === "POST"),
		).toBe(true),
	);
	expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
});
