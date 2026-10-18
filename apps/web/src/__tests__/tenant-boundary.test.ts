import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = join(__dirname, "..");
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.tsx?$/.test(path) &&
			!/\.test\./.test(path) &&
			!path.includes("/__tests__/")
			? [path]
			: [];
	});
}
function importers(symbol: string): string[] {
	return sources(sourceRoot)
		.filter((path) => {
			const file = ts.createSourceFile(
				path,
				readFileSync(path, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			return file.statements.some(
				(statement) =>
					ts.isImportDeclaration(statement) &&
					statement.importClause?.namedBindings &&
					ts.isNamedImports(statement.importClause.namedBindings) &&
					statement.importClause.namedBindings.elements.some(
						(item) => (item.propertyName ?? item.name).text === symbol,
					),
			);
		})
		.map((path) => relative(sourceRoot, path))
		.sort();
}

describe("production tenant capability boundaries", () => {
	it("only the deployment-wide ingress reader can import the unscoped DB client", () => {
		expect(importers("getPrisma")).toEqual(["lib/auth/ingress-allowlist.ts"]);
		expect(importers("PrismaClient")).toEqual([]);
	});
	it("organization DB construction stays at authenticated context and token/audit boundaries", () => {
		expect(importers("getTenantPrisma")).toEqual([
			"app/api/access-events/route.ts",
			"app/api/api-tokens/[id]/route.ts",
			"app/api/api-tokens/route.ts",
			"lib/server/access-audit.ts",
			"lib/server/context.ts",
		]);
	});
	it("ordinary routes cannot construct a context from a caller-supplied organization", () => {
		expect(importers("contextForOrganization")).toEqual([
			"lib/server/webhook-receiver.ts",
		]);
	});
});
