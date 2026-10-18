export const THEMES = [
	"neon",
	"slate",
	"paper",
	"dimmed",
	"solarized-dark",
	"solarized-light",
	"high-contrast",
	"system",
] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "bitovp-theme";

export function resolveTheme(value: string | undefined): Theme {
	return THEMES.find((candidate) => candidate === value) ?? "neon";
}
