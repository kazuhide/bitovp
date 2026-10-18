import "server-only";
import {
	type CredentialProviderId,
	encodingPlanSchema,
	liveChannelPlanSchema,
	liveManifestPlaybackLinks,
	type ManifestPlaybackLink,
	manifestPlaybackLinks,
} from "@bitovp/core";
import type { ServerContext } from "./context";

/**
 * Resolves a job's manifest playback links on the SERVER
 * .
 *
 * Derivation needs the credential's non-secret `config` — region, host,
 * namespace, `publicBaseUrls`. That used to mean the job detail view fetched
 * `/api/credentials` and serialised every credential's config into the
 * browser to compute one URL. Nothing there is secret, but nothing there is
 * needed either, and the settings screen is the only place that legitimately
 * edits it.
 *
 * So the route hands the client the derived result and nothing else. Two
 * narrowings fall out of doing it here: only the credentials the plan actually
 * references are read (`findMany` on the referenced ids, not `list`), and
 * only `{id, provider, config}` is selected — never the ciphertext column.
 */
export async function playbackLinksForPlan(
	ctx: ServerContext,
	plan: unknown,
): Promise<ManifestPlaybackLink[]> {
	const parsed = encodingPlanSchema.safeParse(plan);
	if (!parsed.success) {
		// A DRAFT row, or a plan from an older schema. The view still renders;
		// it simply has no manifests to offer.
		return [];
	}
	return manifestPlaybackLinks(
		parsed.data,
		// Every output kind carries a credentialId today, AKAMAI_MSL included
		// (since the 2026-08-19 remodel) — and MSL's link is BUILT from its
		// credential's `edgeBaseUrl` (2026-09-02), so the filter is a guard on
		// the field, not a kind list. (This said MSL "has no object URL to
		// build, so it is filtered here" — true of the object URL, and no
		// longer the whole story.)
		await credentialsForOutputs(
			ctx,
			parsed.data.outputs.filter((o) => "credentialId" in o),
		),
	);
}

/**
 * Reads only the credentials the plan's outputs REFERENCE, and only the
 * non-secret columns. Shared by both plan kinds so the narrowing cannot hold
 * for one and not the other.
 */
async function credentialsForOutputs(
	ctx: ServerContext,
	outputs: readonly { credentialId: string }[],
): Promise<
	{
		id: string;
		provider: CredentialProviderId;
		config: Record<string, unknown>;
	}[]
> {
	const ids = [...new Set(outputs.map((o) => o.credentialId))];
	if (ids.length === 0) {
		return [];
	}
	const rows = await ctx.prisma.credential.findMany({
		where: { id: { in: ids } },
		select: { id: true, provider: true, config: true },
	});
	return rows.map((row) => ({
		id: row.id,
		provider: row.provider,
		config: (row.config ?? {}) as Record<string, unknown>,
	}));
}

/**
 * The same, for a live channel plan . One derivation
 * helper serves both because `destinationSchema` and `planOutputSchema` are
 * shared; only the plan schema and the manifest field name differ.
 */
export async function playbackLinksForLivePlan(
	ctx: ServerContext,
	plan: unknown,
): Promise<ManifestPlaybackLink[]> {
	const parsed = liveChannelPlanSchema.safeParse(plan);
	if (!parsed.success) {
		return [];
	}
	return liveManifestPlaybackLinks(
		parsed.data,
		// Same field guard as VOD. For a live channel this is where the MSL
		// credential's `edgeBaseUrl` reaches the derivation: only `{id,
		// provider, config}` is selected, and the delivery root is config.
		await credentialsForOutputs(
			ctx,
			parsed.data.outputs.filter((o) => "credentialId" in o),
		),
	);
}
