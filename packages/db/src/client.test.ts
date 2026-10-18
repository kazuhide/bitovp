import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIPHERTEXT_OMIT } from "./client";

/**
 * Every encrypted column is omitted from raw reads — derived from the SCHEMA,
 * not from a list someone maintains.
 *
 * This exists because the mechanism was unpinned while looking thoroughly
 * tested. `bitmovin-accounts.test.ts` and `credentials.test.ts` assert
 * `not.toHaveProperty("encryptedApiKey")` on eight rows between them, which
 * reads like coverage — but they run against `fakeTable(["encryptedApiKey"])`,
 * a fake that strips the column itself. Measured 2026-08-21: deleting the
 * `omit` from `createPrismaClient` left the ENTIRE suite green, 6,458 tests. A
 * mock that reproduces the behaviour under test proves the mock.
 *
 * It matters because `bitmovinAccounts.list` is `findMany` with no `select`,
 * handed to `NextResponse.json` by `GET /api/bitmovin-accounts` — the omit is
 * the only thing between an AES-256-GCM ciphertext and every browser session.
 * (Verified against the running app the same day: the response carries six
 * keys and none of them is the ciphertext.)
 *
 * The DERIVED direction is the valuable one. A new encrypted column is the
 * realistic future mistake — nobody forgets to keep an existing line, people
 * forget to add one — and only a check that reads the schema can see that.
 */

const SCHEMA = join(__dirname, "../prisma/schema.prisma");

/** model name → encrypted column names, straight out of schema.prisma. */
function encryptedColumnsByModel(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	let model: string | null = null;
	for (const line of readFileSync(SCHEMA, "utf8").split("\n")) {
		const declaration = /^model (\w+)/.exec(line);
		if (declaration?.[1]) {
			model = declaration[1];
			continue;
		}
		const column = /^\s+(encrypted\w+)\s/.exec(line);
		if (column?.[1] && model) {
			found.set(model, [...(found.get(model) ?? []), column[1]]);
		}
	}
	return found;
}

/** Prisma's client keys are the model name with a lowercase first letter. */
const delegateKey = (model: string) =>
	model.charAt(0).toLowerCase() + model.slice(1);

describe("ciphertext never rides a raw read", () => {
	it("finds the encrypted columns it claims to check", () => {
		// The population guard. If the schema regex stopped matching, every
		// assertion below would loop zero times and report the tree clean —
		// which is precisely the failure this file was written about.
		const byModel = encryptedColumnsByModel();
		expect(
			[...byModel.values()].flat().length,
			"no encrypted columns found — the schema parse broke",
		).toBeGreaterThanOrEqual(2);
	});

	it("omits every encrypted column the schema declares", () => {
		const missing: string[] = [];
		for (const [model, columns] of encryptedColumnsByModel()) {
			const entry = (CIPHERTEXT_OMIT as Record<string, Record<string, true>>)[
				delegateKey(model)
			];
			for (const column of columns) {
				if (entry?.[column] !== true) {
					missing.push(`${delegateKey(model)}.${column}`);
				}
			}
		}
		expect(
			missing,
			"an encrypted column that raw Prisma reads would carry — add it to CIPHERTEXT_OMIT in client.ts",
		).toEqual([]);
	});

	it("omits nothing that is not an encrypted column", () => {
		// The other direction: an over-broad omit silently breaks the reveal
		// paths (a store asking for a column that is globally omitted gets
		// undefined), and that failure surfaces as a decryption error far from
		// here.
		const declared = new Map(
			[...encryptedColumnsByModel()].map(([model, columns]) => [
				delegateKey(model),
				new Set(columns),
			]),
		);
		const extra: string[] = [];
		for (const [model, columns] of Object.entries(
			CIPHERTEXT_OMIT as Record<string, Record<string, true>>,
		)) {
			for (const column of Object.keys(columns)) {
				if (!declared.get(model)?.has(column)) {
					extra.push(`${model}.${column}`);
				}
			}
		}
		expect(extra, "omitted a column the schema does not declare").toEqual([]);
	});
});

/**
 * The bundler compiles this module — and the generated Prisma runtime inside it
 * — once per Next server layer, so one process holds several copies of the
 * sentinel classes. Prisma compares a sentinel by identity, and a foreign copy
 * degrades a filter SILENTLY (no throw, no log — the value falls through to the
 * plain-object branch and serializes as `{}`): on the 2026-08-29 billed
 * re-audit that made a live-to-VOD `updateMany` match zero rows against a
 * column that really was SQL NULL.
 *
 * The duplication is simulated with a mock, not with two real evaluations, and
 * that is forced: across `vi.resetModules` the generated RUNTIME
 * (`runtime/library.js`, and with it `objectEnumValues` — the sentinels) rides
 * node's own require cache, so a bare second import hands back the SAME
 * `DbNull`; only `index.js`'s `getPrismaClient(config)` call re-runs and yields
 * a fresh client class (measured, review-354 — an earlier version of this block
 * claimed the whole module was reused and its premise arm failed). A bare
 * reimport therefore cannot produce a second sentinel copy; `vi.doMock`,
 * re-registered per load, replaces the module wholesale. What is mocked is only
 * the duplication itself; every assertion is about what `client.ts` does with
 * it.
 */
