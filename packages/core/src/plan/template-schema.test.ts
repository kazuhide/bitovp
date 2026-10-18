import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Every Template-YAML golden must validate against the official Bitmovin
 * template JSON schema — vendored copy of
 * https://raw.githubusercontent.com/bitmovin/bitmovin-api-sdk-examples/main/bitmovin-encoding-template.json
 * (fetched 2026-06-11; refresh deliberately, alongside SDK upgrades).
 *
 * Known exception: SFTP `port` is exported as a {{PLACEHOLDER}} string and
 * the schema wants an integer — substitution fixes it, and the YAML header
 * tells users so. Anything else failing the schema is a real bug.
 */
const KNOWN_PLACEHOLDER_PATHS = /^\/outputs\/sftp\/[^/]+\/properties\/port$/;

/*
 * TRUST LIMIT of this gate: the vendored schema contains ZERO
 * `additionalProperties: false`, so ajv accepts unknown/misplaced keys and
 * cannot express conditional field contracts (e.g. C18's "infrastructure
 * requires cloudRegion EXTERNAL"). A green run here proves the keys we emit
 * exist where we put them — NOT that the combination is valid. Semantic
 * constraints live in the validators (C-rules); don't over-trust this gate
 * in review.
 */
const dir = join(__dirname, "__fixtures__");

describe("template goldens vs the official JSON schema", () => {
	const schema = JSON.parse(
		readFileSync(join(dir, "bitmovin-encoding-template.schema.json"), "utf8"),
	) as Record<string, unknown>;
	const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
	const validateTemplate = ajv.compile(schema);

	const goldens = readdirSync(dir).filter((f) => f.endsWith(".template.yaml"));

	it("covers every template golden", () => {
		expect(goldens.length).toBeGreaterThan(0);
	});

	for (const file of goldens) {
		it(`validates ${file}`, () => {
			validateTemplate(parse(readFileSync(join(dir, file), "utf8")));
			const unexpected = (validateTemplate.errors ?? []).filter(
				(error) => !KNOWN_PLACEHOLDER_PATHS.test(error.instancePath),
			);
			expect(unexpected).toEqual([]);
		});
	}
});

/**
 * The official schema cannot see $/section/path references (they are plain
 * strings to it) — a template can validate while pointing at resources that
 * were never emitted (the PR #20 dolby-config bug class). Resolve every $/
 * ref against the document tree instead.
 */
describe("template goldens $/ reference integrity", () => {
	const goldens = readdirSync(dir).filter((f) => f.endsWith(".template.yaml"));

	function collectRefs(node: unknown, refs: string[]): void {
		if (typeof node === "string") {
			if (node.startsWith("$/")) {
				refs.push(node);
			}
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) {
				collectRefs(item, refs);
			}
			return;
		}
		if (node && typeof node === "object") {
			for (const value of Object.values(node)) {
				collectRefs(value, refs);
			}
		}
	}

	function resolves(tree: unknown, ref: string): boolean {
		let cursor: unknown = tree;
		for (const segment of ref.slice(2).split("/")) {
			if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
				return false;
			}
			cursor = (cursor as Record<string, unknown>)[segment];
		}
		return cursor !== undefined;
	}

	for (const file of goldens) {
		it(`resolves every $/ ref in ${file}`, () => {
			const tree = parse(readFileSync(join(dir, file), "utf8")) as unknown;
			const refs: string[] = [];
			collectRefs(tree, refs);
			const dangling = refs.filter((ref) => !resolves(tree, ref));
			expect(dangling).toEqual([]);
		});
	}
});
