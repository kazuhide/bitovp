import {
	type CredentialProviderId,
	instantiateWatchPlan,
	redactSecrets,
	type SubmitOutcome,
	watchObjectExtension,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import type { EmitProductEvent } from "../notify/emitter";

/**
 * Watch-folder sweep . LISTS the customer's own
 * bucket — never writes a byte to it; processed-state lives in OUR rows.
 *
 * Multi-worker safety is layered: the SEEN→STABLE→SUBMITTED transitions
 * are status-guarded updateMany claims, and the (rule, key, contentId)
 * unique index makes the racing-insert loser's P2002 a no-op (#14
 * precedent). A rule's failures back off exponentially (cap 15 min) and
 * never affect other rules.
 */

const MAX_PAGES_PER_SWEEP = 5;
const BACKOFF_CAP_MS = 15 * 60_000;
/**
 * review-87b I-2: a worker that dies between the claim and the submit
 * leaves SUBMITTED ∧ encodingJobId NULL forever — unretried, unsurfaced,
 * and invisible to backpressure. After this window such rows are swept to
 * ERROR (visible, re-armable). NOT back to STABLE: the crash may have
 * landed AFTER the job row was created but BEFORE the link write, and an
 * auto-retry there is a second paid encoding. At-most-once wins.
 */
const LOST_CLAIM_REAP_MS = 15 * 60_000;

export type WatchListedObject = {
	key: string;
	size: number;
	lastModified?: string;
};

export type WatchSweepDeps = {
	prisma: AppPrismaClient;
	/** One page of RECURSIVE listing under the rule's prefix. */
	listPage(
		rule: { credentialId: string; bucket: string; prefix: string },
		cursor: string | undefined,
	): Promise<{ objects: WatchListedObject[]; nextCursor?: string }>;
	/** Core's submitEncodingJob wrapped with worker deps (queue + egress). */
	submitPlan(
		plan: unknown,
		provenance?: { presetId: string; presetRevision: number },
	): Promise<SubmitOutcome>;
	emitEvent?: EmitProductEvent;
	now(): Date;
	uuid(): string;
};

export type WatchSweepStats = {
	rulesSwept: number;
	seen: number;
	submitted: number;
	errors: number;
};

/** size:mtime — our storage contract surfaces no etag (recorded limit). */
function contentIdOf(object: WatchListedObject): string {
	const mtime = object.lastModified ? Date.parse(object.lastModified) : 0;
	return `${object.size}:${Number.isFinite(mtime) ? mtime : 0}`;
}

function isP2002(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: string }).code === "P2002"
	);
}

