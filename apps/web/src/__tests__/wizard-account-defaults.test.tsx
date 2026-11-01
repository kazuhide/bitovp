import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_WIZARD_STATE } from "@/app/live/new/build-live-plan";
import { LiveWizard } from "@/app/live/new/live-wizard";
import type { BitmovinAccountDto } from "@/app/settings/bitmovin/types";
import { DEFAULT_WIZARD_STATE } from "@/app/vod/new/build-plan";
import { VodWizard } from "@/app/vod/new/wizard";
import { draftKey, writeWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth/use-session", async (original) => ({
	...(await original<Record<string, unknown>>()),
	useSession: () => ({
		status: "success",
		isFetchedAfterMount: true,
		isFetching: false,
		data: {
			mode: "users",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
			organizationId: "org",
			effectiveUserId: "user",
			role: "OPERATOR",
		},
	}),
}));

const accounts: BitmovinAccountDto[] = [
	{
		id: "33333333-3333-4333-8333-333333333333",
		label: "Tokyo",
		tenantOrgId: null,
		defaults: { cloudRegion: "AWS_AP_NORTHEAST_1", encoderVersion: "BETA" },
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
	},
	{
		id: "55555555-5555-4555-8555-555555555555",
		label: "Pinned",
		tenantOrgId: null,
		defaults: { cloudRegion: "FUTURE_REGION", encoderVersion: "2.291.0" },
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
	},
	{
		id: "77777777-7777-4777-8777-777777777777",
		label: "Legacy",
		tenantOrgId: null,
		defaults: {},
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
	},
];

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (url: string) =>
		url === "/api/bitmovin-accounts" ? accounts : [],
	);
});

it.each([
	"vod",
	"live",
] as const)("%s applies the selected account defaults, permits overrides, and retains them on refetch", async (kind) => {
	const defaults =
		kind === "vod" ? DEFAULT_WIZARD_STATE : DEFAULT_LIVE_WIZARD_STATE;
	const { client } = renderWithQuery(
		kind === "vod" ? <VodWizard /> : <LiveWizard />,
	);
	await screen.findByRole("option", { name: "Tokyo" });
	const account = screen.getByLabelText("Bitmovin account");
	const region = screen.getByLabelText("Cloud region");
	const version = screen.getByLabelText("Encoder version");
	fireEvent.change(account, { target: { value: accounts[0]?.id } });
	expect(region).toHaveValue("AWS_AP_NORTHEAST_1");
	expect(version).toHaveValue("BETA");
	fireEvent.change(region, { target: { value: "AWS_US_WEST_2" } });
	fireEvent.change(version, { target: { value: "STABLE" } });
	await act(() => client.refetchQueries({ queryKey: ["bitmovin-accounts"] }));
	expect(region).toHaveValue("AWS_US_WEST_2");
	expect(version).toHaveValue("STABLE");
	fireEvent.change(account, { target: { value: accounts[1]?.id } });
	expect(region).toHaveValue("FUTURE_REGION");
	expect(version).toHaveValue("PINNED");
	expect(screen.getByLabelText("Pinned encoder version")).toHaveValue(
		"2.291.0",
	);
	fireEvent.change(account, { target: { value: accounts[2]?.id } });
	expect(region).toHaveValue(defaults.cloudRegion);
	if (["STABLE", "BETA"].includes(defaults.encoderVersion))
		expect(version).toHaveValue(defaults.encoderVersion);
	else
		expect(screen.getByLabelText("Pinned encoder version")).toHaveValue(
			defaults.encoderVersion,
		);
});

it.each([
	"vod",
	"live",
] as const)("%s keeps restored settings until the user explicitly switches accounts", async (kind) => {
	const defaults =
		kind === "vod" ? DEFAULT_WIZARD_STATE : DEFAULT_LIVE_WIZARD_STATE;
	writeWizardDraft(
		draftKey(["org", "user"], kind, "new"),
		kind,
		{
			...defaults,
			accountId: accounts[0]?.id,
			cloudRegion: "AWS_EU_WEST_1",
			encoderVersion: "2.280.0",
		},
		0,
	);
	const { client } = renderWithQuery(
		kind === "vod" ? <VodWizard /> : <LiveWizard />,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
	await screen.findByRole("option", { name: "Tokyo" });
	expect(screen.getByLabelText("Cloud region")).toHaveValue("AWS_EU_WEST_1");
	expect(screen.getByLabelText("Pinned encoder version")).toHaveValue(
		"2.280.0",
	);
	await act(() => client.refetchQueries({ queryKey: ["bitmovin-accounts"] }));
	expect(screen.getByLabelText("Pinned encoder version")).toHaveValue(
		"2.280.0",
	);
	fireEvent.change(screen.getByLabelText("Bitmovin account"), {
		target: { value: accounts[1]?.id },
	});
	expect(screen.getByLabelText("Cloud region")).toHaveValue("FUTURE_REGION");
	expect(screen.getByLabelText("Pinned encoder version")).toHaveValue(
		"2.291.0",
	);
});
