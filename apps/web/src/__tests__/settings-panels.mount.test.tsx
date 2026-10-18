import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/**
 * Render the settings panels that no test had ever rendered.
 *
 * The same measurement that produced `wizard-sections.mount.test.tsx`: 89 of
 * 198 exported components were never mounted, and the largest of them are these
 * — `PrewarmedPoolsPanel` at 432 lines, `StreamKeysPanel` at 417. A component
 * that big with no render is a component whose empty state, error state and
 * loading state have never once been executed.
 *
 * THE STATES ARE THE POINT. Each panel is mounted three ways — data, empty,
 * and a failing endpoint — because those are the branches that ship broken:
 * a list that renders nothing at all when the API is down, or that says
 * "loading" forever. Every case asserts a specific string the operator must
 * see, so a panel returning null cannot pass.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));

import { BitmovinClient } from "@/app/settings/bitmovin/bitmovin-client";
import { FeaturesClient } from "@/app/settings/features/features-client";
import { CloudAccountForm } from "@/app/settings/infrastructure/cloud-account-form";
import { CloudConnectPanel } from "@/app/settings/infrastructure/cloud-connect-panel";
import { PrewarmedPoolsPanel } from "@/app/settings/infrastructure/prewarmed-pools-panel";
import { RegionSettingsEditor } from "@/app/settings/infrastructure/region-settings-editor";
import { StaticIpsPanel } from "@/app/settings/infrastructure/static-ips-panel";
import { DnsMappingsSettingsPanel } from "@/app/settings/live/dns-mappings-settings-panel";
import { StandbyPoolsPanel } from "@/app/settings/live/standby-pools-panel";
import { StreamKeysPanel } from "@/app/settings/live/stream-keys-panel";
import { SettingsAreas } from "@/app/settings/settings-areas";
import { WebhooksClient } from "@/app/settings/webhooks/webhooks-client";

beforeEach(() => {
	vi.clearAllMocks();
});

/**
 * Everything resolves to an empty list / empty object — in the SHAPE each
 * reader expects: the webhook screens page through `{ items, nextCursor }`
 * (`usePagedList`), and a bare `[]` there made `pages.flatMap((p) => p.items)`
 * yield `[undefined]` and the row render throw `receivedAt` of undefined — an
 * unhandled error surfacing after the test itself had passed (merge #347).
 */
function stubEmpty(): void {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") {
			return {
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			};
		}
		if (url.includes("/features")) {
			return {};
		}
		if (url.includes("/api/webhook") || url.includes("/api/audit-logs")) {
			return { items: [], nextCursor: null, totalCount: 0 };
		}
		if (url.includes("&limit=")) {
			return { items: [], totalCount: 0 };
		}
		return [];
	});
}

/** Everything rejects, as if the API were down. */
function stubDown(): void {
	apiFetch.mockRejectedValue(new Error("upstream unavailable"));
}

const PANELS = [
	{
		name: "BitmovinClient",
		render: () => renderWithQuery(<BitmovinClient />),
	},
	{
		name: "FeaturesClient",
		render: () => renderWithQuery(<FeaturesClient />),
	},
	{
		name: "PrewarmedPoolsPanel",
		render: () =>
			renderWithQuery(<PrewarmedPoolsPanel bitmovinAccountId="acct-1" />),
	},
	{
		name: "StreamKeysPanel",
		render: () =>
			renderWithQuery(<StreamKeysPanel bitmovinAccountId="acct-1" />),
	},
	{
		name: "StandbyPoolsPanel",
		render: () =>
			renderWithQuery(<StandbyPoolsPanel bitmovinAccountId="acct-1" />),
	},
	{
		name: "StaticIpsPanel",
		render: () =>
			renderWithQuery(<StaticIpsPanel bitmovinAccountId="acct-1" />),
	},
	{
		name: "CloudConnectPanel",
		render: () =>
			renderWithQuery(<CloudConnectPanel bitmovinAccountId="acct-1" />),
	},
	{
		name: "DnsMappingsSettingsPanel",
		render: () =>
			renderWithQuery(<DnsMappingsSettingsPanel bitmovinAccountId="acct-1" />),
	},
	{
		name: "WebhooksClient",
		render: () =>
			renderWithQuery(
				<WebhooksClient
					ingress={null}
					receiverEndpoint={null}
					secretSource="generated"
				/>,
			),
	},
] as const;

