/**
 * Ask Bitmovin what state an encoding is actually in. READ-ONLY.
 *
 * 's reset refuses to delete a row that names an encoding it cannot
 * prove stopped — the #48 rule, since the row is the only local record of a
 * resource that may still be billing. That refusal is correct and it is also
 * an unanswered question, and the answer is one API call away.
 *
 * So before an operator deletes those rows, this turns "we cannot prove it
 * stopped" into a measurement: RUNNING/QUEUED means do NOT delete, a terminal
 * state or a 404 (Bitmovin purges after ~90 days) means the row is safe to
 * remove.
 *
 * Reads through the product's own account store, so the plaintext API key is
 * never handled here. Touches no row and stops nothing — `stop-orphan-live.ts`
 * is the tool that acts.
 *
 * Run: pnpm --filter @bitovp/worker exec tsx scripts/probe-encoding-status.ts <encodingId>...
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cipherFromEnv } from "@bitovp/core";
import { createBitmovinAccountStore, createPrismaClient } from "@bitovp/db";
import { createBitmovinSdkOps } from "../src/orchestrator/sdk-ops";

const envFile = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) {
	process.loadEnvFile(envFile);
}

const ids = process.argv.slice(2).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
if (ids.length === 0) {
	console.error("usage: probe-encoding-status.ts <encodingId>...");
	process.exit(2);
}

const prisma = createPrismaClient(process.env.DATABASE_URL);
try {
	const accounts = createBitmovinAccountStore(prisma, cipherFromEnv());
	const account = await prisma.bitmovinAccount.findFirst({
		select: { id: true, label: true, tenantOrgId: true },
		orderBy: { createdAt: "asc" },
	});
	if (!account) {
		throw new Error("no Bitmovin account is registered");
	}
	const apiKey = await accounts.revealApiKey(account.id);
	const sdk = createBitmovinSdkOps(
		{
			apiKey,
			tenantOrgId: account.tenantOrgId,
			bitmovinAccountId: account.id,
		},
		async () => {},
	);

	const tally = new Map<string, number>();
	for (const id of ids) {
		let state: string;
		try {
			state = String((await sdk.getEncodingStatus(id)).status);
		} catch (err) {
			// A purged or never-existent encoding answers 404. Reported as its
			// own bucket rather than folded into "terminal": "gone" and
			// "finished" are different facts even though both are safe.
			const message = err instanceof Error ? err.message : String(err);
			state = /404|not found/i.test(message) ? "GONE (404)" : `PROBE FAILED`;
			if (state === "PROBE FAILED") {
				console.error(`  ${id}: ${message}`);
			}
		}
		tally.set(state, (tally.get(state) ?? 0) + 1);
		console.log(`${state.padEnd(14)} ${id}`);
	}
	console.log("\n--- tally ---");
	for (const [state, n] of [...tally].sort()) {
		console.log(`${String(n).padStart(4)}  ${state}`);
	}
	const live = [...tally].filter(([s]) => /RUNNING|QUEUED|STARTING/i.test(s));
	console.log(
		live.length > 0
			? `\nSTOP FIRST: ${live.map(([s, n]) => `${n} ${s}`).join(", ")}`
			: "\nNothing is live at Bitmovin — these rows are safe to delete.",
	);
} finally {
	await prisma.$disconnect();
}
