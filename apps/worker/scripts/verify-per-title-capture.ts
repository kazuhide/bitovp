/**
 * END-TO-END verification of the per-title RESULT capture, against the real
 * Bitmovin API — the one thing STATUS row 70 says has never been done.
 *
 * WHY THIS CAN BE RUN SAFELY, TODAY: the capture is **read-only**. It lists
 * streams and muxings and gets codec configs. So it does not need a fresh
 * encoding — it can be pointed at per-title encodings the account ALREADY has,
 * costs nothing, starts nothing, and changes nothing, here or upstream. That is
 * strictly better than starting a new encode to learn the same thing.
 *
 * WHAT IT SETTLES. Three claims the fixtures cannot reach:
 *
 *  1. `listEncodingStreams` / `listAllMuxings` / `getCodecConfigDetail` work
 *     against the live API, not just the stub (C25's caution: the pinned SDK is
 *     not the API).
 *  2. **Do `PER_TITLE_RESULT` streams inherit their template's `name`?** That is
 *     the premise of attribution rule 1, and it is unanswerable offline. If they
 *     do, attribution works on multi-template ladders; if they do not, it
 *     abstains — which is safe, but then the rule is dead code and should be
 *     recorded as such.
 *  3. Whether a real result stream carries `appliedSettings` and whether its
 *     muxings carry `segmentsMuxed` — the columns that say what the ladder cost.
 *
 * Run:
 *   pnpm --filter @bitovp/worker exec tsx scripts/verify-per-title-capture.ts [encodingId...]
 *
 * With no arguments it scans the account's recent encodings for ones with
 * per-title streams and reports on every one it finds. The API key is resolved
 * through the product's own credential store, so no plaintext key is handled.
 */
import {
	capturePerTitleResults,
	cipherFromEnv,
	isPerTitleResultMode,
	isPerTitleTemplateMode,
} from "@bitovp/core";
import { createBitmovinAccountStore, createPrismaClient } from "@bitovp/db";
import { BitmovinApi } from "../src/bitmovin/sdk-ctor";
import { createBitmovinSdkOps } from "../src/orchestrator/sdk-ops";

