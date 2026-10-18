import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ThemeProvider } from "./theme-provider";
import { ThemeSwitcher } from "./theme-switcher";

afterEach(() => {
	delete document.documentElement.dataset.theme;
	// biome-ignore lint/suspicious/noDocumentCookie: Clear the preference between tests.
	document.cookie = "bitovp-theme=; Path=/; Max-Age=0";
});

it("changes both controls and the page immediately without losing form data", async () => {
	renderWithQuery(
		<ThemeProvider initialTheme="slate">
			<ThemeSwitcher />
			<ThemeSwitcher compact />
			<input aria-label="Draft name" defaultValue="Unsaved draft" />
		</ThemeProvider>,
	);
	const controls = screen.getAllByRole("combobox", { name: "Appearance" });
	expect(controls[0]).toHaveValue("slate");
	const compact = controls[1];
	if (!compact) throw new Error("Missing compact theme control");
	await userEvent.selectOptions(compact, "paper");
	expect(controls[0]).toHaveValue("paper");
	expect(document.documentElement).toHaveAttribute("data-theme", "paper");
	expect(document.cookie).toContain("bitovp-theme=paper");
	expect(screen.getByRole("textbox", { name: "Draft name" })).toHaveValue(
		"Unsaved draft",
	);
});

it.each([
	"dimmed",
	"solarized-dark",
	"solarized-light",
	"high-contrast",
	"system",
])("persists %s without discarding a draft", async (theme) => {
	renderWithQuery(
		<ThemeProvider initialTheme="neon">
			<ThemeSwitcher />
			<input aria-label="Draft" defaultValue="Keep this" />
		</ThemeProvider>,
	);
	await userEvent.selectOptions(screen.getByRole("combobox"), theme);
	expect(document.documentElement).toHaveAttribute("data-theme", theme);
	expect(document.cookie).toContain(`bitovp-theme=${theme}`);
	expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
		"Keep this",
	);
});