export function createWatchSweep(deps: WatchSweepDeps) {
	/** List + upsert + stability advance for ONE rule. */
	async function scan(rule: {
		id: string;
		credentialId: string;
		bucket: string;
		prefix: string;
		extensions: string[];
		stabilityChecks: number;
		scanCursor: string | null;
	}): Promise<{ seen: number; nextCursor: string | null }> {
		let cursor = rule.scanCursor ?? undefined;
		let seen = 0;
		for (let page = 0; page < MAX_PAGES_PER_SWEEP; page++) {
			const result = await deps.listPage(
				{
					credentialId: rule.credentialId,
					bucket: rule.bucket,
					prefix: rule.prefix,
				},
				cursor,
			);
			for (const object of result.objects) {
				seen += 1;
				const contentId = contentIdOf(object);
				const extension = watchObjectExtension(object.key);
				const allowed =
					rule.extensions.length === 0 || rule.extensions.includes(extension);
				const existing = await deps.prisma.watchedObject.findUnique({
					where: {
						watchRuleId_objectKey_contentId: {
							watchRuleId: rule.id,
							objectKey: object.key,
							contentId,
						},
					},
					select: { id: true, state: true, stableCount: true },
				});
				if (!existing) {
					try {
						await deps.prisma.watchedObject.create({
							data: {
								watchRuleId: rule.id,
								objectKey: object.key,
								contentId,
								state: allowed ? "SEEN" : "SKIPPED",
								size: BigInt(object.size),
								mtimeMs: object.lastModified
									? Date.parse(object.lastModified)
									: null,
								stableCount: 1,
							},
						});
					} catch (err) {
						// Another worker inserted the same sighting first —
						// exactly the state we wanted (#14 precedent).
						if (!isP2002(err)) {
							throw err;
						}
					}
					continue;
				}
				if (existing.state !== "SEEN") {
					continue; // SKIPPED/STABLE/SUBMITTED/ERROR rows don't re-count
				}
				// Same contentId sighted again: one more stability tick. The
				// guarded update makes double-counting a lost race, not a bug.
				const nextCount = existing.stableCount + 1;
				await deps.prisma.watchedObject.updateMany({
					where: { id: existing.id, state: "SEEN" },
					data: {
						stableCount: nextCount,
						...(nextCount >= rule.stabilityChecks
							? { state: "STABLE" as const }
							: {}),
					},
				});
			}
			cursor = result.nextCursor;
			if (!cursor) {
				return { seen, nextCursor: null };
			}
		}
		// Bounded pages exhausted with more to go: SAY so via the cursor
		// (searchObjects honesty rule) — the next sweep resumes here.
		return { seen, nextCursor: cursor ?? null };
	}

	/** Claim STABLE rows under the backpressure cap and submit each. */
	async function submitStable(rule: {
		id: string;
		name: string;
		bucket: string;
		credentialId: string;
		/** Backstop for the save-time provider check — see InstantiateWatchPlanInput. */
		credentialProvider?: CredentialProviderId;
		outputPrefixTemplate: string;
		labels: string[];
		maxConcurrentJobs: number;
		presetBody: unknown;
		/** Template provenance : a watch rule IS template+trigger. */
		presetId: string;
		presetRevision: number;
	}): Promise<{ submitted: number; errors: number }> {
		let submitted = 0;
		let errors = 0;
		// Backpressure: in-flight = SUBMITTED rows whose job is not terminal.
		const inFlight = await deps.prisma.watchedObject.count({
			where: {
				watchRuleId: rule.id,
				state: "SUBMITTED",
				encodingJob: { is: { status: { in: ["QUEUED", "RUNNING"] } } },
			},
		});
		let budget = Math.max(0, rule.maxConcurrentJobs - inFlight);
		if (budget === 0) {
			return { submitted, errors };
		}
		const stable = await deps.prisma.watchedObject.findMany({
			where: { watchRuleId: rule.id, state: "STABLE" },
			orderBy: { createdAt: "asc" },
			take: budget,
		});
		// review-87b C-1: per-objectKey serialization AT the money gate. Two
		// STABLE rows for one key (a re-arm race, or a re-upload landing while
		// the previous content encodes) must submit ONE at a time — the later
		// row stays STABLE and waits for the in-flight encoding to reach a
		// terminal state. A lost claim (SUBMITTED ∧ jobId NULL) blocks its key
		// too, until the reaper surfaces it.
		const claimedKeysThisPass = new Set<string>();
		for (const object of stable) {
			if (budget === 0) {
				break;
			}
			if (claimedKeysThisPass.has(object.objectKey)) {
				continue;
			}
			const activeSameKey = await deps.prisma.watchedObject.findFirst({
				where: {
					watchRuleId: rule.id,
					objectKey: object.objectKey,
					state: "SUBMITTED",
					OR: [
						{ encodingJobId: null },
						{ encodingJob: { is: { status: { in: ["QUEUED", "RUNNING"] } } } },
					],
				},
				select: { id: true },
			});
			if (activeSameKey) {
				continue;
			}
			// The atomic claim: STABLE→SUBMITTED; the loser walks away.
			const { count } = await deps.prisma.watchedObject.updateMany({
				where: { id: object.id, state: "STABLE" },
				data: { state: "SUBMITTED" },
			});
			if (count === 0) {
				continue;
			}
			claimedKeysThisPass.add(object.objectKey);
			budget -= 1;
			const instantiated = instantiateWatchPlan({
				presetBody: rule.presetBody,
				objectKey: object.objectKey,
				rule: {
					name: rule.name,
					bucket: rule.bucket,
					credentialId: rule.credentialId,
					outputPrefixTemplate: rule.outputPrefixTemplate,
					labels: rule.labels,
					credentialProvider: rule.credentialProvider,
				},
				now: deps.now(),
				uuid: deps.uuid(),
			});
			if (!instantiated.ok) {
				errors += 1;
				await deps.prisma.watchedObject.updateMany({
					where: { id: object.id },
					data: {
						state: "ERROR",
						error: instantiated.issues.map((issue) => issue.message).join("; "),
					},
				});
				await deps.emitEvent?.({
					kind: "WATCH_ERROR",
					watchFolderId: rule.id,
					objectPath: object.objectKey,
					error: instantiated.issues[0]?.message ?? "instantiation failed",
					path: "/settings/watch-folders",
				});
				continue;
			}
			try {
				const outcome = await deps.submitPlan(instantiated.plan, {
					presetId: rule.presetId,
					presetRevision: rule.presetRevision,
				});
				if (!outcome.ok) {
					errors += 1;
					/**
					 * The ISSUES, not just the headline (review-210 C2). A bare
					 * "Plan validation failed" is unactionable for the one
					 * submitter that has no UI in front of it — the operator sees
					 * this string in the row and in the notification, and nowhere
					 * else. The instantiation branch above already joins its
					 * issues; this branch discarded them.
					 */
					const errorIssues = (outcome.issues ?? []).filter(
						(i) => i.level === "error",
					);
					// Bounded (review-210 I5): this string is persisted AND emitted
					// as a notification, so a spec with many constraints — or a long
					// id — must not become an oversized payload that burns the
					// notify job's retries once per discovered object.
					const shown = errorIssues.slice(0, 5).map((i) => i.message);
					const detail = errorIssues.length
						? `${outcome.message}: ${shown.join("; ")}${
								errorIssues.length > shown.length
									? ` …and ${errorIssues.length - shown.length} more`
									: ""
							}`
						: outcome.message;
					const safeDetail = redactSecrets(detail);
					await deps.prisma.watchedObject.updateMany({
						where: { id: object.id },
						data: { state: "ERROR", error: safeDetail },
					});
					await deps.emitEvent?.({
						kind: "WATCH_ERROR",
						watchFolderId: rule.id,
						objectPath: object.objectKey,
						// REDACTED on the emit too (review-210 I6): the event schema
						// promises "already redacted at persist time", and this
						// string became plan-derived when the delivery refusal
						// started spelling its deviations.
						error: safeDetail,
						path: "/settings/watch-folders",
					});
					continue;
				}
				submitted += 1;
				await deps.prisma.watchedObject.updateMany({
					where: { id: object.id },
					data: { encodingJobId: outcome.id },
				});
				await deps.emitEvent?.({
					kind: "WATCH_SUBMITTED",
					watchFolderId: rule.id,
					objectPath: object.objectKey,
					jobId: outcome.id,
					path: `/vod/jobs/${outcome.id}`,
				});
			} catch (err) {
				// submitPlan THROWS only on enqueue failure — the job row
				// exists and is already marked ERROR by the pipeline; the
				// tracking row records the linkage failure visibly.
				errors += 1;
				// N-3: this path holds decrypted storage credentials in scope —
				// it was the one worker error-write outside the repo-wide
				// redaction convention.
				await deps.prisma.watchedObject.updateMany({
					where: { id: object.id },
					data: {
						state: "ERROR",
						error: redactSecrets(
							err instanceof Error ? err.message : String(err),
						),
					},
				});
				await deps.emitEvent?.({
					kind: "WATCH_ERROR",
					watchFolderId: rule.id,
					objectPath: object.objectKey,
					error: err instanceof Error ? err.message : "submit failed",
					path: "/settings/watch-folders",
				});
			}
		}
		return { submitted, errors };
	}

	return async function runOnce(): Promise<WatchSweepStats> {
		const stats: WatchSweepStats = {
			rulesSwept: 0,
			seen: 0,
			submitted: 0,
			errors: 0,
		};
		const now = deps.now();
		// review-87b I-2 reaper: lost claims (worker died between claim and
		// submit) surface as ERROR after LOST_CLAIM_REAP_MS. Global — a rule
		// disabled after the crash must still surface its stranded row. The
		// per-row CAS keeps a concurrent reaper from double-emitting.
		const lostClaims = await deps.prisma.watchedObject.findMany({
			where: {
				state: "SUBMITTED",
				encodingJobId: null,
				updatedAt: { lt: new Date(now.getTime() - LOST_CLAIM_REAP_MS) },
			},
			select: { id: true, watchRuleId: true, objectKey: true },
		});
		for (const lost of lostClaims) {
			const { count } = await deps.prisma.watchedObject.updateMany({
				where: { id: lost.id, state: "SUBMITTED", encodingJobId: null },
				data: {
					state: "ERROR",
					error:
						"Claimed but never submitted — the worker likely died mid-claim. Not auto-retried (the encoding may exist unlinked); use Re-encode after checking the jobs list.",
				},
			});
			if (count === 1) {
				stats.errors += 1;
				await deps.emitEvent?.({
					kind: "WATCH_ERROR",
					watchFolderId: lost.watchRuleId,
					objectPath: lost.objectKey,
					error: "claimed but never submitted (lost claim reaped)",
					path: "/settings/watch-folders",
				});
			}
		}
		const rules = await deps.prisma.watchRule.findMany({
			where: { enabled: true },
			include: {
				preset: { select: { body: true, revision: true } },
				// The provider, so the sweep's re-check can do the CREDENTIAL
				// half too and not just the template half .
				credential: { select: { provider: true } },
			},
		});
		for (const rule of rules) {
			// Due check incl. exponential backoff: a failing rule waits
			// interval × 2^errorStreak (capped 15 min); a healthy one polls at
			// its own pollIntervalSec (floor 60s — C6 politeness).
			const baseMs = Math.max(60, rule.pollIntervalSec) * 1000;
			const waitMs =
				rule.errorStreak > 0
					? Math.min(
							baseMs * 2 ** Math.min(rule.errorStreak, 10),
							BACKOFF_CAP_MS,
						)
					: baseMs;
			const dueAt = rule.lastSweepAt ? rule.lastSweepAt.getTime() + waitMs : 0;
			if (now.getTime() < dueAt) {
				continue;
			}
			stats.rulesSwept += 1;
			try {
				const scanResult = await scan(rule);
				stats.seen += scanResult.seen;
				const submitResult = await submitStable({
					...rule,
					presetBody: rule.preset.body,
					presetRevision: rule.preset.revision,
					credentialProvider: rule.credential?.provider,
				});
				stats.submitted += submitResult.submitted;
				stats.errors += submitResult.errors;
				await deps.prisma.watchRule.update({
					where: { id: rule.id },
					data: {
						lastSweepAt: now,
						scanCursor: scanResult.nextCursor,
						lastError: null,
						errorStreak: 0,
					},
				});
			} catch (err) {
				// Credential/list failure: record, back off THIS rule only.
				stats.errors += 1;
				await deps.prisma.watchRule
					.update({
						where: { id: rule.id },
						data: {
							lastSweepAt: now,
							lastError: redactSecrets(
								err instanceof Error ? err.message : String(err),
							),
							errorStreak: { increment: 1 },
						},
					})
					.catch(() => {});
			}
		}
		return stats;
	};
}

/** Prisma Json → unknown without a cast chain at the call site. */
export type WatchRulePresetBody = Prisma.JsonValue;
