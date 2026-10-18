import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_SCHEDULE_OUTCOMES } from "./schemas";

/**
 * Audit 602ec286 §17 P1-4 — the READER agrees with the schema.
 *
 * `LIVE_SCHEDULE_OUTCOMES` is the UI's hand-maintained copy of the persisted
 * `LiveScheduleOutcome` enum; `schedule-panel`'s tone/message records are keyed
 * by it (exhaustive at compile time), and `program-timeline` reads the same
 * type. If a member is added to schema.prisma but not here, a fired row of that
 * outcome would render with no tone at all — so this set-equals the reader
 * against the schema's own text, the direction typecheck cannot see.
 */

const SCHEMA = join(
	__dirname,
	"../../../../../packages/db/prisma/schema.prisma",
);

function schemaEnumMembers(name: string): string[] {
	const src = readFileSync(SCHEMA, "utf8");
	const block = src.match(new RegExp(`enum ${name} \\{[\\s\\S]*?\\n\\}`));
	if (!block) {
		throw new Error(`enum ${name} not found in schema.prisma`);
	}
	return [...block[0].matchAll(/^\s{2}([A-Z_]+)$/gm)].map(
		(m) => m[1] as string,
	);
}

describe("LIVE_SCHEDULE_OUTCOMES parity with schema.prisma", () => {
	it("set-equals the persisted LiveScheduleOutcome enum", () => {
		const schema = [...schemaEnumMembers("LiveScheduleOutcome")].sort();
		const reader = [...LIVE_SCHEDULE_OUTCOMES].sort();
		expect(reader).toEqual(schema);
	});

	it("carries the three media-progression members the audit added", () => {
		for (const value of [
			"PROCESS_PUSHING",
			"INGEST_CONNECTED",
			"SLATE_ARMED",
		] as const) {
			expect(LIVE_SCHEDULE_OUTCOMES).toContain(value);
		}
	});
});
