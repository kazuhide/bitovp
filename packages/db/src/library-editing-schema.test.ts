import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");
const migration = join(
	__dirname,
	"../prisma/migrations/20261101000000_library_editing/migration.sql",
);
const models = [
	"LibraryMediaVersion",
	"EditProject",
	"EditRevision",
	"RenderRun",
	"RenderArtifact",
	"ContentDerivation",
] as const;
const model = (name: string) =>
	schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ??
	"";
const sql = () => readFileSync(migration, "utf8");
const bindingMigration = join(
	__dirname,
	"../prisma/migrations/20261101030000_analysis_binding/migration.sql",
);

describe("Content Library editing persistence contracts", () => {
	it("stores immutable analysis bindings outside READY media and analysis evidence", () => {
		const binding = model("LibraryAnalysisBinding");
		expect(binding).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)/);
		expect(binding).toMatch(/proof\s+Json/);
		expect(binding).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/);
		expect(binding).not.toMatch(/updatedAt/);
		expect(binding).toContain("@@unique([organizationId, id])");
		expect(binding).toContain(
			"@@unique([organizationId, mediaVersionId, analysisRevisionId]",
		);
		for (const [field, parent] of [
			["mediaVersionId", "LibraryMediaVersion"],
			["analysisRevisionId", "SceneAnalysisRevision"],
		]) {
			expect(binding).toMatch(
				new RegExp(
					`${parent}\\s+@relation\\([^\\n]*fields: \\[organizationId, ${field}\\], references: \\[organizationId, id\\]`,
				),
			);
		}
	});
	it("adds forced tenant isolation and an unconditional UPDATE guard without unlocking existing evidence", () => {
		expect(existsSync(bindingMigration)).toBe(true);
		const bindingSql = readFileSync(bindingMigration, "utf8");
		expect(bindingSql).toContain(
			'ALTER TABLE "LibraryAnalysisBinding" ENABLE ROW LEVEL SECURITY',
		);
		expect(bindingSql).toContain(
			'ALTER TABLE "LibraryAnalysisBinding" FORCE ROW LEVEL SECURITY',
		);
		expect(bindingSql).toContain(
			'CREATE POLICY "organization_scope" ON "LibraryAnalysisBinding" USING',
		);
		expect(bindingSql).toContain(
			'CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LibraryAnalysisBinding"',
		);
		expect(bindingSql).toContain(
			'CREATE TRIGGER "analysis_binding_immutable" BEFORE UPDATE ON "LibraryAnalysisBinding"',
		);
		expect(bindingSql).toMatch(
			/CREATE FUNCTION bitovp_keep_analysis_binding\(\)[\s\S]*?BEGIN\s+RAISE EXCEPTION/,
		);
		expect(bindingSql).not.toMatch(
			/DISABLE TRIGGER|UPDATE "LibraryMediaVersion"|UPDATE "SceneAnalysisRevision"/,
		);
		expect(bindingSql).not.toMatch(/ON DELETE CASCADE|BEFORE DELETE/);
		for (const [field, parent] of [
			["mediaVersionId", "LibraryMediaVersion"],
			["analysisRevisionId", "SceneAnalysisRevision"],
		]) {
			expect(bindingSql).toContain(
				`FOREIGN KEY ("organizationId","${field}") REFERENCES "${parent}"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
			);
		}
	});
	it("keeps fixed media, edit revisions, executions and derivative heads separate", () => {
		for (const name of models) {
			expect(model(name), name).not.toBe("");
			expect(model(name), name).toMatch(/organizationId\s+String/);
			expect(model(name), name).toContain("@@unique([organizationId, id])");
		}
		expect(model("EditRevision")).toContain("@@unique([projectId, revision])");
		expect(model("RenderRun")).toContain(
			"@@unique([organizationId, projectId, requestKey])",
		);
		expect(model("ContentDerivation")).toContain(
			"@@unique([organizationId, projectId, variant])",
		);
	});

	it("makes VOD identity and a derived artifact mutually exclusive", () => {
		const source = model("LibrarySource");
		expect(source).toMatch(
			/sourceKind\s+LibrarySourceKind\s+@default\(VOD_JOB\)/,
		);
		for (const field of ["originalJobId", "encodingId", "accountId"])
			expect(source).toMatch(new RegExp(`${field}\\s+String\\?`));
		expect(source).toMatch(/renderArtifactId\s+String\?\s+@unique/);
		expect(existsSync(migration)).toBe(true);
		expect(sql()).toContain('CONSTRAINT "LibrarySource_kind_check" CHECK');
		expect(sql()).toMatch(
			/"sourceKind" = 'VOD_JOB'[\s\S]*?"renderArtifactId" IS NULL/,
		);
		expect(sql()).toMatch(
			/"sourceKind" = 'DERIVED_RENDER'[\s\S]*?"jobId" IS NULL[\s\S]*?"originalJobId" IS NULL/,
		);
	});

	it("protects every added table with forced RLS and immutable tenant ownership", () => {
		for (const name of models) {
			expect(sql()).toContain(
				`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`,
			);
			expect(sql()).toContain(`ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY`);
			expect(sql()).toContain(
				`CREATE POLICY "organization_scope" ON "${name}" USING`,
			);
			expect(sql()).toContain(
				`CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "${name}"`,
			);
		}
	});

	it("pins immutable evidence and prevents cross-project current revision bindings", () => {
		expect(model("LibraryMediaVersion")).toMatch(
			/outputCredentialId\s+String\s+@db\.Uuid/,
		);
		expect(model("LibraryMediaVersion")).toMatch(
			/outputCredential\s+Credential\s+@relation\([^\n]*fields: \[outputCredentialId\][^\n]*onDelete: Restrict/,
		);
		expect(model("RenderRun")).toMatch(
			/pendingArtifactToken\s+String\?\s+@db\.Uuid/,
		);
		expect(sql()).toContain('CREATE TRIGGER "edit_revision_immutable"');
		expect(sql()).toContain('CREATE TRIGGER "render_artifact_immutable"');
		expect(sql()).toContain('CREATE TRIGGER "ready_media_immutable"');
		expect(sql()).toContain(
			'CONSTRAINT "EditProject_current_revision_ownership"',
		);
		expect(sql()).toContain('CONSTRAINT "RenderRun_revision_ownership"');
		expect(sql()).toContain('CONSTRAINT "ContentDerivation_generation_check"');
		expect(sql()).toContain('"activeGeneration" <= "desiredGeneration"');
	});
});
