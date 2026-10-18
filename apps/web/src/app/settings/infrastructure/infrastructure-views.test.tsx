import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { InfrastructureClient } from "./infrastructure-client";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

function mockApi() {
	apiFetch.mockImplementation(async (input: unknown) => {
		const url = String(input);
		if (url === "/api/bitmovin-accounts") {
			return [
				{ id: ACCOUNT_ID, label: "main", tenantOrgId: null, defaults: {} },
			];
		}
		if (url.startsWith("/api/infrastructure/cloud-connect/aws?")) {
			return {
				totalCount: 1,
				items: [
					{
						id: "infra-1",
						name: "prod-byoc",
						accountNumber: "123456789012",
						roleName: "bitmovin-encoding",
					},
				],
			};
		}
		if (url.startsWith("/api/infrastructure/static-ips?")) {
			return {
				totalCount: 2,
				items: [
					{
						id: "ip-1",
						ipAddress: "203.0.113.10",
						status: "UNUSED",
						region: "AWS_EU_WEST_1",
					},
					{
						id: "ip-2",
						ipAddress: "203.0.113.11",
						status: "USED",
						region: "AWS_EU_WEST_1",
					},
				],
			};
		}
		if (url.startsWith("/api/infrastructure/prewarmed-pools?")) {
			return {
				totalCount: 1,
				items: [
					{
						id: POOL_ID,
						name: "evening-rush",
						encoderVersion: "STABLE",
						cloudRegion: "AWS_EU_WEST_1",
						diskSize: "500",
						targetPoolSize: 2,
						dynamicPool: true,
						status: "STARTED",
					},
				],
			};
		}
		if (url.includes("/actions")) {
			return { id: POOL_ID, action: "stop" };
		}
		throw new Error(`unexpected apiFetch: ${url}`);
	});
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("InfrastructureClient", () => {
	it("lists Cloud Connect accounts with the delete + re-create copy (default tab)", async () => {
		mockApi();
		wrap(<InfrastructureClient />);

		expect(await screen.findByText("prod-byoc")).toBeInTheDocument();
		expect(
			screen.getByText(/arn:aws:iam::123456789012:role\/bitmovin-encoding/),
		).toBeInTheDocument();
		// The no-update constraint is spelled out.
		await userEvent.click(
			screen.getByRole("button", { name: "Provider — more information" }),
		);
		expect(
			screen.getByText(/no update\s?call\. To change one, delete it and/i),
		).toBeInTheDocument();
	});

	it("shows static IPs with status chips on the Static IPs tab", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<InfrastructureClient />);
		await screen.findByText("prod-byoc");

		await user.click(screen.getByRole("tab", { name: "Static IPs" }));

		expect(await screen.findByText("203.0.113.10")).toBeInTheDocument();
		expect(screen.getByText("UNUSED")).toBeInTheDocument();
		expect(screen.getByText("USED")).toBeInTheDocument();
		// consumed-at-encoding copy is present.
		await user.click(
			screen.getByRole("button", { name: "Static IPs — more information" }),
		);
		expect(
			screen.getByText(/attached when a LIVE encoding is created/i),
		).toBeInTheDocument();
	});

	it("stops a STARTED pool via the actions route", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<InfrastructureClient />);
		await screen.findByText("prod-byoc");

		await user.click(screen.getByRole("tab", { name: "Prewarmed pools" }));
		expect(await screen.findByText("evening-rush")).toBeInTheDocument();
		expect(screen.getByText("STARTED")).toBeInTheDocument();
		expect(screen.getByText("dynamic ≤10")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/infrastructure/prewarmed-pools/${POOL_ID}/actions`,
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						bitmovinAccountId: ACCOUNT_ID,
						action: "stop",
					}),
				}),
			);
		});
	});

	it("pages static IPs via Load more and surfaces totalCount (C6)", async () => {
		const ip = (id: string, ipAddress: string) => ({
			id,
			ipAddress,
			status: "UNUSED",
			region: "AWS_EU_WEST_1",
		});
		apiFetch.mockImplementation(async (input: unknown) => {
			const url = String(input);
			if (url === "/api/bitmovin-accounts") {
				return [
					{ id: ACCOUNT_ID, label: "main", tenantOrgId: null, defaults: {} },
				];
			}
			if (url.startsWith("/api/infrastructure/cloud-connect/aws?")) {
				return { totalCount: 0, items: [] };
			}
			if (url.startsWith("/api/infrastructure/static-ips?")) {
				const offset = Number(
					new URL(`http://t${url}`).searchParams.get("offset"),
				);
				return offset === 0
					? {
							totalCount: 3,
							items: [ip("ip-1", "203.0.113.10"), ip("ip-2", "203.0.113.11")],
						}
					: { totalCount: 3, items: [ip("ip-3", "203.0.113.12")] };
			}
			throw new Error(`unexpected apiFetch: ${url}`);
		});
		const user = userEvent.setup();
		wrap(<InfrastructureClient />);
		await user.click(await screen.findByRole("tab", { name: "Static IPs" }));

		expect(await screen.findByText("203.0.113.10")).toBeInTheDocument();
		expect(screen.getByText(/Showing 2 of 3/)).toBeInTheDocument();
		expect(screen.queryByText("203.0.113.12")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("203.0.113.12")).toBeInTheDocument();
		expect(screen.getByText(/Showing 3 of 3/)).toBeInTheDocument();
		// All pages loaded — the appender goes away.
		expect(
			screen.queryByRole("button", { name: "Load more" }),
		).not.toBeInTheDocument();
	});

	it("prompts to add a Bitmovin account when none exist", async () => {
		apiFetch.mockResolvedValueOnce([]);
		wrap(<InfrastructureClient />);
		expect(
			await screen.findByText("No Bitmovin accounts yet"),
		).toBeInTheDocument();
		expect(screen.queryByRole("tab")).not.toBeInTheDocument();
	});
});

/**
 * Cloud Connect copy is interpolated with the provider label, so these assert the
 * placeholder actually got filled — `translate` throws on an unfilled one, which
 * makes a missing value a failure here rather than a "{provider}" on screen.
 */
describe("InfrastructureClient — Japanese", () => {
	it("renders the Cloud Connect intro and empty state in Japanese", async () => {
		mockApi();
		wrap(<InfrastructureClient />, "ja");
		await userEvent.click(
			await screen.findByRole("button", { name: "「プロバイダ」の説明" }),
		);
		expect(
			await screen.findByText(/Cloud Connect は Bitmovin のエンコーダ/),
		).toBeInTheDocument();
		// The provider label is interpolated into the confirm copy and the dialog
		// title; `translate` throws on an unfilled placeholder, so reaching this
		// assertion at all proves the value was passed.
		expect(screen.getByText(/AWS アカウントを追加/)).toBeInTheDocument();
		expect(
			screen.queryByText(/runs Bitmovin encoders inside YOUR/),
		).not.toBeInTheDocument();
	});
});
