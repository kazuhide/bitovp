import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { projectEncodingMetadata } from "../../../apps/web/src/lib/encoding-metadata.ts";
import { inspectStatisticsPage } from "../../../apps/web/src/lib/encoding-statistics.ts";

test("statistics pagination and metadata agree with the checked Lean reference", (t) => {
	const fixtures = JSON.parse(
		execFileSync(
			"lean",
			["-DwarningAsError=true", "--run", "StatisticsProjection.lean"],
			{
				cwd: new URL(".", import.meta.url),
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
			},
		),
	);
	assert.ok(fixtures.pages.length > 0, "Lean must produce page fixtures");
	assert.ok(
		fixtures.metadata.length > 0,
		"Lean must produce metadata fixtures",
	);
	for (const [index, page] of fixtures.pages.entries()) {
		const { offset, total, received, providerOffset, pageable, expected } =
			page;
		const actual = inspectStatisticsPage(
			offset,
			total,
			received,
			providerOffset ?? undefined,
			pageable,
		);
		assert.deepEqual(
			actual,
			expected === null
				? undefined
				: {
						offset,
						totalCount: total,
						received,
						nextOffset: expected.nextOffset,
					},
			`Lean page case ${index}`,
		);
	}
	for (const [index, { value, keyCount }] of fixtures.metadata.entries()) {
		assert.deepEqual(
			projectEncodingMetadata(value),
			keyCount === null ? undefined : { keyCount },
			`Lean metadata case ${index}`,
		);
	}
	t.diagnostic(
		`${fixtures.pages.length} Lean page fixtures and ${fixtures.metadata.length} Lean metadata fixtures`,
	);
});

test("statistics pagination rejects invalid numeric representations", () => {
	const invalid = [
		-1,
		0.5,
		NaN,
		Infinity,
		-Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		"1",
	];
	for (const position of [0, 1, 2]) {
		for (const value of invalid) {
			const fields = [0, 10, 1];
			fields[position] = value;
			assert.equal(
				inspectStatisticsPage(...fields, undefined, true),
				undefined,
				`Rejected invalid number in field ${position}: ${String(value)}`,
			);
		}
	}
	assert.equal(inspectStatisticsPage(0, 10, 1, "0", true), undefined);
	assert.equal(inspectStatisticsPage(0, 10, 1, null, true), undefined);
});

test("metadata enumeration keeps the count and never reads values", () => {
	const metadata = Object.create(null, {
		token: {
			enumerable: true,
			get() {
				throw new Error("Metadata values must not be read");
			},
		},
		hidden: { value: "private" },
		[Symbol("not a JSON key")]: { enumerable: true, value: "private" },
	});
	assert.deepEqual(projectEncodingMetadata(metadata), { keyCount: 1 });
	assert.equal(
		projectEncodingMetadata(Object.create({ inherited: 1 })),
		undefined,
	);
	assert.equal(projectEncodingMetadata(new Date(0)), undefined);
});
