import {
	loadEnv,
	type PlanValidationOptions,
	parseSecretEgressAllowlist,
} from "@bitovp/core";

/**
 * Validation context for server-side plan checks .
 *
 * Passing this is what makes a caller the *enforcement point* for the
 * credential-egress host allowlist. Routes always pass it — including when the
 * allowlist is unset, which resolves to `[]` and produces the "unrestricted"
 * warning. Client-side previews pass nothing and stay silent, because they
 * cannot read server env and a warning they cannot substantiate is noise.
 */
export function serverPlanValidationOptions(
	credentialProviders?: ReadonlyMap<string, string>,
): PlanValidationOptions {
	const env = loadEnv();
	return {
		secretEgressAllowedHosts: parseSecretEgressAllowlist(
			env.SECRET_EGRESS_ALLOWED_HOSTS,
		),
		// SPEKE validation needs the resolved credential provider.
		credentialProviders,
	};
}

/** Resolve credential providers through the caller's tenant-scoped Prisma. */
export async function credentialProviderMap(prisma: {
	credential: {
		findMany: (args: {
			select: { id: true; provider: true };
		}) => Promise<{ id: string; provider: string }[]>;
	};
}): Promise<ReadonlyMap<string, string>> {
	const rows = await prisma.credential.findMany({
		select: { id: true, provider: true },
	});
	return new Map(rows.map((r) => [r.id, r.provider]));
}

/** Server egress policy, credential compatibility, and MSL publishing auth. */
export async function submitterValidationOptions(
	prisma: {
		credential: {
			findMany: (args: {
				select: { id: true; provider: true };
			}) => Promise<{ id: string; provider: string }[]>;
		};
	},
	/**
	 * Resolver for rail 3b's input — . REQUIRED, and `null` is an
	 * explicit "this caller cannot read the vault" rather than a forgotten
	 * argument. Making it optional would have meant a caller that omits it
	 * looks identical to one that has nothing to say, which is the failure this
	 * repo has already paid for twice (#162's own gate, `SweepDeps`).
	 *
	 * Narrowed to the one method on purpose: this function has no business with
	 * the rest of the credential store, and a narrow type keeps a test double
	 * honest.
	 */
	credentials: {
		publishingAuthCredentialIds(): Promise<ReadonlySet<string>>;
	} | null,
): Promise<PlanValidationOptions> {
	// A null store cannot answer publishing-auth questions; an empty set can.
	const credentialHasPublishingAuth =
		credentials === null
			? undefined
			: await credentials.publishingAuthCredentialIds();
	return {
		...serverPlanValidationOptions(await credentialProviderMap(prisma)),
		credentialHasPublishingAuth,
	};
}

// recordUnrestrictedEgress moved to @bitovp/db : the
// watch-folder sweep is a second submitter process, and a copied loop would
// drift — same reason submitEncodingJob was extracted. Re-exported so the
// routes' import sites stay put.
export { recordUnrestrictedEgress } from "@bitovp/db";
