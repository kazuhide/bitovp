import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import { NewCredentialLink } from "./new-credential-link";

/**
 * Owner request 2026-08-19: a way to register a credential from inside a
 * wizard, rather than abandoning a half-filled form and starting over.
 */
function render() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	renderL(
		<QueryClientProvider client={client}>
			<NewCredentialLink />
		</QueryClientProvider>,
	);
	return { invalidate };
}

describe("the add-a-credential link", () => {
	it("deep-links to the ADD dialog, not just the settings list", () => {
		render();
		const link = screen.getByRole("link");
		// `?new=1` is the difference between landing on the form and landing on
		// a list to hunt for the button — one step after the operator already
		// decided to create one.
		expect(link.getAttribute("href")).toBe("/settings/credentials?new=1");
	});

	it("opens a NEW TAB, because the wizard's state does not survive a route change", () => {
		render();
		const link = screen.getByRole("link");
		expect(link.getAttribute("target")).toBe("_blank");
		// `noopener` is not decoration on a `_blank` link: without it the opened
		// page gets a handle on this one via `window.opener`.
		expect(link.getAttribute("rel")).toContain("noopener");
	});

	it("says so in the label, so the new tab is not a surprise", () => {
		render();
		expect(screen.getByRole("link").textContent).toMatch(/new tab/i);
	});

	it("refreshes the credential list when the operator comes BACK", () => {
		// The failure this prevents: create a credential, return to the wizard,
		// and the picker still does not list it — which reads as the save
		// having failed.
		const { invalidate } = render();
		fireEvent.click(screen.getByRole("link"));
		// Not on click: there is nothing new to fetch while the tab is still
		// opening.
		expect(invalidate).not.toHaveBeenCalled();
		fireEvent.focus(window);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["credentials"] });
	});

	it("stops listening after the first return, rather than refetching forever", () => {
		const { invalidate } = render();
		fireEvent.click(screen.getByRole("link"));
		fireEvent.focus(window);
		fireEvent.focus(window);
		fireEvent.focus(window);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
});
