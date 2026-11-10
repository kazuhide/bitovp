/**
 * Ask Bitmovin what state an encoding is actually in. READ-ONLY.
 *
 * 's reset refuses to delete a row that names an encoding it cannot
 * prove stopped — the #48 rule, since the row is the only local record of a
 * resource that may still be billing. That refusal is correct and it is also
 * an unanswered question, and the answer is one API call away.
 *
 * So before an operator deletes those rows, this turns "we cannot prove it
 * stopped" into a measurement. Non-terminal states require keeping the row.
 * Failed, missing or unrecognized observations remain unverified; a 404 does
 * not prove the encoding is gone from another account. Even terminal states
 * require checking local references before deletion.
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
import { encodingProbeSummary } from "./probe-encoding-summary";

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
			// Preserve the lookup result, without treating absence in this
			// account as proof that the resource is globally gone.
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
	console.log(`\n${encodingProbeSummary(tally)}`);
} finally {
	await prisma.$disconnect();
}
