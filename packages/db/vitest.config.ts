import { configDefaults, defineConfig } from "vitest/config";
import fence from "../../hierarchical-flow-fence.json";

// The tests of the fenced hierarchical story flow run through
// vitest.hierarchical-flow.config.ts (pnpm test:hierarchical-flow) instead.
const workspace = "packages/db/";
const fencedTests = fence.tests
	.filter((path) => path.startsWith(workspace))
	.map((path) => path.slice(workspace.length));

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, ...fencedTests],
	},
});
