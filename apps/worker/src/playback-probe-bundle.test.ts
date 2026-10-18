import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { playerBundlePath } from "../scripts/playback-probe";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it("owns and resolves the pinned DASH compatibility client", async () => {
	const pkg = JSON.parse(
		await readFile(join(WORKER_ROOT, "package.json"), "utf8"),
	) as { devDependencies?: Record<string, string> };
	expect(pkg.devDependencies?.dashjs).toBe("5.2.0");

	const expected = join(
		WORKER_ROOT,
		"node_modules/dashjs/dist/modern/umd/dash.all.min.js",
	);
	const actual = await playerBundlePath("DASH");
	expect(actual).toBe(expected);
	expect((await stat(actual)).isFile()).toBe(true);
});
