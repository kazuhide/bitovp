import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n/context";
import { LocaleSwitcher } from "./locale-switcher";

/**
 * `LocaleSwitcher` had no test file. A review found that removing its
 * `window.location.reload` left the whole suite green — and that call is not
 * incidental: the locale enters the tree as a prop from the ROOT layout and
 * `<html lang>` is part of the server-rendered document, so a soft refresh would
 * re-render the route segment while leaving both in place. Half the page would
 * switch language. The reload is a stated design invariant with nothing holding it.
 */
const reload = vi.fn();
const cookieWrites: string[] = [];

beforeEach(() => {
	reload.mockClear();
	cookieWrites.length = 0;
	vi.spyOn(document, "cookie", "set").mockImplementation((v: string) => {
		cookieWrites.push(v);
	});
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { protocol: "http:", reload },
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function renderSwitcher(locale: "en" | "ja" = "en") {
	return render(
		<LocaleProvider locale={locale}>
			<LocaleSwitcher />
		</LocaleProvider>,
	);
}

describe("LocaleSwitcher", () => {
	it("offers a labelled settings selector that persists and reloads", async () => {
		render(
			<LocaleProvider locale="en">
				<LocaleSwitcher select />
			</LocaleProvider>,
		);
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Language" }),
			"ja",
		);
		expect(cookieWrites).toHaveLength(1);
		expect(cookieWrites[0]).toContain("ja");
		expect(reload).toHaveBeenCalledOnce();
	});
	it("marks the active locale pressed and the other not", () => {
		renderSwitcher("ja");
		expect(screen.getByRole("button", { name: "日本語" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: "English" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	it("writes the cookie AND reloads when a different locale is chosen", () => {
		renderSwitcher("en");
		screen.getByRole("button", { name: "日本語" }).click();
		expect(cookieWrites).toHaveLength(1);
		expect(cookieWrites[0]).toContain("ja");
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("does nothing at all when the active locale is re-chosen", () => {
		// Otherwise every click on the current language costs a full page load.
		renderSwitcher("en");
		screen.getByRole("button", { name: "English" }).click();
		expect(cookieWrites).toEqual([]);
		expect(reload).not.toHaveBeenCalled();
	});

	it("labels itself with a real legend, not an aria-label on a div", () => {
		// `<fieldset>`/`<legend>` was chosen so the visible text IS the accessible
		// name and the two cannot drift; biome rejected the div+role="group" form.
		const { container } = renderSwitcher();
		const fieldset = container.querySelector("fieldset");
		expect(fieldset).not.toBeNull();
		expect(fieldset?.querySelector("legend")?.textContent).toContain(
			"Language",
		);
	});

	it("tags each option with its own lang so a screen reader switches voice", () => {
		renderSwitcher();
		expect(screen.getByRole("button", { name: "日本語" })).toHaveAttribute(
			"lang",
			"ja",
		);
	});
});
