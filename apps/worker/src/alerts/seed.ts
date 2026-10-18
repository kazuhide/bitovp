import type { AppPrismaClient } from "@bitovp/db";
import { writeAuditLog } from "@bitovp/db";

/**
 * Default alert rules : INPUT_DISCONNECTED and
 * HEARTBEAT_STALE, both CRIT, global scope — the two rules with no tunable
 * judgment. Numeric rules stay opt-in (default thresholds would
 * false-positive on legitimately low-bitrate channels).
 *
 * Idempotence is MARKER-guarded, not emptiness-guarded: an operator who
 * deletes every rule has expressed a preference, and an empty-table check
 * would resurrect the defaults behind their back on the next restart. The
 * marker is an AuditLog POLICY row — queryable in Settings → Audit, no new
 * table. Installs that created rules BEFORE seeding existed are
 * grandfathered: rules present without the marker ⇒ mark, seed nothing.
 */

const SEED_MARKER_PATH = "worker:alert-default-seed";
/**
 * The PROVIDER_WARNING default (2026-09-02) has its OWN marker: the first
 * seed's marker already exists on every deployed install, so a rule added to
 * the list above would reach new installs only — a named slot nobody fills.
 * Same discipline once it has run: delete the rule and it stays deleted.
 */
const PROVIDER_WARNING_MARKER_PATH =
	"worker:alert-default-seed:provider-warning";

export async function seedDefaultAlertRules(deps: {
	prisma: AppPrismaClient;
}): Promise<{ seeded: number }> {
	const seeded =
		(await seedInitialDefaults(deps)) +
		(await seedProviderWarningDefault(deps));
	return { seeded };
}

async function seedInitialDefaults(deps: {
	prisma: AppPrismaClient;
}): Promise<number> {
	const marker = await deps.prisma.auditLog.findFirst({
		where: { path: SEED_MARKER_PATH },
		select: { id: true },
	});
	if (marker) {
		return 0;
	}
	const existing = await deps.prisma.alertRule.count();
	let seeded = 0;
	if (existing === 0) {
		await deps.prisma.alertRule.createMany({
			data: [
				{ metric: "INPUT_DISCONNECTED", severity: "CRIT", windowPolls: 2 },
				// : air time arrived and the feed did not. One poll —
				// at program start the operator wants to know NOW, and the
				// window-gating in the evaluator already prevents pre-air noise.
				{ metric: "PROGRAM_START_NO_INGEST", severity: "CRIT", windowPolls: 1 },
				{ metric: "HEARTBEAT_STALE", severity: "CRIT", windowPolls: 2 },
			],
		});
		seeded = 3;
	}
	// Through the shared writer, not `auditLog.create` directly. Two reasons,
	// both from security-review-212: this was the one door into the table that
	// skipped `redactSecrets` (harmless today — three constants — but an
	// unguarded door nothing watches), and it wrote a NULL actor that was
	// indistinguishable from the attribution defect  was about.
	await writeAuditLog(deps.prisma, {
		method: "POLICY",
		path: SEED_MARKER_PATH,
		actor: "worker:alert-seed",
		request: {
			policy: "ALERT_DEFAULT_SEED",
			seeded,
			grandfathered: existing > 0,
		},
	});
	return seeded;
}

/**
 * The encoder's own WARNING/ERROR entries as an alert — no threshold to
 * tune, so it qualifies as a default; WARN rather than CRIT because the
 * provider's word is "warning" (an ERROR entry rides the same rule and the
 * context says which). windowPolls 2 = one minute of silence resolves it.
 * Skipped when ANY PROVIDER_WARNING rule already exists (an operator who
 * added a channel-scoped one has expressed the preference).
 */
async function seedProviderWarningDefault(deps: {
	prisma: AppPrismaClient;
}): Promise<number> {
	const marker = await deps.prisma.auditLog.findFirst({
		where: { path: PROVIDER_WARNING_MARKER_PATH },
		select: { id: true },
	});
	if (marker) {
		return 0;
	}
	const existing = await deps.prisma.alertRule.count({
		where: { metric: "PROVIDER_WARNING" },
	});
	let seeded = 0;
	if (existing === 0) {
		await deps.prisma.alertRule.createMany({
			data: [{ metric: "PROVIDER_WARNING", severity: "WARN", windowPolls: 2 }],
		});
		seeded = 1;
	}
	await writeAuditLog(deps.prisma, {
		method: "POLICY",
		path: PROVIDER_WARNING_MARKER_PATH,
		actor: "worker:alert-seed",
		request: {
			policy: "ALERT_DEFAULT_SEED_PROVIDER_WARNING",
			seeded,
			grandfathered: existing > 0,
		},
	});
	return seeded;
}
