import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { BrandingClient } from "@/app/settings/branding/branding-client";
import { renderWithQuery } from "@/test/render";
import { AppBrand } from "./app-brand";
import { BrandingProvider } from "./branding-provider";

const { fetcher, session } = vi.hoisted(() => ({
	fetcher: vi.fn(),
	session: {
		data: {
			mode: "users",
			configured: true,
			authenticated: true,
			organizationId: "org-a",
			role: "ADMIN",
			isImpersonating: false,
		},
		refetch: vi.fn(),
		status: "success",
	},
}));
vi.mock("@/lib/api", () => ({ apiFetch: fetcher }));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => session,
	useRoleView: () => ({
		view: {
			kind: "role",
			role: session.data.isImpersonating ? "VIEWER" : session.data.role,
		},
		status: "success",
	}),
}));
let stored = { displayName: "My studio", iconDataUrl: null as string | null };
beforeEach(() => {
	session.data.organizationId = "org-a";
	session.data.role = "ADMIN";
	session.status = "success";
	session.data.isImpersonating = false;
	stored = { displayName: "My studio", iconDataUrl: null };
	fetcher.mockReset();
	fetcher.mockImplementation(async (_url, init) => {
		if (init?.method === "PATCH") stored = JSON.parse(init.body);
		return stored;
	});
});
const tree = () => (
	<BrandingProvider>
		<AppBrand />
		<BrandingClient />
	</BrandingProvider>
);
it("saves the name and updates the shared header immediately; reset is staged", async () => {
	renderWithQuery(tree());
	const name = await screen.findByLabelText("App name");
	fireEvent.change(name, { target: { value: "Example encoding" } });
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await screen.findByRole("link", { name: "Example encoding" });
	fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
	expect(
		screen.getByRole("link", { name: "Example encoding" }),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await screen.findByRole("link", { name: "Bitmovin OVP" });
});
it("shows read failure and retry without enabling an overwrite", async () => {
	fetcher.mockRejectedValueOnce(new Error("offline"));
	renderWithQuery(tree());
	await screen.findByRole("alert");
	expect(
		screen.queryByRole("button", { name: "Save" }),
	).not.toBeInTheDocument();
	expect(
		screen.getByRole("link", { name: "Bitmovin OVP" }),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await screen.findByLabelText("App name");
});
it("keeps edits after failed save and permits retry", async () => {
	renderWithQuery(tree());
	fireEvent.change(await screen.findByLabelText("App name"), {
		target: { value: "Unsaved" },
	});
	fetcher.mockRejectedValueOnce(new Error("offline"));
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await screen.findByRole("alert");
	expect(screen.getByLabelText("App name")).toHaveValue("Unsaved");
	expect(screen.getByRole("link", { name: "My studio" })).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await screen.findByRole("link", { name: "Unsaved" });
});
it("does not show the prior organization while a new organization read is pending", async () => {
	const view = renderWithQuery(tree());
	await screen.findByRole("link", { name: "My studio" });
	session.data.organizationId = "org-b";
	fetcher.mockImplementationOnce(() => new Promise(() => {}));
	view.rerender(tree());
	expect(
		screen.queryByRole("link", { name: "My studio" }),
	).not.toBeInTheDocument();
	expect(
		screen.getByRole("link", { name: "Bitmovin OVP" }),
	).toBeInTheDocument();
});
it("viewer reads the branding without edit controls", async () => {
	session.data.role = "VIEWER";
	renderWithQuery(tree());
	await screen.findByRole("link", { name: "My studio" });
	expect(screen.queryByLabelText("App name")).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Save" }),
	).not.toBeInTheDocument();
});

it("offers retry when the session read fails, rather than loading forever", async () => {
	session.status = "error";
	renderWithQuery(tree());
	expect(screen.getByRole("alert")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(session.refetch).toHaveBeenCalled();
	expect(fetcher).not.toHaveBeenCalled();
});
it("view-as reads the target brand but has no editor", async () => {
	session.data.isImpersonating = true;
	renderWithQuery(tree());
	await screen.findByRole("link", { name: "My studio" });
	expect(screen.queryByLabelText("App name")).not.toBeInTheDocument();
});

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=";
it("previews a valid upload, saves it, and removes it only after Save", async () => {
	const original = window.Image;
	class DecodableImage {
		naturalWidth = 1;
		naturalHeight = 1;
		onload: (() => void) | null = null;
		onerror = null;
		set src(_value: string) {
			queueMicrotask(() => this.onload?.());
		}
	}
	window.Image = DecodableImage as unknown as typeof Image;
	try {
		renderWithQuery(tree());
		const input = await screen.findByLabelText("App icon");
		fireEvent.change(input, {
			target: {
				files: [
					new File(
						[
							Uint8Array.from(atob(PNG.split(",")[1] ?? ""), (c) =>
								c.charCodeAt(0),
							),
						],
						"studio.png",
						{ type: "image/png" },
					),
				],
			},
		});
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
		);
		expect(document.querySelectorAll("img")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(stored.iconDataUrl).toBe(PNG));
		await waitFor(() =>
			expect(document.querySelectorAll("img")).toHaveLength(2),
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove icon" }));
		expect(stored.iconDataUrl).toBe(PNG);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(stored.iconDataUrl).toBeNull());
	} finally {
		window.Image = original;
	}
});
it("rejects unsupported upload without changing the saved icon", async () => {
	stored.iconDataUrl = PNG;
	renderWithQuery(tree());
	fireEvent.change(await screen.findByLabelText("App icon"), {
		target: {
			files: [new File(["<svg/>"], "bad.svg", { type: "image/svg+xml" })],
		},
	});
	await screen.findByRole("alert");
	expect(stored.iconDataUrl).toBe(PNG);
	expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});
it("renders long plain-text names with an intact accessible label and icon fallback", async () => {
	stored = { displayName: `<script>${"長".repeat(50)}`, iconDataUrl: PNG };
	renderWithQuery(tree());
	const link = await screen.findByRole("link", { name: stored.displayName });
	expect(link).toHaveAttribute("title", stored.displayName);
	expect(link.querySelector("span.truncate")).toHaveTextContent(
		stored.displayName,
	);
	expect(link.querySelector("script")).toBeNull();
	const img = link.querySelector("img");
	if (!img) throw new Error("missing icon");
	fireEvent.error(img);
	expect(link.querySelector("img")).toBeNull();
	expect(link).toHaveTextContent(stored.displayName);
});

it("a pre-save GET resolving late cannot overwrite successfully saved branding", async () => {
	const view = renderWithQuery(tree());
	const input = await screen.findByLabelText("App name");
	let resolveOld: (value: typeof stored) => void = () => {};
	const oldGet = new Promise<typeof stored>((resolve) => {
		resolveOld = resolve;
	});
	fetcher.mockImplementationOnce(() => oldGet);
	let refetch: Promise<void> = Promise.resolve();
	act(() => {
		refetch = view.client.refetchQueries({
			queryKey: ["workspace-branding", "org-a"],
			exact: true,
		});
	});
	await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
	fireEvent.change(input, { target: { value: "New saved brand" } });
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await screen.findByRole("link", { name: "New saved brand" });
	await act(async () => {
		resolveOld({ displayName: "My studio", iconDataUrl: null });
		await refetch;
	});
	expect(
		screen.getByRole("link", { name: "New saved brand" }),
	).toBeInTheDocument();
	expect(view.client.getQueryData(["workspace-branding", "org-a"])).toEqual({
		displayName: "New saved brand",
		iconDataUrl: null,
	});
});
