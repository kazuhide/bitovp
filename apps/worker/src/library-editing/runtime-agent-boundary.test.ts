import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Product runtime must not depend on a developer's coding-agent session. */
describe("development-agent runtime boundary", () => {
	it("does not ship the withdrawn coding-agent bridge or activation adapters", () => {
		for (const path of [
			"apps/worker/scripts/story-model-bridge.ts",
			"apps/worker/scripts/story-model-config.ts",
			"apps/worker/src/library-editing/story-model-client.ts",
			"packages/core/src/content-editing/story-config.ts",
			"scripts/story-preview.mjs",
			"docker-compose.story.yml",
		])
			expect(existsSync(fileURLToPath(new URL(path, root))), path).toBe(false);
	});
	it("cannot activate a coding-agent model from worker startup or preview commands", () => {
		const entrypoint = read("apps/worker/src/index.ts");
		expect(entrypoint).not.toMatch(
			/createConfiguredStoryModel|story-model-client|BITOVP_STORY_MODEL|CODEX_HOME/,
		);
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.scripts).not.toHaveProperty("preview:story");
	});
});
