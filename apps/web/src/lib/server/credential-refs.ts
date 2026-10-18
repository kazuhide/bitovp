import "server-only";
import { storageSummaries } from "@bitovp/core";
import type { getServerContext } from "./context";

/**
 * Display labels for the credentials a plan references — nothing else.
 *
 * The storage panel needs to say "AWS_AP_NORTHEAST_1" rather than
 * `1f0a…-9c2b`, and that is the entire purpose of this. It follows the same
 * narrowing discipline as `playback-links.ts`, for the same reason: a credential
 * row carries `config` (endpoints, regions, namespaces, base URLs) and the
 * encrypted secret, and a page that needs two strings must not receive either.
 * So `select` is `{ id, label, provider }` — never `config`, never
 * `encryptedSecret` (which the Prisma client omits globally anyway,
 * `packages/db/src/client.ts`) — and the query is scoped to the ids the plan
 * actually names rather than listing the table.
 *
 * Returns a plain map so an unknown id is simply absent: a credential deleted
 * after the job ran must render as "deleted credential", not blank and not a
 * throw. Best-effort by design — a failure here costs a label, and the panel
 * still shows every bucket and path.
 */
export type CredentialRef = { label: string; provider: string };

export async function credentialRefsForPlan(
	ctx: Awaited<ReturnType<typeof getServerContext>>,
	plan: unknown,
): Promise<Record<string, CredentialRef>> {
	let ids: string[] = [];
	try {
		const summaries = storageSummaries(
			plan as Parameters<typeof storageSummaries>[0],
		);
		ids = [
			...new Set(
				[...summaries.inputs, ...summaries.outputs]
					.map((endpoint) => endpoint.credentialId)
					.filter((id): id is string => typeof id === "string"),
			),
		];
	} catch {
		// An unparsable/legacy plan shape: no labels, still a page.
		return {};
	}
	if (ids.length === 0) {
		return {};
	}
	const rows = await ctx.prisma.credential.findMany({
		where: { id: { in: ids } },
		select: { id: true, label: true, provider: true },
	});
	// Null-prototype: the keys are ids from a plan, and a plan is operator input.
	const out: Record<string, CredentialRef> = Object.create(null);
	for (const row of rows) {
		out[row.id] = { label: row.label, provider: row.provider };
	}
	return out;
}
