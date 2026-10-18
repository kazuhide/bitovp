import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRuns, parseCleanDays, runCleanCommand } from "./runner";

/**
 * Roots created by this file, removed after each test.
 *
 * Every arm here mkdtemps a run root and the file never removed them, so a
 * repeated run dripped `verify-clean-*` directories into $TMPDIR (~30 during
 * one review session). Not a regression — it is the file's original style —
 * but the spawn arms made it worse and it is two lines to stop.
 */
const roots: string[] = [];
function tempRoot(prefix = "verify-clean-"): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * `verify clean` — DOC-015.
 *
 * The documented invocation was `verify clean --older-than <d>`; the CLI read
 * the day count POSITIONALLY, so `Number("--older-than")` produced NaN, `cutoff`
 * became NaN, and `info.mtimeMs >= cutoff` was FALSE for every directory. The
 * keep-guard inverted into a delete-guard: an operator asking to prune runs
 * older than seven days pruned EVERY local run — including the one from a minute
 * ago — and got exit 0 with a plausible count.
 *
 * These artefacts are the forensic record of PAID encodes, so the loss is not
 * recoverable by re-running anything for free.
 */

function runDir(
	root: string,
	name: string,
	ageDays: number,
	retentionUntil?: string,
): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "report.json"),
		JSON.stringify(retentionUntil ? { evidence: { retentionUntil } } : {}),
	);
	writeFileSync(join(dir, "report.md"), "report");
	writeFileSync(join(dir, "report.seal"), "sha256:abc");
	writeFileSync(join(dir, "fixed.plan.json"), "{}");
	writeFileSync(join(dir, "fixed.report.json"), "{}");
	writeFileSync(join(dir, "artefact.mp4"), "x");
	const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
	utimesSync(dir, when, when);
	return dir;
}

describe("parseCleanDays", () => {
	it("accepts the DOCUMENTED flag form, which used to parse to NaN", () => {
		expect(parseCleanDays(["--older-than", "7"])).toEqual({
			ok: true,
			days: 7,
		});
		expect(parseCleanDays(["--older-than=7"])).toEqual({ ok: true, days: 7 });
	});

	it("still accepts the bare positional form the nightly job uses", () => {
		// Both spellings are real usage — the doc promises one, the launchd job
		// and muscle memory use the other. Breaking either to fix the other would
		// just move the outage.
		expect(parseCleanDays(["7"])).toEqual({ ok: true, days: 7 });
		expect(parseCleanDays([])).toEqual({ ok: true, days: 7 });
	});

	it("REFUSES what it cannot parse instead of coercing it", () => {
		// `Number` turning a typo into NaN is exactly how this shipped.
		for (const argv of [["--older-than"], ["banana"], ["-3"], [""]]) {
			expect(parseCleanDays(argv).ok, JSON.stringify(argv)).toBe(false);
		}
	});

	it("REFUSES every string Number() would quietly turn into 0", () => {
		/**
		 * The first cut of this fix refused NaN and negatives and called itself
		 * "parsed, not coerced". It was neither: `Number(" ")` is 0, which is
		 * finite and not negative, so a stray space in RETENTION_DAYS pruned the
		 * whole tree and exited 0 — the exact accident the rail's own comment
		 * said was impossible (found in review of this fix).
		 *
		 * Enumerated as STRINGS rather than as a rule, because the rule is what
		 * was wrong the first time.
		 */
		for (const raw of [
			" ",
			"  ",
			"\t",
			"\n",
			"-0",
			"0x10",
			".5",
			"+7",
			"7.5",
		]) {
			expect(parseCleanDays([raw]).ok, JSON.stringify(raw)).toBe(false);
			expect(
				parseCleanDays(["--older-than", raw]).ok,
				`--older-than ${JSON.stringify(raw)}`,
			).toBe(false);
		}
	});

	it("REFUSES 0 — there is no purge spelling, on purpose", () => {
		expect(parseCleanDays(["0"]).ok).toBe(false);
		expect(parseCleanDays(["--older-than", "0"]).ok).toBe(false);
		const refusal = parseCleanDays(["0"]);
		expect(refusal.ok ? "" : refusal.reason).toContain("every local run");
	});

	it("still accepts a number the shell padded with spaces", () => {
		// Trimmed, not coerced: `" 7 "` is a real 7 from a shell, while `" "` is
		// not a number at all. Refusing both would break a plausible caller to
		// fix the other one — the mistake this whole row exists to avoid.
		expect(parseCleanDays([" 7 "])).toEqual({ ok: true, days: 7 });
	});
});