describe("settings panels mount", () => {
	for (const panel of PANELS) {
		it(`${panel.name} renders something on an EMPTY account`, async () => {
			stubEmpty();
			panel.render();
			// Not "it didn't throw": a panel that renders an empty <div> is the
			// dead end this asserts against. Something readable must appear.
			await waitFor(() =>
				expect(
					(document.body.textContent ?? "").trim().length,
					`${panel.name} rendered no text at all`,
				).toBeGreaterThan(10),
			);
		});

		it(`${panel.name} survives a DOWN endpoint without going blank`, async () => {
			// The branch that ships broken. A list whose query rejects and whose
			// component renders `data.map(...)` throws to the error boundary and
			// the operator sees a white page with no idea the API is the problem.
			stubDown();
			panel.render();
			await waitFor(() =>
				expect(
					(document.body.textContent ?? "").trim().length,
					`${panel.name} went blank when its endpoint failed`,
				).toBeGreaterThan(10),
			);
		});
	}

	it("a panel that lists rows shows them", async () => {
		// The positive control for the two loops above: with real rows, the row
		// content must actually reach the screen. Without this, a component that
		// only ever renders its heading passes everything else here.
		apiFetch.mockImplementation(async (url: string) => {
			if (url.startsWith("/api/bitmovin-accounts")) {
				return [
					{
						id: "acct-1",
						label: "verify-account-alpha",
						tenantOrgId: null,
						// REQUIRED on the wire (`defaults: schema.partial()`), and the
						// panel reads `account.defaults.encoderVersion`. Omitting it
						// crashed the mount — my fixture, not the product: the API
						// column is `Json @default("{}")` so it is never null.
						defaults: {},
						createdAt: "2026-08-01T00:00:00.000Z",
						updatedAt: "2026-08-01T00:00:00.000Z",
					},
				];
			}
			return [];
		});
		renderWithQuery(<BitmovinClient />);
		expect(await screen.findByText(/verify-account-alpha/)).toBeInTheDocument();
	});
});

/**
 * Battery batch 2b (ledger #149): the infrastructure forms that had never
 * mounted — CloudAccountForm (411 lines) and RegionSettingsEditor (252) —
 * plus the settings landing grid. The forms are where the zod schemas meet
 * a person; the designed-failure branch (a validation refusal that names
 * the field) is asserted, not just the happy mount.
 */
describe("CloudAccountForm (ledger #149 batch 2b)", () => {
	it("aws: refuses an empty account number with the field's own message", async () => {
		const { fireEvent } = await import("@testing-library/react");
		const onSubmit = vi.fn();
		renderWithQuery(
			<CloudAccountForm
				provider="aws"
				submitting={false}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Create account" }));
		expect(
			await screen.findByText(/account number is required/i),
		).toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("aws: submits the parsed payload once the required field is filled", async () => {
		const { fireEvent } = await import("@testing-library/react");
		const onSubmit = vi.fn();
		renderWithQuery(
			<CloudAccountForm
				provider="aws"
				submitting={false}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.change(screen.getByLabelText("AWS account number"), {
			target: { value: "123456789012" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create account" }));
		await vi.waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({ accountNumber: "123456789012" }),
		);
	});

	it("renders each provider's distinctive surface, not one shared form", () => {
		const cases: ["gce" | "azure" | "oci" | "akamai", string][] = [
			["gce", "Credentials mode"],
			["azure", "Subscription id"],
			["oci", "Tenancy OCID"],
			["akamai", "API token"],
		];
		for (const [provider, label] of cases) {
			const { unmount } = renderWithQuery(
				<CloudAccountForm
					provider={provider}
					submitting={false}
					onSubmit={vi.fn()}
				/>,
			);
			expect(
				screen.getByLabelText(new RegExp(label), {
					selector: provider === "gce" ? "select" : "input",
				}),
				`${provider} must offer "${label}"`,
			).toBeInTheDocument();
			// The AWS-only field must NOT leak into other providers.
			expect(screen.queryByLabelText("AWS account number")).toBeNull();
			unmount();
		}
	});
});

describe("RegionSettingsEditor (ledger #149 batch 2b)", () => {
	const props = {
		provider: "aws" as const,
		infrastructureId: "infra-1",
		bitmovinAccountId: "acct-1",
	};

	it("lists configured regions when the endpoint has data", async () => {
		apiFetch.mockResolvedValue({
			items: [
				{ region: "us-east-1", securityGroupId: "sg-1", subnetId: "sub-1" },
			],
			totalCount: 1,
		});
		renderWithQuery(<RegionSettingsEditor {...props} />);
		expect(await screen.findByText("us-east-1")).toBeInTheDocument();
	});

	it("an empty listing still offers the create form (no blank panel)", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/auth/session") {
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			}
			return { items: [], totalCount: 0 };
		});
		renderWithQuery(<RegionSettingsEditor {...props} />);
		expect(
			await screen.findByRole("button", { name: "Add region settings" }),
		).toBeInTheDocument();
	});

	it("says so when the listing endpoint is down", async () => {
		apiFetch.mockRejectedValue(new Error("upstream unavailable"));
		renderWithQuery(<RegionSettingsEditor {...props} />);
		expect(
			await screen.findByText(/Failed to load region settings/),
		).toBeInTheDocument();
	});

	it("refuses an empty create locally — nothing is POSTed", async () => {
		const { fireEvent } = await import("@testing-library/react");
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/auth/session") {
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			}
			return { items: [], totalCount: 0 };
		});
		renderWithQuery(<RegionSettingsEditor {...props} />);
		fireEvent.click(
			await screen.findByRole("button", { name: "Add region settings" }),
		);
		expect(
			await screen.findByText(/Security group id is required/),
		).toBeInTheDocument();
		const posts = apiFetch.mock.calls.filter(
			(call) => (call[1] as { method?: string } | undefined)?.method === "POST",
		);
		expect(posts).toHaveLength(0);
	});
});

describe("SettingsAreas (ledger #149 batch 2b)", () => {
	it("renders the workspace areas as links", () => {
		renderWithQuery(<SettingsAreas />);
		const links = [...document.querySelectorAll("a")].map((a) =>
			a.getAttribute("href"),
		);
		expect(links).toEqual(
			expect.arrayContaining(["/settings/bitmovin", "/settings/webhooks"]),
		);
	});
});
