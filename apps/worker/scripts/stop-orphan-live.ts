/**
 * Stop live encodings that are RUNNING at Bitmovin but that no `LiveChannel` row points at.
 *
 * Four of them were found billing for up to 7h19m after every one of our channel rows said
 * STOPPED. The ids Bitmovin had running were NOT the ids we stored:
 *
 *   Bitmovin RUNNING                              our LiveChannel.bitmovinEncodingId
 *   f0c0e872… live-rtmp-simple                    63c65f0d…
 *   d0a889e7… live-redundant-rtmp                 6a907cf7…
 *   bc80e6b6… live-redundant-rtmp                 82c2463a…
 *   b2fd8d48… live-srt-listener                   88a4f46b…
 *
 * So each channel run left TWO encodings behind and we stopped the one we had recorded. Our own
 * teardown reported success and was telling the truth about the wrong resource — the failure mode
 * this whole verification round keeps finding, except this one costs money per minute.
 *
 * Deliberately id-driven and read-only about our database: it does not touch `LiveChannel` rows,
 * because those already say STOPPED and the encodings it stops are not the ones they name. It
 * reports what it did.
 *
 * Run:  pnpm --filter @bitovp/worker exec tsx scripts/stop-orphan-live.ts <encodingId>...
 * With no arguments it LISTS what it would stop and changes nothing.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cipherFromEnv, orphanLiveEncodings } from "@bitovp/core";
import { createBitmovinAccountStore, createPrismaClient } from "@bitovp/db";
import { createBitmovinSdkOps } from "../src/orchestrator/sdk-ops";

// Same repo-root `.env` the worker itself pulls in (`src/index.ts`): a plain
// Node process does not load one, and without this the tool reached for
// `DATABASE_URL`, `cipherFromEnv` and the account store with nothing set.
// This is the INCIDENT script — the one an operator runs while encodings are
// billing — so "export five variables first, correctly, under time pressure"
// is exactly the wrong prerequisite, and it is why the non-empty-page check
// this row wants had not been run from a developer machine .
const envFile = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) {
	process.loadEnvFile(envFile);
}

const ids = process.argv.slice(2).filter((x) => /^[0-9a-f-]{36}$/i.test(x));

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
	// Through the product's own store, so the plaintext key is never handled here.
	const apiKey = await accounts.revealApiKey(account.id);
	const sdk = createBitmovinSdkOps(
		{
			apiKey,
			tenantOrgId: account.tenantOrgId,
			bitmovinAccountId: account.id,
		},
		// No audit row: this is maintenance, and a failed audit write must not mask a stop.
		async () => {},
	);

	/**
	 * id → owning channel's STATUS. The status is what decides whether a row naming
	 * an encoding means anything: from STOPPED, nothing will ever stop it.
	 */
	const known = new Map(
		(
			await prisma.liveChannel.findMany({
				select: { bitmovinEncodingId: true, status: true },
			})
		).flatMap((r) =>
			typeof r.bitmovinEncodingId === "string"
				? ([[r.bitmovinEncodingId, String(r.status)]] as Array<
						[string, string]
					>)
				: [],
		),
	);

	// DISCOVERY. Previously this script could only check ids a human already had, so
	// it could not find an orphan nobody had noticed — which is how four of them
	// billed for up to 7h19m. Now it asks Bitmovin what is actually running and
	// reports what our rows cannot explain. It still stops ONLY what was passed on
	// the command line: a sweep that stopped what the database cannot account for
	// could stop the owner's own work.
	const stepLogIds = new Map<string, string>();
	for (const channel of await prisma.liveChannel.findMany({
		select: { stepLog: true, status: true },
	})) {
		for (const entry of Array.isArray(channel.stepLog) ? channel.stepLog : []) {
			const step = entry as { kind?: unknown; resourceId?: unknown };
			if (
				String(step.kind ?? "").includes("ENCODING") &&
				typeof step.resourceId === "string"
			) {
				stepLogIds.set(step.resourceId, String(channel.status));
			}
		}
	}
	// Discovery must never gate the STOP path: an operator with ids from the
	// dashboard needs them stopped even if the listing 4xxs (review catch — this
	// sat before the stop loop with no guard, so a failed list meant nothing was
	// stopped).
	let report: Awaited<ReturnType<typeof orphanLiveEncodings>> | null = null;
	try {
		report = orphanLiveEncodings(
			await sdk.listRunningLiveEncodings(),
			{ fromColumn: known, fromStepLog: stepLogIds },
			new Date(),
		);
	} catch (err) {
		console.log(
			`DISCOVERY FAILED — could not list live encodings: ${err instanceof Error ? err.message : String(err)}\n` +
				"Any ids passed on the command line are still stopped below.",
		);
	}
	if (report) {
		// The arithmetic has to close: `byColumn + byStepLog` double-counts an id both
		// sources name, so printing those two alone left an operator computing a total
		// that did not match (review catch).
		console.log(
			`Bitmovin reports ${report.running} non-terminal LIVE encoding(s): ` +
				`${report.accountedFor.total} explained ` +
				`(${report.accountedFor.byColumn} by column, ${report.accountedFor.byStepLog} by step log), ` +
				`${report.inFlight.length} still provisioning, ` +
				`${report.contradicted.length} contradicted, ${report.orphans.length} unexplained.`,
		);
		// In-flight rows are NORMAL. Listed quietly so the count above is explainable,
		// never with the #48 sentence — that line has to stay rare to stay read.
		for (const pending of report.inFlight) {
			console.log(
				`  provisioning ${pending.id} ${pending.status} — its channel row is ${pending.channelStatus}; this is a normal bring-up.`,
			);
		}
		for (const bad of report.contradicted) {
			console.log(
				`  CONTRADICTED ${bad.id} ${bad.status} — a channel row names it, but that row is ${bad.channelStatus}, ` +
					"so nothing in this app will ever stop it. This is the ledger #48 shape.",
			);
		}
	}
	for (const orphan of report?.orphans ?? []) {
		const age =
			orphan.ageMinutes === undefined
				? "age unknown"
				: `${Math.floor(orphan.ageMinutes / 60)}h${String(orphan.ageMinutes % 60).padStart(2, "0")}m old`;
		console.log(
			`  ORPHAN ${orphan.id} ${orphan.status} ${age}${orphan.name ? ` — ${orphan.name}` : ""}`,
		);
	}
	// Contradicted encodings belong in the call to action: they are ours, provably
	// unreachable, and this script CAN stop them if given the id — the CONTRADICTED
	// line says nothing in the app will stop it, which was true of the app and not of
	// this tool (review catch).
	const unstopped = [
		...(report?.orphans ?? []),
		...(report?.contradicted ?? []),
	].filter((o) => !ids.includes(o.id));
	if (unstopped.length > 0) {
		console.log(
			`\n${unstopped.length} encoding(s) are BILLING and unreachable, and nothing here stopped them.\n` +
				"Re-run with their ids to stop them, after checking they are not work you started outside this app.",
		);
	}
	if (
		ids.length === 0 &&
		report &&
		report.orphans.length === 0 &&
		report.contradicted.length === 0
	) {
		console.log("nothing unaccounted for, and no ids given — nothing to stop.");
	}

	for (const id of ids) {
		const orphan = !known.has(id);
		let before = "unknown";
		try {
			before = String((await sdk.getEncodingStatus(id)).status);
		} catch (err) {
			console.log(
				`  SKIP ${id}: could not read its status — ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}
		if (["FINISHED", "ERROR", "CANCELED", "TRANSFER_ERROR"].includes(before)) {
			console.log(`  already terminal ${id}: ${before} — nothing to stop`);
			continue;
		}
		try {
			await sdk.stopLiveEncoding(id);
			// Read it BACK. A stop that returns without throwing is not a stopped encoding, and
			// "our teardown said success" is exactly how these four survived seven hours.
			const after = String((await sdk.getEncodingStatus(id)).status);
			console.log(
				`  STOPPED ${id} (${orphan ? "ORPHAN — no LiveChannel row names it" : "known to us"}): ${before} → ${after}`,
			);
		} catch (err) {
			console.log(
				`  FAILED ${id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
} finally {
	await prisma.$disconnect();
}
