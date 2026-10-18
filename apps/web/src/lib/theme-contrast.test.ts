import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { THEMES } from "./theme";

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
const blocks = [...css.matchAll(/(:root[^{}]*)\{([^}]+)\}/g)];

function contrast(first: string, second: string) {
	function luminance(hex: string) {
		const channels = [1, 3, 5].map((offset) => {
			const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
			return value <= 0.04045
				? value / 12.92
				: ((value + 0.055) / 1.055) ** 2.4;
		});
		return [0.2126, 0.7152, 0.0722].reduce(
			(sum, weight, index) => sum + (channels[index] ?? 0) * weight,
			0,
		);
	}
	const a = luminance(first);
	const b = luminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

it.each(
	THEMES,
)("keeps common text and action colours readable in %s", (theme) => {
	const defaults = {
		"zinc-900": "#18181b",
		"zinc-950": "#09090b",
		"zinc-400": "#a1a1aa",
	};
	const values = Object.assign(
		{},
		defaults,
		...blocks
			.filter(
				(block) =>
					block[1]?.trim() === ":root" ||
					block[1]?.includes(`data-theme="${theme}"`),
			)
			.map((block) =>
				Object.fromEntries(
					[
						...(block[2] ?? "").matchAll(/--color-([\w-]+): (#[\da-f]{6})/g),
					].map((match) => [match[1] ?? "", match[2] ?? ""]),
				),
			),
	) as Record<string, string>;
	function value(key: string) {
		const colour = values[key];
		if (!colour) throw new Error(`Missing colour token: ${key}`);
		return colour;
	}
	for (const foreground of ["zinc-400", "zinc-500", "zinc-600"]) {
		expect(
			contrast(value(foreground), value("zinc-900")),
		).toBeGreaterThanOrEqual(4.5);
		expect(
			contrast(value(foreground), value("zinc-950")),
		).toBeGreaterThanOrEqual(4.5);
	}
	for (const action of ["emerald-500", "emerald-600"]) {
		expect(contrast("#ffffff", value(action))).toBeGreaterThanOrEqual(4.5);
	}
});
