import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradeOptions } from "./upgrade-rehearsal.mjs";

test("requires a dedicated absolute output path outside the checkout", () => {
	assert.throws(() => upgradeOptions([], "/repo"));
	assert.throws(() => upgradeOptions(["--output-directory", "results"], "/repo"));
	assert.throws(() => upgradeOptions(["--output-directory", "/repo/results"], "/repo"));
	assert.deepEqual(upgradeOptions(["--output-directory", "/private/results"], "/repo"), {
		baseRef: "v1.2.1", outputDirectory: "/private/results",
	});
});

test("rejects unrecognized or duplicated options instead of selecting a different baseline", () => {
	assert.throws(() => upgradeOptions(["--output-directory", "/private/results", "--baseline", "main"], "/repo"));
	assert.throws(() => upgradeOptions(["--output-directory", "/private/results", "--output-directory", "/other"], "/repo"));
});
