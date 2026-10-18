import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";
import { IpPolicy, type Organization } from "./ip-policy";
import { Organizations } from "./organizations";
import { ViewAs } from "./view-as";

const mocks = vi.hoisted(() => ({ api: vi.fn(), reload: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	apiFetch: mocks.api,
}));
vi.mock("@/lib/tenant-fetch", () => ({
	reloadAfterOrganizationChange: mocks.reload,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: {
			platformOwner: true,
			organizationId: "A",
			organizationName: "Studio A",
			organizations: [{ id: "A", name: "Studio A" }],
		},
	}),
}));
const org: Organization = {
	id: "A",
	name: "Studio A",
	slug: "studio-a",
	active: true,
	allowedIpCidrs: [],
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.api.mockImplementation(
		async (path: string, options?: { method?: string }) => {
			if (options?.method) return {};
			if (path.endsWith("/members"))
				return [{ id: "member", displayName: "Member", role: "VIEWER" }];
			if (path === "/api/organizations") return { organizations: [org] };
			return { organization: org, clientIp: "127.0.0.1" };
		},
	);
});
describe("organization forms submit through their visible buttons", () => {
	it("creates an organization from its name and slug", async () => {
		renderWithQuery(<Organizations />);
		await userEvent.type(
			screen.getByRole("textbox", { name: "Name" }),
			"Studio B",
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: "ID" }),
			"studio-b",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Create organization" }),
		);
		await vi.waitFor(() =>
			expect(mocks.api).toHaveBeenCalledWith("/api/organizations", {
				method: "POST",
				body: JSON.stringify({ name: "Studio B", slug: "studio-b" }),
			}),
		);
	});
	it.each([
		false,
		true,
	])("saves the explicit IP policy through the %s owner capability", async (owner) => {
		renderWithQuery(
			<IpPolicy
				organizationId="A"
				owner={owner}
				initial={owner ? org : undefined}
			/>,
		);
		const input = await screen.findByRole("textbox", {
			name: "Allowed client IPs",
		});
		await vi.waitFor(() => expect(input).toBeEnabled());
		await userEvent.type(input, "192.0.2.10\n2001:db8::/32");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await vi.waitFor(() =>
			expect(mocks.api).toHaveBeenCalledWith(
				owner ? "/api/platform/organizations/A" : "/api/organizations/A",
				{
					method: "PATCH",
					body: JSON.stringify({
						allowedIpCidrs: ["192.0.2.10", "2001:db8::/32"],
					}),
				},
			),
		);
	});
	it("reproves the owner password and opens the selected read-only dashboard", async () => {
		renderWithQuery(<ViewAs organizations={[org]} />);
		await screen.findByRole("option", { name: "Member · VIEWER" });
		await userEvent.type(
			screen.getByLabelText("Your password"),
			"synthetic-owner-password",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Open dashboard" }),
		);
		await vi.waitFor(() =>
			expect(mocks.api).toHaveBeenCalledWith("/api/account/impersonation", {
				method: "POST",
				body: JSON.stringify({
					organizationId: "A",
					targetUserId: "member",
					currentPassword: "synthetic-owner-password",
				}),
			}),
		);
		await vi.waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
		expect(screen.getByLabelText("Your password")).toHaveValue("");
	});
	it("explains invalid IPs without exposing diagnostic text or clearing the draft", async () => {
		mocks.api.mockRejectedValue(
			new ApiError(400, "private diagnostic value", {
				code: "TENANT_IP_INVALID",
			}),
		);
		renderWithQuery(<IpPolicy organizationId="A" owner initial={org} />);
		const input = screen.getByRole("textbox", { name: "Allowed client IPs" });
		await userEvent.type(input, "invalid-address");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Enter a valid IP address or CIDR on each line.",
		);
		expect(input).toHaveValue("invalid-address");
		expect(screen.queryByText(/private diagnostic/)).not.toBeInTheDocument();
	});
	it("localizes failed owner reauthentication and clears the submitted password", async () => {
		const original = mocks.api.getMockImplementation();
		mocks.api.mockImplementation(
			(path: string, options?: { method?: string }) =>
				options?.method
					? Promise.reject(
							new ApiError(401, "private diagnostic value", {
								code: "AUTH_INVALID_CREDENTIALS",
							}),
						)
					: original?.(path),
		);
		renderWithQuery(<ViewAs organizations={[org]} />);
		await screen.findByRole("option", { name: "Member · VIEWER" });
		await userEvent.type(screen.getByLabelText("Your password"), "incorrect");
		await userEvent.click(
			screen.getByRole("button", { name: "Open dashboard" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The email address or password is incorrect.",
		);
		expect(screen.getByLabelText("Your password")).toHaveValue("");
		expect(screen.queryByText(/private diagnostic/)).not.toBeInTheDocument();
	});
});