describe("cleanRuns", () => {
	it("prunes an OLD run's artefacts and keeps its reports", async () => {
		const root = tempRoot();
		const old = runDir(root, "run-old", 30);
		const removed = await cleanRuns(root, 7);
		expect(removed.length).toBeGreaterThan(0);
		expect(existsSync(join(old, "report.json"))).toBe(true);
		expect(existsSync(join(old, "artefact.mp4"))).toBe(false);
		expect(existsSync(join(old, "report.seal"))).toBe(true);
		expect(existsSync(join(old, "fixed.plan.json"))).toBe(true);
		expect(existsSync(join(old, "fixed.report.json"))).toBe(true);
	});

	it("removes resumable scenario evidence only after its retention expires", async () => {
		const root = tempRoot();
		const expired = runDir(root, "run-expired", 100);
		await cleanRuns(root, 7);
		expect(existsSync(join(expired, "report.json"))).toBe(true);
		expect(existsSync(join(expired, "report.md"))).toBe(true);
		expect(existsSync(join(expired, "report.seal"))).toBe(false);
		expect(existsSync(join(expired, "fixed.plan.json"))).toBe(false);
		expect(existsSync(join(expired, "fixed.report.json"))).toBe(false);
	});

	it("honours the signed report's explicit retention timestamp", async () => {
		const root = tempRoot();
		const retained = runDir(
			root,
			"run-declared-retention",
			365,
			new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
		);
		await cleanRuns(root, 7);
		expect(existsSync(join(retained, "report.seal"))).toBe(true);
		expect(existsSync(join(retained, "fixed.plan.json"))).toBe(true);
	});

	it("preserves in-flight report publication files during signed retention", async () => {
		const root = tempRoot();
		const retained = runDir(root, "run-publishing", 30);
		for (const name of [
			"report.json.pending.0123456789abcdef01234567",
			"report.md.pending.0123456789abcdef01234567",
			"report.seal.pending.0123456789abcdef01234567",
		]) {
			writeFileSync(join(retained, name), "staged");
		}
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		utimesSync(retained, old, old);
		await cleanRuns(root, 7);
		expect(
			existsSync(
				join(retained, "report.json.pending.0123456789abcdef01234567"),
			),
		).toBe(true);
		expect(
			existsSync(join(retained, "report.md.pending.0123456789abcdef01234567")),
		).toBe(true);
		expect(
			existsSync(
				join(retained, "report.seal.pending.0123456789abcdef01234567"),
			),
		).toBe(true);
	});

	it("does not let an edited report shorten the configured retention floor", async () => {
		const root = tempRoot();
		const retained = runDir(
			root,
			"run-edited-deadline",
			30,
			"2000-01-01T00:00:00.000Z",
		);
		await cleanRuns(root, 7);
		expect(existsSync(join(retained, "report.seal"))).toBe(true);
		expect(existsSync(join(retained, "fixed.report.json"))).toBe(true);
	});

	it("leaves a RECENT run entirely alone", async () => {
		const root = tempRoot();
		const fresh = runDir(root, "run-fresh", 0);
		await cleanRuns(root, 7);
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
	});

	it("REFUSES a non-finite bound rather than matching every run", async () => {
		/**
		 * The defect, at the place that does the deleting. NaN is what the
		 * documented flag produced, and a NaN cutoff makes the keep-guard false
		 * for everything — so this must throw rather than return a count.
		 *
		 * The rail lives here as well as in the parser because no caller should be
		 * able to express "delete everything" by accident: a script, a future
		 * flag, or a bad env would otherwise reach the same inverted guard.
		 */
		const root = tempRoot();
		const fresh = runDir(root, "run-fresh", 0);
		await expect(cleanRuns(root, Number.NaN)).rejects.toThrow(/age bound/);
		// And nothing was removed on the way to throwing.
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
	});

	it("REFUSES a negative bound — a future cutoff matches everything too", async () => {
		const root = tempRoot();
		const fresh = runDir(root, "run-fresh", 0);
		await expect(cleanRuns(root, -1)).rejects.toThrow(/age bound/);
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
	});

	it("REFUSES a bound of 0 — the value every coercion lands on", async () => {
		// The rail's half of the review finding. 0 is finite and not negative,
		// so the first cut let it through and it deletes everything.
		const root = tempRoot();
		const fresh = runDir(root, "run-fresh", 0);
		await expect(cleanRuns(root, 0)).rejects.toThrow(/age bound/);
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
	});

	it("REFUSES a bad bound even when the root does not exist", async () => {
		// The rail used to sit AFTER the readdir early-return, so a bad bound
		// over a missing root returned [] — silence where a refusal belongs.
		await expect(
			cleanRuns(join(tmpdir(), "verify-clean-does-not-exist"), 0),
		).rejects.toThrow(/age bound/);
	});
});

