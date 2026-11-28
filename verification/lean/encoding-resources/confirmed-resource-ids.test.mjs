import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { sameConfirmedResourceIds } from "../../../apps/web/src/lib/server/confirmed-resource-ids.ts";

const uuid = (index) =>
	`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("bulk resource confirmation agrees with the checked Lean permutation model", (t) => {
	const fixtures = JSON.parse(
		execFileSync(
			"lean",
			["-DwarningAsError=true", "--run", "ConfirmedResourceIds.lean"],
			{ cwd: new URL(".", import.meta.url), encoding: "utf8" },
		),
	);
	assert.ok(fixtures.some(({ expected }) => expected));
	assert.ok(fixtures.some(({ expected }) => !expected));
	for (const [index, { observed, confirmed, expected }] of fixtures.entries()) {
		assert.equal(
			sameConfirmedResourceIds(
				observed.map((id) => (id === null ? undefined : uuid(id))),
				confirmed.map(uuid),
			),
			expected,
			`bulk confirmation case ${index}`,
		);
	}
	t.diagnostic(`${fixtures.length} Lean-generated cases`);
});
