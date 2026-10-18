import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";
import AccountsPage from "../bitmovin/page";
import FeaturesPage from "../features/page";
import NotificationsPage from "../notifications/page";
import PlayerPage from "../player/page";
import BasicSettingsPage from "./page";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
	redirect: (...args: unknown[]) => redirect(...args),
}));
it("redirects the former Basic settings URL to Settings", () => {
	BasicSettingsPage();
	expect(redirect).toHaveBeenCalledWith("/settings");
});
it.each([
	AccountsPage,
	PlayerPage,
	FeaturesPage,
	NotificationsPage,
])("links child pages directly back to Settings (%#)", (Page) => {
	wrap(Page().props.children[0]);
	expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
		"href",
		"/settings",
	);
	expect(screen.queryByRole("link", { name: "Basic settings" })).toBeNull();
});
