import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 *  / review-210 I4: `skipDeliveryCommitment` is a POLICY opt-out
 * that lives in the IO-dependency bag, and three mutations of its callers
 * survived the entire suite — deleting it from re-run, and ADDING it to the
 * API route (which silently disables the whole rail at the main submit
 * boundary). Core's tests pin that the flag is honoured; nothing pinned who
 * passes it. This reads the call sites from SOURCE, which is the only
 * instrument that can see an opt-out being added where it does not belong.
 *
 * review-265 131-B2: it also claimed a population it could not reach. The
 * caller list was HARDCODED and its reader was rooted at `apps/web/src`, so
 * the worker's watch-folder sweep — a third of the real population, and the
 * one door that submits UNATTENDED every 30 seconds — was structurally
 * invisible. 's QC policy is a second opt-in on the same bag, and
 * that door was exactly where it went missing. The population is DERIVED from
 * the repository now, across both apps and packages, and the pinned list is
 * what makes a NEW door fail here instead of silently inheriting whatever
 * defaults core happens to have.
 */
const REPO_ROOT = join(__dirname, "../../../../..");

/** Every non-test file that calls submitEncodingJob, derived, repo-wide. */
function submitCallers(): string[] {
	const out = execFileSync(
		"git",
		["grep", "-l", "submitEncodingJob(", "--", "apps", "packages"],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	return (
		out
			.split("\n")
			.filter(Boolean)
			.filter((f) => !f.includes(".test.") && !f.includes("__tests__"))
			// The definition itself is not a caller.
			.filter((f) => !f.endsWith("packages/core/src/plan/submit.ts"))
			.sort()
	);
}

const source = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("who may skip the delivery commitment", () => {
	it("the caller population is exactly this list — a new submit door fails here first", () => {
		expect(submitCallers()).toEqual([
			"apps/web/src/app/api/encoding-jobs/route.ts",
			"apps/web/src/lib/server/rerun-job.ts",
			"apps/worker/src/index.ts",
		]);
	});

	it("re-run skips it — a persisted plan's commitment is not re-litigated", () => {
		expect(source("apps/web/src/lib/server/rerun-job.ts")).toContain(
			"skipDeliveryCommitment: true",
		);
	});

	it("the encoding-jobs route does NOT skip it", () => {
		expect(source("apps/web/src/app/api/encoding-jobs/route.ts")).not.toContain(
			"skipDeliveryCommitment",
		);
	});

	it("no OTHER submit path skips it", () => {
		const skipping = submitCallers().filter((f) =>
			source(f).includes("skipDeliveryCommitment"),
		);
		expect(skipping).toEqual(["apps/web/src/lib/server/rerun-job.ts"]);
	});
});

describe("who passes the QC/VMAF policy (ledger #131 / review-265 131-B2)", () => {
	it("EVERY submit door passes qcVmafEnabled — absent means no gate, which is how A2 happened", () => {
		// The policy is optional so the corpus runner and fixtures can submit
		// without an app-settings row behind them. That same optionality is
		// what let four doors silently bypass the refusal, so the guard is
		// here rather than in the type.
		// The PROPERTY form, not the bare identifier: the worker imports a
		// helper of the same name, so `includes("qcVmafEnabled")` was true
		// even with the policy deleted from the deps bag — the mutation
		// survived until this line asked whether it is PASSED, not mentioned.
		const missing = submitCallers().filter(
			(f) => !/qcVmafEnabled\s*:/.test(source(f)),
		);
		expect(missing).toEqual([]);
	});
});
