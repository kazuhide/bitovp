import { getIdentityPrisma, getTenantPrisma } from "@bitovp/db";
import { mintToken } from "../src/lib/auth/api-token";

/**
 * Headless token minting :
 *   pnpm --filter @bitovp/web auth:create-token -- --name ci-runner [--expires-days 90]
 * Prints the secret to stdout EXACTLY ONCE — it is stored only as a SHA-256.
 * The Settings UI is the browser path; this is the escape hatch for installs
 * without one (same discipline as auth:hash).
 */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const nameIdx = args.indexOf("--name");
	const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
	// review-188 N5: `--name --expires-days 90` silently minted a token NAMED
	// "--expires-days" with no expiry — a flag can never be a value.
	if (!name || name.startsWith("--")) {
		console.error(
			"Usage: pnpm --filter @bitovp/web auth:create-token -- --name <name> [--expires-days N]",
		);
		process.exit(1);
	}
	const daysIdx = args.indexOf("--expires-days");
	const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;
	if (
		days !== undefined &&
		(!Number.isFinite(days) || days <= 0 || days > 36_500)
	) {
		// Upper bound (review-188 N5): 1e20 passed isFinite and produced an
		// Invalid Date -> opaque Prisma error. A century is enough.
		console.error("--expires-days must be a positive number of days (≤ 36500)");
		process.exit(1);
	}
	const orgIdx = args.indexOf("--organization-id");
	const organizationId = orgIdx >= 0 ? args[orgIdx + 1] : undefined;
	if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId))
		throw new Error("An explicit --organization-id UUID is required");
	const userIdx = args.indexOf("--user-id");
	const userId = userIdx >= 0 ? args[userIdx + 1] : undefined;
	if (!userId)
		throw new Error("An explicit --user-id is required for new tokens");
	const member = await getIdentityPrisma().membership.findUnique({
		where: { userId_organizationId: { userId, organizationId } },
		include: { user: { select: { active: true, mustChangePassword: true } } },
	});
	if (
		!member?.active ||
		!member.user.active ||
		member.user.mustChangePassword ||
		member.role !== "ADMIN"
	)
		throw new Error(
			"An active organization administrator must issue this token",
		);
	const { secret, prefix, tokenHash } = mintToken();
	const row = await getTenantPrisma(organizationId).apiToken.create({
		data: {
			name,
			organizationId,
			userId,
			createdBy: `user:${userId}`,
			prefix,
			tokenHash,
			...(days !== undefined
				? { expiresAt: new Date(Date.now() + days * 86_400_000) }
				: {}),
		},
	});
	// hash-password's discipline: info to stderr, the SECRET alone to stdout,
	// so `auth:create-token -- --name x >> token.txt` stores only the secret.
	console.error(`Created API token "${name}" (id ${row.id}, prefix ${prefix})`);
	console.error("Secret (shown ONCE — stdout carries it alone):");
	console.log(secret);
	process.exit(0);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
