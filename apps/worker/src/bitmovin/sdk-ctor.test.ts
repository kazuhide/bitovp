import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * rev432: the worker runs under tsx, whose ESM↔CJS interop hands the SDK's
 * default import over as a module namespace — `new` on it throws
 * "BitmovinApi is not a constructor". vitest's bundler interop never shows
 * that, which is how the webhook registrar and the usage sweep shipped
 * broken on every attempt. Two guards: the shim resolves both shapes (and
 * refuses a third loudly), and no worker module constructs the SDK from a
 * bare default import — every construction goes through `sdk-ctor.ts`.
 */
describe("BitmovinApi constructor resolution (rev432)", () => {
	afterEach(() => {
		vi.doUnmock("@bitmovin/api-sdk");
		vi.resetModules();
	});

	it("resolves the class when the default import IS the class (bundler interop)", async () => {
		class Fake {}
		vi.doMock("@bitmovin/api-sdk", () => ({ default: Fake }));
		const mod = await import("./sdk-ctor");
		expect(mod.BitmovinApi).toBe(Fake);
	});

	it("resolves the class when the default import is the CJS namespace (tsx interop)", async () => {
		class Fake {}
		vi.doMock("@bitmovin/api-sdk", () => ({ default: { default: Fake } }));
		const mod = await import("./sdk-ctor");
		expect(mod.BitmovinApi).toBe(Fake);
	});

	it("refuses a shape that is neither, loudly, at module load", async () => {
		vi.doMock("@bitmovin/api-sdk", () => ({ default: { named: 1 } }));
		await expect(import("./sdk-ctor")).rejects.toThrow(
			/did not resolve to a constructor/,
		);
	});
});

/**
 * Every import form that yields the CJS namespace under tsx and then fails
 * at `new`: the bare default, a default mixed with named imports, a
 * namespace import, `default as`, and a dynamic import/require. Type-only
 * and named-class imports are fine (named classes are constructible).
 */
export const CONSTRUCTING_SDK_IMPORT_FORMS: readonly RegExp[] = [
	/^import\s+(?!type\b)\w+\s*(,\s*\{[^}]*\})?\s*from\s+"@bitmovin\/api-sdk"/m,
	/^import\s+\*\s+as\s+\w+\s+from\s+"@bitmovin\/api-sdk"/m,
	/\bdefault\s+as\s+\w+[^}]*\}\s*from\s+"@bitmovin\/api-sdk"/,
	/\b(import|require)\(\s*"@bitmovin\/api-sdk"\s*\)/,
];

function constructsTheSdk(source: string): boolean {
	return CONSTRUCTING_SDK_IMPORT_FORMS.some((re) => re.test(source));
}

describe("no worker module constructs the SDK outside sdk-ctor.ts (rev432)", () => {
	function walk(dir: string, out: string[]): string[] {
		for (const name of readdirSync(dir)) {
			if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
				continue;
			}
			const p = join(dir, name);
			if (statSync(p).isDirectory()) {
				walk(p, out);
			} else if (
				p.endsWith(".ts") &&
				!p.endsWith(".test.ts") &&
				!p.endsWith(".d.ts")
			) {
				out.push(p);
			}
		}
		return out;
	}

	it("flags every constructing form and none of the harmless ones", () => {
		const violating = [
			'import BitmovinApi from "@bitmovin/api-sdk";',
			'import BitmovinApi, { S3Input } from "@bitmovin/api-sdk";',
			'import * as sdk from "@bitmovin/api-sdk";',
			'import { default as BitmovinApi } from "@bitmovin/api-sdk";',
			'const sdk = await import("@bitmovin/api-sdk");',
			'const sdk = require("@bitmovin/api-sdk");',
		];
		const harmless = [
			'import type BitmovinApiImport from "@bitmovin/api-sdk";',
			'import { S3Input } from "@bitmovin/api-sdk";',
			'import type { S3Input } from "@bitmovin/api-sdk";',
			'import {\n\tAclEntry,\n\tS3Input,\n} from "@bitmovin/api-sdk";',
			'// import BitmovinApi from "@bitmovin/api-sdk"; (a comment)',
		];
		for (const source of violating) {
			expect(constructsTheSdk(source), source).toBe(true);
		}
		for (const source of harmless) {
			expect(constructsTheSdk(source), source).toBe(false);
		}
	});

	it("only sdk-ctor.ts constructs the SDK across apps/worker src and scripts", () => {
		// apps/worker: src/ (this file's grandparent) and scripts/ beside it —
		// the per-title capture script runs under tsx too and once carried the
		// same bare default import (rev432 R1).
		const worker = join(__dirname, "..", "..");
		const offenders = walk(worker, [])
			.filter((p) => constructsTheSdk(readFileSync(p, "utf8")))
			.map((p) => relative(worker, p))
			.filter((p) => p !== join("src", "bitmovin", "sdk-ctor.ts"));
		expect(offenders).toEqual([]);
	});
});
