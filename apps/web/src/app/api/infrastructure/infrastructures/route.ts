import { NextResponse } from "next/server";
import { z } from "zod";
import { bitmovinClientForAccount } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError, validationError } from "@/lib/server/http";

/**
 * GET /api/infrastructure/infrastructures — the CANDIDATE list behind the
 * wizard's infrastructureId picker .
 *
 * Aggregates the first C6 page of every Cloud Connect infrastructure family
 * (aws / azure / gce / akamai / oci) with a `kind` tag. One page per family is
 * DELIBERATE, not lazy: `ResourceIdPicker` treats every candidate list as
 * incomplete by construction and keeps paste-an-id as the primary input, so
 * the aggregate exists to save typing in the common case, never to enumerate
 * an account exhaustively (#30's bound philosophy).
 *
 * A family that errors (no Cloud Connect entitlement → 403/404) is SKIPPED,
 * not fatal — most accounts have at most one family provisioned, and failing
 * the whole picker because the account lacks OCI would be the tail wagging
 * the dog. Families that failed are named in `skipped` so the UI can say so
 * instead of implying an empty account.
 *
 * SANITIZED to id/name/kind only. The family models carry cloud-account
 * linkage and internals this app must never proxy to the browser — the
 * allow-list here is the C20-style rail: a new SDK field cannot leak by
 * default.
 */

const querySchema = z.strictObject({
	// Required — matching listQuerySchema's contract: every infra proxy call
	// names its account explicitly.
	bitmovinAccountId: z.uuid(),
});

type InfrastructureCandidate = {
	id: string;
	name: string | null;
	kind: "AWS" | "AZURE" | "GCE" | "AKAMAI" | "OCI";
};

export async function GET(req: Request) {
	const url = new URL(req.url);
	const query = querySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	try {
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(
			ctx,
			query.data.bitmovinAccountId,
		);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		const infra = api.encoding.infrastructure;
		const families = [
			["AWS", () => infra.aws.list({ limit: 100, offset: 0 })],
			["AZURE", () => infra.azure.list({ limit: 100, offset: 0 })],
			["GCE", () => infra.gce.list({ limit: 100, offset: 0 })],
			["AKAMAI", () => infra.akamai.list({ limit: 100, offset: 0 })],
			["OCI", () => infra.oci.list({ limit: 100, offset: 0 })],
		] as const;
		const items: InfrastructureCandidate[] = [];
		const skipped: string[] = [];
		await Promise.all(
			families.map(async ([kind, list]) => {
				try {
					const page = await list();
					for (const item of page.items ?? []) {
						if (typeof item.id === "string" && item.id.length > 0) {
							items.push({
								id: item.id,
								name:
									typeof (item as { name?: unknown }).name === "string"
										? (item as { name: string }).name
										: null,
								kind,
							});
						}
					}
				} catch {
					// Entitlement-shaped failures are expected per family; the
					// details stay server-side (C20) — the UI needs only the name.
					skipped.push(kind);
				}
			}),
		);
		return NextResponse.json({ items, skipped });
	} catch (err) {
		// routeError, NOT bitmovinProxyError: every SDK error is already caught
		// per-family above, so anything landing here is OURS (master key,
		// decrypt, context) — the sibling taxonomy (review of PR #176, I1: the
		// first cut mislabelled a local key failure as a Bitmovin fault and
		// dropped the 503).
		return routeError(err);
	}
}
