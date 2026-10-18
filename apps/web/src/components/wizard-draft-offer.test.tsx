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
