import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

if (
	process.platform !== "linux" ||
	process.env.GITHUB_ACTIONS !== "true" ||
	process.env.RUNNER_ENVIRONMENT !== "github-hosted"
)
	throw new Error("Run browser verification on a GitHub-hosted Linux runner");

const file = process.env.BITOVP_GUI_SMOKE_FIXTURE;
if (!file) throw new Error("Run the installed GUI fixture launcher first");
const fixture = JSON.parse(readFileSync(file, "utf8"));
if (
	!/^[a-f0-9]{32}$/.test(fixture.id) ||
	!/^http:\/\/localhost:[1-9]\d*$/.test(fixture.baseURL) ||
	!/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(fixture.secondary?.baseURL)
)
	throw new Error("Only the dedicated loopback installation may be tested");

export default defineConfig({
	testDir: ".",
	testMatch: "installed-gui.test.ts",
	workers: 1,
	retries: 0,
	forbidOnly: true,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	outputDir: join(fixture.directory, "browser-output"),
	reporter: [
		["json", { outputFile: join(fixture.directory, "browser-results.json") }],
	],
	use: {
		baseURL: fixture.baseURL,
		browserName: "chromium",
		headless: true,
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		serviceWorkers: "block",
		trace: "off",
		screenshot: "off",
		video: "off",
	},
});
