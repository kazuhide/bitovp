import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("bounded MoQ history on the existing tenant-owned run", () => {
	it("adds an empty backward-compatible JSON document without changing RLS ownership", () => {
		const schema = readFileSync(
			join(__dirname, "../prisma/schema.prisma"),
			"utf8",
		);
		const run = schema.split("model LiveChannelRun {")[1]?.split("\n}")[0];
		expect(run).toMatch(/moqObservations\s+Json\s+@default/);
		const migration = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20261118013000_moq_observation_history/migration.sql",
			),
			"utf8",
		);
		expect(migration).toContain('ALTER TABLE "LiveChannelRun"');
		expect(migration).toContain('"moqObservations" JSONB NOT NULL');
		expect(migration).toContain('{"version":1,"sessions":[]}');
		expect(migration).toContain("<= 5");
		expect(migration).toContain("1048576");
		expect(migration).not.toMatch(/DISABLE ROW LEVEL SECURITY|DROP POLICY/);
	});
});
