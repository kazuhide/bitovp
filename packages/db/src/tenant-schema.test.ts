import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TENANT_MODEL_RELATIONS } from "./tenant-relations";

const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");
const migrations = join(__dirname, "../prisma/migrations");
const sql = readdirSync(migrations)
	.filter((name) => /^\d/.test(name))
	.sort()
	.map((name) => readFileSync(join(migrations, name, "migration.sql"), "utf8"))
	.join("\n");
const global = new Set([
	"User",
	"SetupCode",
	"Organization",
	"Membership",
	"PlatformSetting",
]);
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];

describe("schema-derived organization enforcement coverage", () => {
	it("pins all relation paths used to reject nested global identity writes", () => {
		const names = new Set(models.map((model) => model[1]));
		const relations: Record<string, Record<string, string>> = {};
		for (const model of models) {
			const name = model[1] ?? "";
			if (global.has(name)) continue;
			const fields: Record<string, string> = {};
			for (const line of (model[2] ?? "").split("\n")) {
				const field = line.match(/^\s*(\w+)\s+(\w+)(?:\[\]|\?)?\s*(?:@.*)?$/);
				if (!field || !names.has(field[2])) continue;
				const target = field[2] ?? "";
				fields[field[1] ?? ""] =
					target.charAt(0).toLowerCase() + target.slice(1);
			}
			relations[name.charAt(0).toLowerCase() + name.slice(1)] = fields;
		}
		expect(TENANT_MODEL_RELATIONS).toEqual(relations);
	});
	it("classifies every model and forces RLS, immutable ownership and no ambient default for every tenant table", () => {
		expect(models.length).toBe(50);
		const tenant = models.filter((model) => !global.has(model[1] ?? ""));
		expect(tenant.length).toBe(45);
		for (const model of tenant) {
			const name = model[1];
			expect(model[2], name).toMatch(
				/organizationId\s+String\s+@default\(dbgenerated/,
			);
			expect(sql, name).toContain(
				`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`,
			);
			expect(sql, name).toContain(
				`ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY`,
			);
			expect(sql, name).toContain(
				`CREATE POLICY "organization_scope" ON "${name}" USING`,
			);
			expect(sql, name).toContain(
				`CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "${name}"`,
			);
		}
	});

	it("adds a deferred same-org check for every declared tenant-to-tenant parent relation", () => {
		const tenantNames = new Set(
			models
				.filter((model) => !global.has(model[1] ?? ""))
				.map((model) => model[1]),
		);
		let references = 0;
		for (const model of models) {
			for (const relation of (model[2] ?? "").matchAll(
				/^\s+\w+\s+(\w+)\??\s+@relation\([^\n]*fields: \[(\w+)\], references: \[id\]/gm,
			)) {
				if (!tenantNames.has(relation[1])) continue;
				references++;
				expect(sql).toContain(
					`FOREIGN KEY ("organizationId","${relation[2]}") REFERENCES "${relation[1]}"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
				);
			}
		}
		expect(references).toBe(40);
	});
});
