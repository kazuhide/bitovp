import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { WizardDraftOffer } from "./wizard-draft-offer";

it.each([
	"en",
	"ja",
] as const)("offers only explicit restore/discard actions in %s", (locale) => {
	const restore = vi.fn();
	const discard = vi.fn();
	const view = renderWithQuery(
		<WizardDraftOffer available restore={restore} discard={discard} />,
		locale,
	);
	expect(restore).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: locale === "en" ? "Restore" : "復元" }),
	);
	fireEvent.click(
		screen.getByRole("button", { name: locale === "en" ? "Discard" : "破棄" }),
	);
	expect(restore).toHaveBeenCalledOnce();
	expect(discard).toHaveBeenCalledOnce();
	view.rerender(
		<WizardDraftOffer available={false} restore={restore} discard={discard} />,
	);
	expect(
		screen.queryByRole("button", {
			name: locale === "en" ? "Restore" : "復元",
		}),
	).toBeNull();
});

it("explains the v1 recovery before restore and offers only its saved settings", () => {
	const restore = vi.fn();
	const settings = { name: "Older title", labels: ["ep-1"] };
	renderWithQuery(
		<WizardDraftOffer
			available
			restore={restore}
			discard={() => {}}
			legacyVersion
			legacySettings={settings}
		/>,
		"en",
	);
	expect(
		screen.getByText(/did not record all filter or rendition settings/),
	).toBeTruthy();
	const link = screen.getByRole("link", { name: "Download saved settings" });
	expect(link).toHaveAttribute("download", "vod-draft-settings.json");
	expect(
		JSON.parse(
			decodeURIComponent(link.getAttribute("href")?.split(",")[1] ?? ""),
		),
	).toEqual(settings);
	expect(restore).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: "Restore name and labels" }),
	);
	expect(restore).toHaveBeenCalledOnce();
});
it("identifies v1's missing filters before a regular restore into a fresh job", () => {
	renderWithQuery(
		<WizardDraftOffer
			available
			restore={() => {}}
			discard={() => {}}
			legacyVersion
		/>,
		"en",
	);
	expect(screen.getByText(/ordinary video watermarks only/)).toBeTruthy();
	expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
	expect(screen.queryByRole("link")).toBeNull();
});
