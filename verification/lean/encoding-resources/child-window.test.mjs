import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { inspectChildWindow } from "../../../apps/web/src/lib/server/encoding-resources/child-window.ts";

const uuid = (index) =>
	index == null
		? "invalid"
		: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const validId = (id) => /^00000000-0000-4000-8000-[0-9]{12}$/.test(id);

test("the child window agrees with the checked Lean reference", (t) => {
	const fixtures = JSON.parse(
		execFileSync("lean", ["-DwarningAsError=true", "--run", "ChildWindow.lean"], {
			cwd: new URL(".", import.meta.url),
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		}),
	);
	assert.ok(fixtures.length > 0, "Lean must produce conformance cases");
	for (const [index, fixture] of fixtures.entries()) {
		const { page, whole, response, target, expected } = fixture;
		const rows = response.rows.map((id) => ({ id: uuid(id) }));
		const result = {
			items: rows,
			totalCount: response.total,
			offset: response.offset ?? undefined,
		};
		const actual = inspectChildWindow(
			result,
			page,
			whole,
			validId,
			target == null ? undefined : uuid(target),
		);
		if (expected == null) {
			assert.equal(actual, undefined, `Lean rejected case ${index}`);
		} else {
			const { endIndex, ...reference } = expected;
			assert.deepEqual(
				actual,
				{ ...reference, end: endIndex, rows },
				`Lean admitted case ${index}`,
			);
			assert.equal(actual.rows, rows);
		}
	}
	t.diagnostic(`${fixtures.length} Lean-generated cases`);
});
