import { defineConfig } from "vitest/config";
import fence from "../../hierarchical-flow-fence.json";

// Runs only the tests of the fenced hierarchical story flow, which
// vitest.config.ts leaves out. See hierarchical-flow-fence.json.
const workspace = "packages/core/";

export default defineConfig({
	test: {
		environment: "node",
		include: fence.tests
			.filter((path) => path.startsWith(workspace))
			.map((path) => path.slice(workspace.length)),
	},
});
