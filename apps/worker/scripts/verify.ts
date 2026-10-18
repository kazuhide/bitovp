/**
 * `verify` CLI. One entry point so the nightly job and a human type the same thing.
 *
 *   pnpm --filter @bitovp/worker verify job <jobId> [--strict-prefix]
 *
 * Runs inside the worker image, which has ffprobe. Exit code = FAIL count, so a
 * caller can gate on it.
 */
import { createPrismaClient } from "@bitovp/db";
import { main as verifyJobMain } from "../src/verify/job";
import { formatPreflight, preflight } from "../src/verify/preflight";
import {
	runCleanCommand,
	runRecoveryCommand,
	main as verifyRunMain,
} from "../src/verify/runner";
import {
	formatSmoke,
	smokeConfigFromEnv,
	verifySmoke,
} from "../src/verify/smoke";

const [command, ...rest] = process.argv.slice(2);

if (command === "job") {
	process.exit(await verifyJobMain(rest));
}

if (command === "preflight") {
	const prisma = createPrismaClient(process.env.DATABASE_URL);
	try {
		const report = await preflight({
			prisma,
			log: (line) => console.log(`[preflight] ${line}`),
		});
		console.log("");
		console.log(formatPreflight(report));
		// Preflight never fails the build: reporting an unsatisfied capability IS its
		// job. Only an unparseable fixture is an error, because that is our bug.
		process.exit(report.counts.invalid);
	} finally {
		await prisma.$disconnect();
	}
}

if (command === "smoke") {
	/**
	 * Cross the seam before anything costs money.
	 *
	 * Deliberately first in the docs and cheap to run: the harness spent its whole
	 * development unable to reach the product, and a corpus run's answer to that is 41
	 * INVALIDs — honest, but an hour of encoder time to learn that one variable was unset.
	 *
	 * A thin adapter, like `clean` below: the decision — where this credential may go,
	 * and the SAME storage values the corpus will use, not a second copy — lives in
	 * `smokeConfigFromEnv`, where a test can reach it. This branch used to build the
	 * config itself, which is how the origin allowlist ended up applying to `verify run`
	 * and not to the command the nightly runs FIRST (review of this PR); it also had its
	 * own storage spelling once, and reported a missing object the runner never asks for.
	 */
	const resolved = smokeConfigFromEnv(process.env);
	if (!resolved.ok) {
		console.error(`[smoke] refusing to start: ${resolved.reason}`);
		process.exit(2);
	}
	const prisma = createPrismaClient(process.env.DATABASE_URL);
	try {
		const result = await verifySmoke({
			prisma,
			...resolved.config,
			log: (line) => console.log(`[smoke] ${line}`),
		});
		console.log("");
		console.log(formatSmoke(result));
		process.exit(result.ok ? 0 : 1);
	} finally {
		await prisma.$disconnect();
	}
}

if (command === "run") {
	process.exit(await verifyRunMain(rest));
}

if (command === "recover") {
	const { code, message } = await runRecoveryCommand(rest, process.env);
	(code === 0 ? console.log : console.error)(message);
	process.exit(code);
}

if (command === "clean") {
	// A two-line adapter on purpose. The decision — parse, refuse, prune, report
	// — lives in `runCleanCommand`, where a test can reach it: this branch's
	// previous version WAS the whole fix's wiring and nothing pinned it, so a
	// clean revert of it left the suite green (review of this fix).
	const { code, message } = await runCleanCommand(rest, process.env);
	(code === 0 ? console.log : console.error)(message);
	process.exit(code);
}

console.error(
	`unknown verify command: ${command ?? "(none)"}\n\n` +
		"  verify preflight\n" +
		"  verify job <jobId|prefix> [--strict-prefix]\n" +
		"  verify smoke                     — can this harness reach the product at all?\n" +
		"  verify run [--dry-run] [--only a,b] [--concurrency N] [--run-id X]\n" +
		"             [--max-submits N]  cost cap: at most N scenarios actually submit\n" +
		"             [--inject-post-create-response-loss]  one-shot audit canary; requires exactly one --only, --max-submits 1, non-dry\n" +
		"             [--resume-from report.json]  honor a prior run's PASSes\n" +
		"             [--release]  require HMAC-sealed, DB-joined release evidence\n" +
		"             [--evidence-retention-days N]  retain resumable evidence (default 90)\n" +
		"             [--live-feed-seconds N] [--live-start-timeout N]\n" +
		"             [--live-encoder-version STABLE|BETA|x.y.z]  explicit capability canary\n" +
		"             [--live-public-read]  make live output PUBLIC_READ so a\n" +
		"               browser can play it\n" +
		"               live is OPT-IN: each live scenario costs encoder minutes, so\n" +
		"               without --live-feed-seconds the 7 live fixtures report a named\n" +
		"               SKIP. 45 clears the engine's 10s sample-gap floor comfortably.\n" +
		"  verify recover --run-id X          reconcile ONLY an existing run's paid-resource intents\n" +
		"  verify clean [--older-than <d>]   (default 7; a bare number also works)",
);
process.exit(2);
