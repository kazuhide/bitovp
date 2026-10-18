import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		// Node 26's experimental global localStorage shadows jsdom's Storage and
		// bypasses Storage.prototype spies. Let the browser test realm own it.
		execArgv: ["--no-experimental-webstorage"],
		setupFiles: ["./src/__tests__/setup.ts"],
		// 5 s (the default) measured the machine, not the arm: under three
		// concurrent gate runs, findBy-based arms in live-wizard.output and
		// live-settings-views timed out at the TEST ceiling before the 10 s
		// asyncUtilTimeout in setup.ts could matter (2026-08-29). The queries
		// still resolve on the observed element; only the ceiling moves.
		testTimeout: 20_000,
		include: ["src/**/*.test.{ts,tsx}"],
		globals: true,
	},
	resolve: {
		alias: {
			"server-only": path.resolve(
				__dirname,
				"./src/__tests__/server-only-stub.ts",
			),
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
