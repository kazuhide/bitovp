import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "../../../..");

/**
 * WHERE a live channel can be claimed into PROVISIONING — a closed set.
 *
 * This guard answers one question and says plainly what it does not answer.
 *
 * It ANSWERS: has a NEW file started claiming channels into PROVISIONING (by
 * either `update` or `updateMany`, on a tracked file)? Such
 * a file has a lease to decide about , and the release is easy to
 * forget — the lease's first cut released it in one door of three, leaving the
 * scheduler's two arms to claim a channel and enqueue a provision job that then
 * refused the still-live lease and returned successfully. Silently missed
 * airings, for an unattended scheduler.
 *
 * It does NOT answer whether each individual claim releases the lease. A first
 * version tried, deriving FILES and then searching the whole file, so
 * `sweep.ts`'s two claims were satisfied by one spread anywhere in it — review
 * deleted one arm's release and every suite stayed green. Slicing per claim
 * does not work either: the scheduler builds its claim as a separate object and
 * passes it to `updateMany`, so there is no literal at the call site to slice.
 *
 * That question is answered BEHAVIOURALLY instead, one arm at a time:
 *   - `live-channels/[id]/actions/route.test.ts` — the web start action
 *   - `scheduler/sweep.test.ts` — both scheduler arms, asserted on the CHANNEL
 *     after a sweep rather than on payload text
 *   - `live/provision-lease.test.ts` — the abandoned lease exit, now committed through provision-outcome.ts: the
 *     abandoned-lease sweep matches `status: "PROVISIONING"` in a WHERE, never
 *     writes it, and moves the row OUT (→ ERROR, lease released, run retired)
 *     by an exact-token compare-and-swap; its arms assert the flip, the
 *     release, the retirement, and that a renewed token is left alone.
 *   - `live/owned-transition-locking.integration.test.ts` — a final RESTART
 *     queue failure moves its own run out of PROVISIONING when its lease is
 *     null. With a provision token it preserves the channel and run and emits nothing.
 * A new file appearing here is a signal to add such an arm for it.
 */
describe("channel provisioning admission and exit paths", () => {
	it("contains only the known admission and exit files", () => {
		// `apps` and `packages` — every tracked TypeScript path today, checked,
		// but the pathspec is those two rather than the repo, so a third
		// top-level source directory would need adding here.
		//
		// And `git ls-files` reads the INDEX: a brand-new door that has never
		// been `git add`ed is invisible. Narrow under this repo's
		// stage-before-gating rule, but worth stating for a guard whose whole
		// value is being a tripwire.
		const files = execFileSync("git", ["ls-files", "apps", "packages"], {
			cwd: REPO,
			encoding: "utf8",
		})
			.split("\n")
			.filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
			.filter((f) => {
				const t = readFileSync(join(REPO, f), "utf8");
				// `update(` as well as `updateMany(`. Review planted a fourth
				// door claiming via the non-atomic `liveChannel.update(` and
				// this guard passed — so "claims into PROVISIONING" meant
				// "…via updateMany" without saying so. Broadening costs
				// nothing: the matched set is the same three files either way
				// (measured), so there are no false positives to absorb.
				return (
					/liveChannel\.update(Many)?\(/.test(t) &&
					/status:\s*"PROVISIONING"/.test(t)
				);
			})
			.sort();
		expect(
			files,
			"a file started claiming channels into PROVISIONING — it has a provisioning lease to decide about, and it needs its own behavioural arm (see this file's docstring)",
		).toEqual([
			"apps/web/src/app/api/live-channels/[id]/actions/route.ts",
			// Both exit paths match through their PROVISIONING predicates.
			"apps/worker/src/live/dead-job-outcome.ts",
			"apps/worker/src/live/provision-outcome.ts",
			"apps/worker/src/orchestrator/live-processor.ts",
			"apps/worker/src/scheduler/sweep.ts",
		]);
	});
});
