import { describe, expect, it } from "vitest";
import type { VerificationReport } from "./engine";
import { browsable, formatReport } from "./job";

/**
 * `job.ts` had no tests at all (review catch), and it is the file that produced every
 * number quoted in the ledger. These cover the two decisions it makes that a reader of
 * the report depends on being honest: which locations it can even look at, and whether
 * the printed summary can hide something.
 */

const EMPTY: VerificationReport = {
	planName: "p",
	checks: [],
	counts: { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 },
	failed: 0,
};

function result(report: VerificationReport) {
	return {
		jobId: "j",
		jobName: "n",
		status: "FINISHED",
		report,
	} as never;
}

describe("browsable", () => {
	it("names an S3 bucket and a credential", () => {
		expect(
			browsable(
				{ kind: "S3", bucket: "b", credentialId: "c" } as never,
				"output",
			),
		).toEqual({ ok: true, bucket: "b", credentialId: "c" });
	});

	it("reads Azure's `container`, not `bucket`", () => {
		// The two halves of the discriminated union spell the same concept differently,
		// and conflating them would point the verifier at nothing.
		expect(
			browsable(
				{ kind: "AZURE", container: "ctr", credentialId: "c" } as never,
				"output",
			),
		).toEqual({ ok: true, bucket: "ctr", credentialId: "c" });
	});

	it("refuses SFTP with the reason named, rather than guessing a bucket", () => {
		// SFTP has neither field. Preflight now blocks these scenarios up front, so this
		// is the second line of defence: if one reaches here it must say why it cannot be
		// verified, not fail opaquely later.
		const out = browsable({ kind: "SFTP", host: "h" } as never, "output");
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.reason).toMatch(/SFTP/);
		expect(out.ok === false && out.reason).toMatch(/no browsable container/);
	});

	it("refuses an HTTPS input the same way", () => {
		const out = browsable({ kind: "HTTPS", url: "u" } as never, "input");
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.reason).toMatch(/^input is a HTTPS/);
	});
});

describe("formatReport", () => {
	it("prints every count, so a SKIP-only report cannot look like a pass", () => {
		const text = formatReport(
			result({
				...EMPTY,
				checks: [
					{ id: "drm:x:pssh", area: "drm", verdict: "SKIP", detail: "no init" },
				],
				counts: { PASS: 0, WARN: 0, FAIL: 0, SKIP: 1 },
			}),
		);
		expect(text).toContain("PASS 0");
		expect(text).toContain("SKIP 1");
	});

	it("lists a FAIL's detail verbatim — the detail IS the finding", () => {
		const text = formatReport(
			result({
				...EMPTY,
				checks: [
					{
						id: "muxing:v360:segment-count",
						area: "muxing",
						verdict: "FAIL",
						detail: "ceil(10.04s / 6s) = 2, so [2, 3] segments — found 100",
					},
				],
				counts: { PASS: 0, WARN: 0, FAIL: 1, SKIP: 0 },
				failed: 1,
			}),
		);
		expect(text).toContain("found 100");
		expect(text).toContain("muxing:v360:segment-count");
	});
});
