import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MESSAGES = join(__dirname, "../lib/i18n/messages");

function read(file: string): string {
	return readFileSync(join(MESSAGES, file), "utf8");
}

function value(text: string, section: string, key: string): string {
	const start = text.indexOf(`\n\t${section}: {`);
	if (start === -1) throw new Error(`no ${section} section`);
	const end = text.indexOf("\n\t},", start);
	const body = text.slice(start, end);
	const match = new RegExp(`\\n\\t\\t${key}: "([^"]*)"`).exec(body);
	if (!match) throw new Error(`no ${section}.${key}`);
	return match[1] ?? "";
}

describe("the credentials screen has one name", () => {
	it.each([
		"en.ts",
		"ja.ts",
	])("%s: the tab title matches the heading", (file) => {
		const text = read(file);

		expect(value(text, "pageTitles", "storageCredentials")).toBe(
			value(text, "settings", "storageCredentials"),
		);
	});

	const STALE_POINTERS = [
		"Settings → Storage credentials",
		"設定 → ストレージ資格情報",
	];

	function trackedText(): { rel: string; text: string }[] {
		const root = join(__dirname, "../../../..");
		return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
			.trim()
			.split("\n")
			.filter((f) => /\.(ts|tsx|md)$/.test(f))

			.filter((f) => !f.endsWith("screen-names.test.ts"))
			.map((rel) => ({ rel, text: readFileSync(join(root, rel), "utf8") }));
	}

	it("no tracked file routes anybody to the old name", () => {
		const files = trackedText();
		expect(
			files.length,
			"the walk found nothing — it is broken",
		).toBeGreaterThan(100);
		const offenders: string[] = [];
		for (const { rel, text } of files) {
			text.split("\n").forEach((raw, i) => {
				const line = raw.trim();

				if (line.startsWith("//") || line.startsWith("*")) return;
				for (const stale of STALE_POINTERS) {
					if (line.includes(stale)) offenders.push(`${rel}:${i + 1} ${line}`);
				}
			});
		}
		expect(offenders, "point these at the screen's actual name").toEqual([]);
	});

	it("the heading itself is not the old name — otherwise both halves agree, wrongly", () => {
		expect(value(read("en.ts"), "settings", "storageCredentials")).toBe(
			"Credentials",
		);
		expect(value(read("ja.ts"), "settings", "storageCredentials")).toBe(
			"認証情報",
		);
	});
});
