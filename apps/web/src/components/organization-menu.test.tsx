import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { OrganizationMenu } from "./organization-menu";

const mocks = vi.hoisted(() => ({
	session: {} as { status: string; data?: Record<string, unknown> },
	api: vi.fn(),
	reload: vi.fn(),
}));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => mocks.session }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("@/lib/tenant-fetch", () => ({
	reloadAfterOrganizationChange: mocks.reload,
}));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.api.mockResolvedValue({});
	mocks.session = {
		status: "success",
		data: {
			authenticated: true,
			mode: "users",
			organizationId: "A",
			organizationName: "Studio A",
			organizations: [
				{ id: "A", name: "Studio A" },
				{ id: "B", name: "Studio B" },
			],
		},
	};
});
describe("organization menu", () => {
	it("switches the shared organization then discards the old document", async () => {
		renderWithQuery(<OrganizationMenu />);
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Organization" }),
			"B",
		);
		expect(mocks.api).toHaveBeenCalledWith("/api/account/organization", {
			method: "POST",
			body: JSON.stringify({ organizationId: "B" }),
		});
		await vi.waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
	});
	it("shows one organization without an unnecessary selector", () => {
		mocks.session.data = {
			...mocks.session.data,
			organizations: [{ id: "A", name: "Studio A" }],
		};
		renderWithQuery(
			<OrganizationMenu>
				<span>Page account</span>
			</OrganizationMenu>,
		);
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		expect(screen.getByText("Studio A")).toBeInTheDocument();
		expect(
			screen.getByText("Studio A").parentElement?.parentElement,
		).toContainElement(screen.getByText("Page account"));
	});
	it("announces read-only view-as and exits without retaining target data", async () => {
		mocks.session.data = {
			...mocks.session.data,
			isImpersonating: true,
			targetDisplayName: "Member",
		};
		renderWithQuery(
			<OrganizationMenu>
				<span>Page account</span>
			</OrganizationMenu>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Read only");
		expect(screen.queryByText("Page account")).not.toBeInTheDocument();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Exit view-as" }));
		expect(mocks.api).toHaveBeenCalledWith("/api/account/impersonation", {
			method: "DELETE",
		});
		await vi.waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
	});
	it("withholds a cached organization after session verification fails", () => {
		mocks.session.status = "error";
		renderWithQuery(<OrganizationMenu />);
		expect(screen.queryByText("Studio A")).not.toBeInTheDocument();
	});
});