const explicitIds = process.argv.slice(2).filter((x) => x.length > 8);
/** How many recent encodings to scan when no ids are given. */
const SCAN_LIMIT = 60;

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
		{ apiKey, tenantOrgId: account.tenantOrgId, bitmovinAccountId: account.id },
		// No audit rows: this is a read-only diagnostic, and a failed audit write
		// must not mask the finding.
		async () => {},
	);
	/**
	 * A RAW client, for the one question the capture port deliberately cannot
	 * answer any more: do result streams carry a `name`?
	 *
	 * `ScannedStream` used to carry `name` for attribution rule 1. This script is
	 * what proved that rule dead (17/17 encodings: results have no name), the field
	 * went with it — and the probe stays, reading the wire directly, so that if
	 * Bitmovin ever starts naming results we find out instead of assuming.
	 */
	const raw = new BitmovinApi({
		apiKey,
		...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
	});
	const rawStreamNames = async (encodingId: string) => {
		const page = await raw.encoding.encodings.streams.list(encodingId, {
			offset: 0,
			limit: 100,
		});
		return (page.items ?? []).map((stream) => ({
			streamId: stream.id ?? "?",
			mode: String(stream.mode ?? "?"),
			name: stream.name,
		}));
	};

	console.log(`account: ${account.label} (${account.id})`);

	/** Candidate encoding ids: the given ones, else what our own rows recorded. */
	let candidates: Array<{ id: string; source: string }> = explicitIds.map(
		(id) => ({ id, source: "argv" }),
	);
	if (candidates.length === 0) {
		const jobs = await prisma.encodingJob.findMany({
			where: { bitmovinEncodingId: { not: null } },
			select: { id: true, name: true, bitmovinEncodingId: true, status: true },
			orderBy: { createdAt: "desc" },
			take: SCAN_LIMIT,
		});
		candidates = jobs
			.filter((j) => j.bitmovinEncodingId !== null)
			.map((j) => ({
				id: j.bitmovinEncodingId as string,
				source: `job ${j.name} (${j.status})`,
			}));
		console.log(
			`scanning ${candidates.length} encodings from our own job rows (no ids given)`,
		);
	}

	let perTitleFound = 0;
	const nameInheritance: Array<{ encodingId: string; verdict: string }> = [];

	for (const candidate of candidates) {
		let page: Awaited<ReturnType<typeof sdk.listEncodingStreams>>;
		try {
			page = await sdk.listEncodingStreams(candidate.id);
		} catch (err) {
			// A purged encoding (~90 days, C7) is the expected failure here, and it is
			// evidence about the API, not a script error.
			console.log(
				`  ${candidate.id}: unreadable — ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}
		const templates = page.items.filter((s) => isPerTitleTemplateMode(s.mode));
		const results = page.items.filter((s) => isPerTitleResultMode(s.mode));
		if (templates.length === 0 && results.length === 0) {
			continue;
		}
		perTitleFound += 1;
		console.log(
			`\n=== ${candidate.id} (${candidate.source}) — ${templates.length} template(s), ${results.length} result(s), complete=${page.complete}`,
		);
		const rawRows = await rawStreamNames(candidate.id);
		const nameOf = new Map(rawRows.map((r) => [r.streamId, r.name]));
		for (const template of templates) {
			console.log(
				`   TEMPLATE ${template.streamId} mode=${template.mode} name=${JSON.stringify(nameOf.get(template.streamId))}`,
			);
		}

		// THE question: does a result carry a name, and is it a template's name?
		const templateNames = new Set(
			templates
				.map((t) => nameOf.get(t.streamId))
				.filter((n): n is string => n !== undefined),
		);
		const resultNames = results.map((r) => nameOf.get(r.streamId));
		const named = resultNames.filter((n) => n !== undefined).length;
		const matching = resultNames.filter(
			(n) => n !== undefined && templateNames.has(n),
		).length;
		const verdict =
			results.length === 0
				? "no results to judge (templates only — did the encode finish?)"
				: named === 0
					? "results carry NO name ⇒ attribution rule 1 can never fire"
					: matching === results.length
						? `all ${results.length} result names match a template name ⇒ rule 1 works`
						: `${matching}/${results.length} result names match a template name`;
		console.log(`   NAME INHERITANCE: ${verdict}`);
		nameInheritance.push({ encodingId: candidate.id, verdict });

		// And the capture itself, exactly as the executor runs it. `templates` is
		// left empty on purpose: this checks the CAPTURE, not the attribution — the
		// attribution question is answered by the name analysis above, from the
		// same data, without having to reconstruct the plan.
		const snapshot = await capturePerTitleResults(
			{
				listStreams: (id) => sdk.listEncodingStreams(id),
				listMuxings: (id) => sdk.listAllMuxings(id),
				getCodecConfig: (id) => sdk.getCodecConfigDetail(id),
			},
			{
				encodingId: candidate.id,
				capturedAt: new Date().toISOString(),
				templates: [],
			},
		);
		console.log(`   scan: ${JSON.stringify(snapshot.scan)}`);
		for (const row of snapshot.streams) {
			const applied = row.appliedSettings
				? `${row.appliedSettings.width ?? "?"}x${row.appliedSettings.height ?? "?"}`
				: "ABSENT";
			const paramCount = Object.keys(row.params).length;
			console.log(
				`   RESULT ${row.streamId} codec=${row.codecType ?? "?"} applied=${applied} params=${paramCount} muxings=${row.muxings.length}`,
			);
			for (const muxing of row.muxings) {
				console.log(
					`      ${muxing.muxingType} ${muxing.muxingId} avg=${muxing.avgBitrate ?? "-"} max=${muxing.maxBitrate ?? "-"} segments=${muxing.segmentsMuxed ?? "ABSENT"} outputs=${JSON.stringify(muxing.outputs.map((o) => o.outputPath ?? null))}`,
				);
			}
			// The params are the point of the polymorphic read: an empty object here
			// means the endpoint table missed, and the row would look plausible.
			if (paramCount === 0) {
				console.log(
					`      !! params EMPTY — the codec-config read produced nothing for ${row.codecType ?? "unknown type"}`,
				);
			}
		}
	}

	console.log(
		`\n${perTitleFound} encoding(s) with per-title streams out of ${candidates.length} scanned`,
	);
	for (const row of nameInheritance) {
		console.log(`  ${row.encodingId}: ${row.verdict}`);
	}
	if (perTitleFound === 0) {
		// Say so loudly: a clean run over zero per-title encodings verifies nothing,
		// and that is exactly the shape of a green instrument with no population.
		console.log(
			"\nNOTHING WAS VERIFIED: no scanned encoding had per-title streams. Pass ids explicitly, or run a per-title encode first.",
		);
		process.exitCode = 2;
	}
} finally {
	await prisma.$disconnect();
}