describe("one Prisma module instance per process", () => {
	/** Every generated-client copy handed to a `client.ts` evaluation. */
	let copies: {
		Prisma: { DbNull: object };
		PrismaClient: new (options: unknown) => object;
	}[] = [];

	/**
	 * One evaluation of `client.ts` against its OWN copy of the generated
	 * client. The `doMock` has to be re-registered per load: `resetModules`
	 * alone leaves vitest's mock result cached, so a single registration is
	 * evaluated once however many times the module is re-imported (measured —
	 * the premise arm caught it).
	 */
	async function loadClient() {
		vi.resetModules();
		vi.doMock("../generated/client", () => {
			const copy = {
				Prisma: { DbNull: { sentinel: copies.length } },
				PrismaClient: class {
					constructor(public options: unknown) {}
				},
			};
			copies.push(copy);
			return copy;
		});
		return await import("./client");
	}

	beforeEach(() => {
		copies = [];
		// `??` treats undefined as absent, so clearing is enough to make each
		// arm start from an unclaimed stash.
		const g = globalThis as unknown as {
			prisma?: unknown;
			prismaModule?: unknown;
		};
		g.prismaModule = undefined;
		g.prisma = undefined;
	});

	afterEach(() => {
		vi.doUnmock("../generated/client");
		vi.resetModules();
	});

	/**
	 * The premise, asserted rather than assumed: two evaluations really do get
	 * two different copies. Without this the sharing arms below could pass for
	 * the boring reason — one copy reused — and would keep passing after the
	 * fix was deleted.
	 */
	it("two evaluations really are handed DIFFERENT copies", async () => {
		await loadClient();
		await loadClient();

		expect(copies).toHaveLength(2);
		expect(copies[1]?.Prisma.DbNull).not.toBe(copies[0]?.Prisma.DbNull);
		expect(copies[1]?.PrismaClient).not.toBe(copies[0]?.PrismaClient);
	});

	it("a second copy of client.ts exports the FIRST copy's DB_NULL", async () => {
		const first = await loadClient();
		const second = await loadClient();

		// Two module instances, as two server-layer chunks would be.
		expect(second).not.toBe(first);
		expect(second.DB_NULL).toBe(first.DB_NULL);
		// …and the one they share is the FIRST copy's, not the second's.
		expect(second.DB_NULL).toBe(copies[0]?.Prisma.DbNull);
		expect(second.DB_NULL).not.toBe(copies[1]?.Prisma.DbNull);
	});

	it("a second copy of client.ts builds clients from the FIRST copy's class", async () => {
		const url = "postgresql://u:p@localhost:5432/db";
		const first = await loadClient();
		first.createPrismaClient(url);
		const second = await loadClient();
		const fromSecond = second.createPrismaClient(url);

		// The class a client was built from is what decides whether it
		// recognises a sentinel — so it has to be the same class the shared
		// DB_NULL came from.
		expect(fromSecond).toBeInstanceOf(copies[0]?.PrismaClient);
		expect(fromSecond).not.toBeInstanceOf(copies[1]?.PrismaClient);
	});
});

/**
 * The invariant the stash rests on: `client.ts` is the only module that touches
 * the generated client as a VALUE. A second value-importer could hand a route
 * its own `Prisma.DbNull` — the original defect, re-introduced past the fix —
 * and nothing else in the tree would notice.
 */
describe("the generated client has exactly one runtime importer", () => {
	const SRC = __dirname;

	function sourceFiles(): string[] {
		return readdirSync(SRC, { recursive: true, encoding: "utf8" })
			.filter((f) => f.endsWith(".ts"))
			.sort();
	}

	/**
	 * Whole STATEMENTS, not lines: `credentials.ts` spreads its `import type`
	 * over five lines, so a line-wise reading would have to guess about the
	 * `} from "…"` tail — and guessing type-only there is exactly the shape a
	 * multi-line VALUE import would take. `[^;]` keeps the lazy span from
	 * running back into the preceding statement and reading ITS keyword.
	 */
	function generatedClientImports(body: string): { typeOnly: boolean }[] {
		const statements =
			/(?:^|[\n;])[\t ]*(?:import|export)\b([^;]*?)from "\.\.\/generated\/client"/g;
		return [...body.matchAll(statements)].map((match) => ({
			typeOnly: /^\s*type\b/.test(match[1] ?? ""),
		}));
	}

	it("finds the importers it claims to check", () => {
		// Population guard: a regex that stopped matching would report the tree
		// clean. Several modules import the generated client for its TYPES.
		const referencing = sourceFiles().filter(
			(f) =>
				generatedClientImports(readFileSync(join(SRC, f), "utf8")).length > 0,
		);
		expect(
			referencing.length,
			"no importers found — the import scan broke",
		).toBeGreaterThanOrEqual(2);
	});

	it("only client.ts imports it as a value", () => {
		const valueImporters = sourceFiles().filter((f) =>
			generatedClientImports(readFileSync(join(SRC, f), "utf8")).some(
				(i) => !i.typeOnly,
			),
		);
		expect(valueImporters).toEqual(["client.ts"]);
	});
});
