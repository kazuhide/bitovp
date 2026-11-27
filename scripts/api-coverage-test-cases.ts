import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const audit = JSON.parse(
	readFileSync(
		resolve(root, "apps/web/src/data/api-coverage/implementation-audit.json"),
		"utf8",
	),
) as {
	operations: Array<{
		sdkMethod: string;
		httpVerb: string;
		path: string;
		contractTest: { file: string; caseGroup?: string };
	}>;
};

/** Return the actual Vitest dataset after checking every reviewed operation has a case. */
export function auditedOperationCases<T>(
	testUrl: string,
	group: string,
	cases: readonly T[],
	requestTargets: (row: T) => readonly string[],
): readonly T[] {
	const file = relative(root, fileURLToPath(testUrl)).replaceAll("\\", "/");
	const claims = audit.operations.filter(
		({ contractTest }) => contractTest.file === file && contractTest.caseGroup === group,
	);
	if (!claims.length) throw new Error(`No audit claims for ${file} (${group})`);
	const selected = new Set(cases.flatMap(requestTargets));
	const missing = claims.filter(
		({ httpVerb, path }) => !selected.has(`${httpVerb} ${path}`),
	);
	if (missing.length) {
		throw new Error(`Audit case missing from ${file} (${group}): ${missing.map(({ sdkMethod }) => sdkMethod).join(", ")}`);
	}
	return cases;
}
