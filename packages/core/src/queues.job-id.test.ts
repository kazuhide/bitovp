import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { feederJobId } from "./queues";

/**
 * No BullMQ custom job id may contain a colon.
 *
 * BullMQ 5 throws `Custom Id cannot contain :` (`job.js:1049`) — the character is its own key
 * separator in Redis. Four of our ids did, and the consequence was that **every feeder stop,
 * every live-channel action and every live-to-VOD request returned HTTP 500**: an ffmpeg push
 * nobody could stop through the product, and a live channel nobody could start.
 *
 * No unit test could have caught it, and that is the point of scanning the SOURCE here rather
 * than a behaviour: the queue is mocked everywhere, and a mock accepts any id — so the exact
 * id BullMQ refuses is the one every test was happy with. Found by the first real live channel.
 *
 * A grep, deliberately: the constraint is on a literal we write, so the literal is what to
 * check, and this catches the next one at author time rather than at 02:00 against a real
 * Redis.
 */
describe("BullMQ custom job ids", () => {
	const root = join(import.meta.dirname, "..", "..", "..");

	it("contain no colon anywhere in the tree", () => {
		/**
		 * `git grep` exits 1 on no matches, which `execFileSync` turns into a throw — so a
		 * CLEAN tree threw and the test reported a failure with no offenders in it. My first
		 * version did exactly that: a guard that fails when there is nothing to report is
		 * indistinguishable from one that found something, which is the worst possible shape
		 * for a guard.
		 */
		let out = "";
		try {
			out = execFileSync(
				"git",
				[
					"grep",
					"-n",
					"-E",
					// Built by concatenation, not a template literal: a backtick inside
					// `String.raw` has to be escaped, and the escape ended up in the PATTERN —
					// so the regex never matched and the guard passed over a planted offender.
					// My own grep instrument, vacuous. Third time this class has bitten.
					`jobId[:=][ ]*${"`"}[^${"`"}]*:`,
					"--",
					"*.ts",
				],
				{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			).trim();
		} catch (err) {
			// Exit 1 = no matches, which is the outcome we want. Anything else is a broken
			// instrument and must not read as a pass.
			const status = (err as { status?: number }).status;
			if (status !== 1) {
				throw err;
			}
		}
		const offenders = out
			.split("\n")
			.filter((l) => l.length > 0 && !/\.test\.ts:/.test(l))
			// `${x}` interpolation is fine; a literal `:` outside it is not.
			.filter((l) => {
				const lit = /`([^`]*)`/.exec(l)?.[1] ?? "";
				return lit.replace(/\$\{[^}]*\}/g, "").includes(":");
			});
		expect(
			offenders,
			"BullMQ 5 rejects these at runtime with `Custom Id cannot contain :` — HTTP 500 on the route",
		).toEqual([]);
	});

	it("finds a real population, so a broken grep cannot report clean", () => {
		const out = execFileSync(
			"git",
			["grep", "-c", "-E", "jobId", "--", "*.ts"],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		expect(out.split("\n").length).toBeGreaterThan(3);
	});

	it("feederJobId separates the stop action without a colon", () => {
		const id = feederJobId({
			feederSessionId: "11111111-1111-4111-8111-111111111111",
			action: "stop",
		} as never);
		expect(id).not.toContain(":");
		expect(id).toBe("11111111-1111-4111-8111-111111111111-stop");
	});

	it("feederJobId leaves a start action as the bare session id", () => {
		// Idempotency depends on it: BullMQ treats an existing id as already-enqueued.
		expect(
			feederJobId({
				feederSessionId: "22222222-2222-4222-8222-222222222222",
				action: "start",
			} as never),
		).toBe("22222222-2222-4222-8222-222222222222");
	});

	it("the constraint is real, quoted from the installed BullMQ", () => {
		// Pinned against the dependency rather than trusted from memory: if a future BullMQ
		// relaxes this, the reason for the dashes should be re-checked and not just inherited.
		const jobSrc = readFileSync(
			join(
				root,
				"node_modules/.pnpm/bullmq@5.78.0/node_modules/bullmq/dist/cjs/classes/job.js",
			),
			"utf8",
		);
		expect(jobSrc).toContain("Custom Id cannot contain :");
	});
});