/**
 * The WIRING, which the first cut of this fix left pinned by nothing: a
 * reviewer reverted `verify.ts` to the pre-fix positional `Number(rest[0] ?? 7)`
 * and the whole worker suite stayed green. `parseCleanDays` was unit-tested
 * hard; the single line that called it was covered by no test at all.
 */
describe("runCleanCommand — the command, not the rule", () => {
	it("refuses the documented flag's bad values with exit 2 and deletes nothing", async () => {
		const root = tempRoot();
		const fresh = runDir(root, "run-fresh", 0);
		for (const argv of [["--older-than", " "], ["0"], ["banana"]]) {
			const { code, message } = await runCleanCommand(argv, {
				VERIFY_RUN_ROOT: root,
			});
			expect(code, JSON.stringify(argv)).toBe(2);
			expect(message).toMatch(/verify clean:/);
		}
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
	});

	it("prunes with the DOCUMENTED spelling — the form that used to delete everything", async () => {
		const root = tempRoot();
		const fresh = runDir(root, "run-fresh", 0);
		const old = runDir(root, "run-old", 30);
		const { code, message } = await runCleanCommand(["--older-than", "7"], {
			VERIFY_RUN_ROOT: root,
		});
		expect(code).toBe(0);
		expect(message).toContain("older than 7 day(s)");
		// The outcome, both directions: the old one went, the fresh one stayed.
		expect(existsSync(join(old, "artefact.mp4"))).toBe(false);
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
	});

	it("prunes with the bare positional form the nightly job uses", async () => {
		const root = tempRoot();
		const old = runDir(root, "run-old", 30);
		const { code } = await runCleanCommand(["7"], { VERIFY_RUN_ROOT: root });
		expect(code).toBe(0);
		expect(existsSync(join(old, "artefact.mp4"))).toBe(false);
	});

	it("defaults to 7 days with no argument at all", async () => {
		const root = tempRoot();
		const fresh = runDir(root, "run-fresh", 0);
		const { code, message } = await runCleanCommand([], {
			VERIFY_RUN_ROOT: root,
		});
		expect(code).toBe(0);
		expect(message).toContain("older than 7 day(s)");
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
	});
});

/**
 * The CLI itself, across the process boundary.
 *
 * Everything above pins `runCleanCommand`. NOTHING pinned `scripts/verify.ts`,
 * and the extraction did not change that — review re-ran the call-site revert
 * (back to positional `Number(rest[0] ?? 7)`) on the refactored tree and the
 * whole worker suite still passed. `grep -rn "scripts/verify" --include='*.test.ts'`
 * returned zero across the repo: no test imported or spawned it, so no test
 * COULD observe it. Extracting the decision moved the boundary; it did not close
 * the gap.
 *
 * A spawn is the only instrument that crosses that boundary, so this is the one
 * test that fails if the wiring is reverted. It is slower than the rest of the
 * file on purpose — the alternative is the gap.
 */
describe("scripts/verify.ts clean — the wiring, across a process boundary", () => {
	const CLI = join(__dirname, "../../scripts/verify.ts");
	const TSX = join(__dirname, "../../node_modules/.bin/tsx");

	function runCli(
		args: string[],
		root: string,
	): Promise<{ code: number; out: string }> {
		return new Promise((resolve) => {
			execFile(
				TSX,
				[CLI, "clean", ...args],
				{ env: { ...process.env, VERIFY_RUN_ROOT: root } },
				(err, stdout, stderr) => {
					const code =
						err && typeof (err as { code?: unknown }).code === "number"
							? ((err as { code: number }).code ?? 1)
							: err
								? 1
								: 0;
					resolve({ code, out: `${stdout}${stderr}` });
				},
			);
		});
	}

	it("prunes with the DOCUMENTED flag — the invocation that used to delete everything", async () => {
		const root = tempRoot("verify-clean-cli-");
		const fresh = runDir(root, "run-fresh", 0);
		const old = runDir(root, "run-old", 30);
		const { code, out } = await runCli(["--older-than", "7"], root);
		expect(out).toContain("older than 7 day(s)");
		expect(code).toBe(0);
		expect(existsSync(join(old, "artefact.mp4"))).toBe(false);
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
	}, 30_000);

	it("exits 2 and deletes NOTHING for a value Number() would read as 0", async () => {
		const root = tempRoot("verify-clean-cli-");
		const fresh = runDir(root, "run-fresh", 0);
		const old = runDir(root, "run-old", 30);
		const { code, out } = await runCli(["--older-than", " "], root);
		expect(code).toBe(2);
		expect(out).toContain("verify clean:");
		// BOTH survive: a refusal must not be a partial prune.
		expect(existsSync(join(fresh, "artefact.mp4"))).toBe(true);
		expect(existsSync(join(old, "artefact.mp4"))).toBe(true);
	}, 30_000);
});
