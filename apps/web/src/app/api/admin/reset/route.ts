import { NextResponse } from "next/server";
import {
	type CustomerErrorCode,
	customerErrorDetails,
} from "@/lib/customer-error";
import {
	RESET_DELETE_CATEGORIES,
	type ResetDeleteCategory,
	type ResetResourceType,
	resetPostAvailableResponseSchema,
	resetPostResponseSchema,
	resetPreviewResponseSchema,
	resetRequestSchema,
	resetSelectionSchema,
} from "@/lib/reset-customer-contract";
import { writeAuditLog } from "@/lib/server/audit";
import { bitmovinClientForAccount } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	AisaSnapshotRequired,
	assertAisaSnapshotCaptured,
} from "@/lib/server/delete-jobs";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import {
	getFeederQueue,
	getLiveChannelQueue,
	getNotifyQueue,
	getOrchestratorQueue,
	getSlateNormalizeQueue,
	getStorageInspectQueue,
	getVmafQueue,
} from "@/lib/server/queue";
import { releaseTemporaryStreamKeys } from "@/lib/server/release-stream-keys";
import {
	deleteOperationalData,
	findActiveWork,
	isIdle,
	RESET_DELETES,
	ResetRaceLost,
	uniqueEncoderPointers,
} from "@/lib/server/reset";
import { tokenActorRefusal } from "@/lib/server/reset-actor";
import {
	countResetCategories,
	deleteSelectedData,
	SelectedResetBlocked,
	type SelectedResetOutcome,
} from "@/lib/server/selected-reset";

/**
 *  — reset the data and start over.
 *
 * Explicit categories delete selected local data after a typed confirmation.
 * Provider cleanup ownership moves transactionally to encrypted internal work.
 * The preview reports current counts without blocking on active work. Requests
 * without categories retain the legacy operational-only reset contract.
 */
const CONFIRMATION = "RESET";
const RESET_BLOCKED_ERROR = "Data reset is temporarily unavailable.";

const RESET_DELETE_CATEGORY_BY_MODEL = {
	webhookEvent: "webhookHistory",
	auditLog: "auditHistory",
	accessEvent: "auditHistory",
	storageInspection: "storageChecks",
	watchedObject: "watchFolderHistory",
	alertEvent: "alertHistory",
	liveHeartbeat: "liveChannels",
	startupSample: "liveChannels",
	slateNormalization: "liveSchedules",
	liveSchedule: "liveSchedules",
	liveEffectClaim: "liveSchedules",
	feederSession: "pseudoLiveFeeds",
	vmafResult: "vmafMeasurements",
	vmafJob: "vmafMeasurements",
	manifestJob: "vodJobs",
	liveChannelRun: "liveChannels",
	liveChannel: "liveChannels",
	encodingJob: "vodJobs",
} as const satisfies Record<
	(typeof RESET_DELETES)[number],
	ResetDeleteCategory
>;

function resetConflict(code: CustomerErrorCode) {
	return jsonError(409, RESET_BLOCKED_ERROR, customerErrorDetails(code));
}

function customerResourceType(
	kind: "encodingJob" | "liveChannel" | "liveChannelRun",
): ResetResourceType {
	return kind === "encodingJob" ? "vodJob" : "liveChannel";
}

/**
 * The reset safety predicate needs the complete verification recovery dossier,
 * but the customer endpoint does not. Keep this projection an explicit
 * allowlist so future internal evidence fields cannot become customer data by
 * object spread.
 */
function customerVisibleActiveWork(
	active: Awaited<ReturnType<typeof findActiveWork>>,
) {
	return {
		vodJobs: active.encodingJobs.map(({ id, name, status }) => ({
			name,
			status,
			href: `/vod/jobs/${id}`,
		})),
		liveChannels: active.liveChannels.map(({ id, name, status }) => ({
			name,
			status,
			href: `/live/${id}`,
		})),
		pseudoLiveFeeds: active.feederSessions.map(
			({ id, channelName, sourceName, status, createdAt }) => ({
				channelName,
				sourceName,
				status,
				createdAt: createdAt.toISOString(),
				href: `/live/feeders/${id}`,
			}),
		),
		vmafMeasurements: active.vmafJobs.map(
			({ id, encodingName, mode, status, createdAt }) => ({
				encodingName,
				mode,
				status,
				createdAt: createdAt.toISOString(),
				href: `/qc/${id}`,
			}),
		),
		providerResourcesToCheck: uniqueEncoderPointers(
			active.unstoppedEncoders,
		).map(({ kind, name, status, bitmovinEncodingId }) => ({
			resourceType: customerResourceType(kind),
			name,
			status,
			bitmovinEncodingId,
		})),
		totals: {
			vodJobs: active.totals.encodingJobs,
			liveChannels: active.totals.liveChannels,
			pseudoLiveFeeds: active.totals.feederSessions,
			vmafMeasurements: active.totals.vmafJobs,
			providerResourcesToCheck: active.totals.unstoppedEncoders,
		},
	};
}

/**
 * The audit keeps exact database ownership fields for recovery. The customer
 * response gets only product terminology plus the provider id needed to find a
 * resource in Bitmovin; local row/account ids and Prisma model names never
 * cross this boundary.
 */
function customerVisibleEncoderReport(
	encoders: Awaited<ReturnType<typeof deleteOperationalData>>["encoders"],
) {
	const providerPointers = uniqueEncoderPointers(encoders.pointers);
	return {
		pointers: providerPointers.map(
			({ kind, name, status, bitmovinEncodingId }) => ({
				resourceType: customerResourceType(kind),
				name,
				status,
				bitmovinEncodingId,
			}),
		),
		total: encoders.providerIdentityTotal,
		truncated: providerPointers.length < encoders.providerIdentityTotal,
	};
}

export async function GET(req: Request) {
	const refused = tokenActorRefusal(req);
	if (refused) {
		return refused;
	}
	try {
		const ctx = await getServerContext();
		const requested = new URL(req.url).searchParams.get("categories");
		if (requested !== null) {
			const parsed =
				requested === ""
					? { success: true as const, data: [] as ResetDeleteCategory[] }
					: resetSelectionSchema.safeParse(requested.split(","));
			if (!parsed.success) return validationError(parsed.error);
			const selected = new Set(parsed.data);
			return NextResponse.json(
				resetPreviewResponseSchema.parse({
					active: {
						vodJobs: [],
						liveChannels: [],
						pseudoLiveFeeds: [],
						vmafMeasurements: [],
						providerResourcesToCheck: [],
						totals: {
							vodJobs: 0,
							liveChannels: 0,
							pseudoLiveFeeds: 0,
							vmafMeasurements: 0,
							providerResourcesToCheck: 0,
						},
					},
					cleanupUnconfirmed: false,
					blocked: false,
					aisaSnapshotRequiredJobHref: null,
					selectionBlocked: false,
					deleteCounts: await countResetCategories(ctx.prisma),
					channelAlertsToDelete: selected.has("channelAlertRules")
						? await ctx.prisma.alertRule.count({
								where: { liveChannelId: { not: null } },
							})
						: 0,
					watchFoldersToDisable:
						selected.has("watchFolderHistory") && !selected.has("watchFolders")
							? await ctx.prisma.watchRule.count({ where: { enabled: true } })
							: 0,
					confirmation: CONFIRMATION,
				}),
			);
		}
		const active = await findActiveWork(ctx.prisma);
		let aisaSnapshotRequiredJobHref: string | null = null;
		try {
			await assertAisaSnapshotCaptured(ctx.prisma);
		} catch (err) {
			if (!(err instanceof AisaSnapshotRequired)) throw err;
			aisaSnapshotRequiredJobHref = `/vod/jobs/${encodeURIComponent(err.jobId)}`;
		}
		const counts: Record<(typeof RESET_DELETES)[number], number> = {} as Record<
			(typeof RESET_DELETES)[number],
			number
		>;
		for (const model of RESET_DELETES) {
			counts[model] = await (
				ctx.prisma[model] as unknown as {
					count: (args?: unknown) => Promise<number>;
				}
			).count();
		}
		// 130-B1: the scoped half of a KEPT table is measured too, or the
		// dialog would show "AlertRule: kept" beside a number that is about to
		// drop.
		const channelAlertRulesToDelete = await ctx.prisma.alertRule.count({
			where: { liveChannelId: { not: null } },
		});
		// review-2 C1: the dialog must say that watch rules get disarmed, and
		// with the number — an operator who reads "configuration is kept" and
		// then finds their watch folders switched off deserves to have been
		// told, and one who is NOT told would instead discover the alternative:
		// every archived object re-encoded and re-billed.
		const watchFoldersToDisable = await ctx.prisma.watchRule.count({
			where: { enabled: true },
		});
		const deleteCounts = RESET_DELETE_CATEGORIES.map((category) => ({
			category,
			count: RESET_DELETES.reduce(
				(sum, model) =>
					RESET_DELETE_CATEGORY_BY_MODEL[model] === category
						? sum + counts[model]
						: sum,
				0,
			),
		}));
		return NextResponse.json(
			resetPreviewResponseSchema.parse({
				active: customerVisibleActiveWork(active),
				cleanupUnconfirmed: active.totals.verificationIntents > 0,
				blocked: !isIdle(active) || aisaSnapshotRequiredJobHref !== null,
				aisaSnapshotRequiredJobHref,
				deleteCounts,
				channelAlertsToDelete: channelAlertRulesToDelete,
				watchFoldersToDisable,
				confirmation: CONFIRMATION,
			}),
		);
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	const refused = tokenActorRefusal(req);
	if (refused) {
		return refused;
	}
	const body = resetRequestSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	if (body.data.confirm !== CONFIRMATION) {
		return jsonError(400, `Type ${CONFIRMATION} to confirm`);
	}
	try {
		const ctx = await getServerContext();
		// Legacy callers retain their operational-only safety contract. Selected
		// resets atomically transfer ownership and cancel through the cleanup worker.
		const categories = body.data.categories;
		if (!categories) {
			await assertAisaSnapshotCaptured(ctx.prisma);
		}
		const active = categories ? null : await findActiveWork(ctx.prisma);
		if (active && !isIdle(active)) {
			const onlyVerificationIntents =
				active.verificationIntents.length > 0 &&
				active.encodingJobs.length === 0 &&
				active.liveChannels.length === 0 &&
				active.feederSessions.length === 0 &&
				active.vmafJobs.length === 0 &&
				active.unstoppedEncoders.length === 0;
			// Two refusals, one status code, DIFFERENT sentences — because the
			// operator's next action differs. Running work is stopped from this
			// app; a row that merely still NAMES an encoder needs that encoder
			// checked in Bitmovin, and the app cannot tell them which it is
			// (130-B2).
			const onlyPointers =
				active.verificationIntents.length === 0 &&
				active.encodingJobs.length === 0 &&
				active.liveChannels.length === 0 &&
				active.feederSessions.length === 0 &&
				active.vmafJobs.length === 0;
			// , reported by the owner: the running-work message said
			// "the reset never touches Bitmovin, so deleting these rows would
			// leave encoders running" — for a VMAF report, which is this app's
			// OWN ffmpeg pipeline and never touches Bitmovin at all (there is
			// no Bitmovin VMAF API). They read it, checked the dashboard, found
			// nothing running, and were right. Only jobs and channels are the
			// cloud's; feeders and VMAF reports are ours, and they get a
			// sentence that points at this app instead.
			// review-3 C2: `unstoppedEncoders` is an INDEPENDENT scan — rows whose
			// status is idle but which still name a Bitmovin encoder — and it
			// counts toward isIdle. Omitting it here made "nothing runs on
			// Bitmovin" true-sounding and FALSE in the exact deployment that
			// filed this report: 1 VMAF row and 54 encoder pointers (the figure
			// as reported at refusal time; the completed reset's audit row
			// later preserved 328 — a different metric at a different instant,
			// see 's close). That is #133's own defect with the
			// polarity flipped, introduced by its fix.
			const onlyLocal =
				active.verificationIntents.length === 0 &&
				active.encodingJobs.length === 0 &&
				active.liveChannels.length === 0 &&
				active.unstoppedEncoders.length === 0;
			return resetConflict(
				onlyVerificationIntents
					? "RESET_CLEANUP_UNCONFIRMED"
					: onlyPointers
						? "RESET_PROVIDER_RESOURCES_UNCONFIRMED"
						: onlyLocal
							? "RESET_LOCAL_WORK_ACTIVE"
							: "RESET_ACTIVE_WORK",
			);
		}

		// 130-B2's second half now happens INSIDE deleteOperationalData's
		// transaction (review-265), so the recorded set is the set that died
		// rather than a snapshot taken moments before it.
		let outcome:
			| Awaited<ReturnType<typeof deleteOperationalData>>
			| SelectedResetOutcome;
		try {
			outcome = categories
				? await deleteSelectedData(ctx.prisma, categories, ctx.cipher)
				: await deleteOperationalData(ctx.prisma);
		} catch (err) {
			// review-2 I3: under Serializable, a row committed after the
			// in-transaction re-assert aborts the whole thing with P2034
			// instead of being silently deleted. Same answer as losing the
			// race by the explicit check, because it IS losing the race.
			const transactionError = err as {
				code?: string;
				meta?: { code?: string };
			};
			// Raw SELECT FOR UPDATE exposes PostgreSQL serialization conflicts
			// as P2010/40001; ordinary Prisma writes use P2034.
			if (
				transactionError.code === "P2034" ||
				(transactionError.code === "P2010" &&
					transactionError.meta?.code === "40001")
			) {
				return categories
					? jsonError(
							503,
							"Reset could not finish because data kept changing. Retry the reset.",
						)
					: resetConflict("RESET_STATE_CHANGED");
			}
			// review-265 130-A1: work that started mid-transaction gets the
			// SAME answer as work that was already running — nothing was
			// deleted, stop it and retry.
			if (err instanceof ResetRaceLost) {
				return resetConflict("RESET_STATE_CHANGED");
			}
			if (err instanceof SelectedResetBlocked) {
				return jsonError(400, "Reset selection is missing required categories");
			}
			throw err;
		}

		// Drain the queues AFTER the delete: a job that wakes up pointing at a
		// deleted id is tolerated by the processors, but "start over" that
		// leaves work queued is not a start over. Best-effort — a dead Redis
		// must not fail a reset whose database half already succeeded.
		const queues = {
			// Statistics imports are fenced by their deleted DB generation. Draining
			// here could erase a new generation accepted after the reset committed.
			orchestrator: { get: getOrchestratorQueue, categories: ["vodJobs"] },
			liveChannel: { get: getLiveChannelQueue, categories: ["liveChannels"] },
			vmafRunner: { get: getVmafQueue, categories: ["vmafMeasurements"] },
			feederManager: { get: getFeederQueue, categories: ["pseudoLiveFeeds"] },
			storageInspect: {
				get: getStorageInspectQueue,
				categories: ["storageChecks"],
			},
			notify: {
				get: getNotifyQueue,
				categories: ["notificationRules", "notificationChannels"],
			},
			// : a queued normalization pointing at a deleted row would
			// only no-op, but a start-over leaves nothing queued.
			slateNormalize: {
				get: getSlateNormalizeQueue,
				categories: ["liveSchedules"],
			},
		};
		const drained: Record<string, number | null> = {};
		for (const [name, entry] of Object.entries(queues)) {
			if (
				categories &&
				!categories.some((category) => entry.categories.includes(category))
			)
				continue;
			const queue = entry.get();
			try {
				// The queue facade returns only this organization's jobs. Remove
				// individual non-active jobs; queue-wide commands affect all tenants.
				// A scheduler's pending occurrence must survive so its next sweep runs.
				const before = await queue.getJobCountByTypes(
					"waiting",
					"active",
					"delayed",
					"paused",
				);
				const jobs = await queue.getJobs(
					["waiting", "delayed", "paused", "completed", "failed"],
					0,
					-1,
				);
				let failed = false;
				for (const job of jobs) {
					if (
						job.repeatJobKey ||
						job.opts.repeat ||
						job.id?.startsWith("repeat:")
					)
						continue;
					try {
						await job.remove();
					} catch {
						// A worker may acquire a lock between the scan and removal.
						failed = true;
					}
				}
				const after = await queue.getJobCountByTypes(
					"waiting",
					"active",
					"delayed",
					"paused",
				);
				drained[name] = failed ? null : before - after;
			} catch {
				drained[name] = null;
			}
		}

		// review-2 I2: as an ARRAY, because the audit writer redacts by KEY
		// NAME and `SENSITIVE_SUFFIX` matches `session$` — so `feederSession`,
		// a model name, was persisted as "[REDACTED]" where a number belonged.
		// One of fifteen numbers in the one record that survives the reset, in
		// a design whose stated property is that the audit row cannot disagree
		// with what happened. Model names are values here, and the redactor
		// walks keys.
		const countRows = Object.entries(outcome.counts).map(([model, count]) => ({
			model,
			count,
		}));

		// The trail's first row of the new history: the audit table was just
		// emptied, so this says what the deleted history contained rather than
		// pretending it survived.
		const auditStartedAt = new Date();
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: "/api/admin/reset",
				statusCode: 200,
				response: {
					counts: countRows,
					...(categories ? { categories } : {}),
					drained,
					encoders: outcome.encoders,
					disarmedWatchRules: outcome.disarmed,
				},
			},
			req,
		);
		// Read back rather than trust: writeAuditLog catches its own failure
		// and returns nothing. Selected resets may preserve prior audit history,
		// so a receipt older than this write cannot prove the write succeeded.
		//
		// review-2 N1: its OWN try/catch, and tri-state. Inside the outer try
		// this one query could turn a completed reset into a 500 — discarding
		// the response body, which is the operator's only readable copy of the
		// encoder pointers and therefore the very thing I5 exists to protect.
		// And a failed READ is not evidence of a failed WRITE, so it must not
		// claim the row is missing: "unknown" says what was actually measured.
		let audited: boolean | "unknown";
		try {
			audited =
				(await ctx.prisma.auditLog.count({
					where: {
						path: "/api/admin/reset",
						method: "POST",
						at: { gte: auditStartedAt },
					},
				})) > 0;
		} catch {
			audited = "unknown";
		}
		/*
		 *  — release the TEMPORARY stream keys of the encodings this
		 * reset just wiped. AFTER the commit and the drain, best-effort by
		 * contract: the reset's promise is a local wipe that works offline, so
		 * a dead Bitmovin must not turn a completed reset into an error. This
		 * is the one safe release point — a STOPPED channel is restartable and
		 * needs its key, a DELETED one is not.
		 */
		const retainedLivePointers = outcome.encoders.pointers.filter(
			(pointer) => pointer.kind !== "encodingJob",
		);
		const streamKeys = await releaseTemporaryStreamKeys(
			categories ? [] : retainedLivePointers,
			async (accountId) => {
				// Credentials were intentionally erased; report unconfirmed cleanup
				// rather than look up a different/default account after commit.
				if (categories?.includes("bitmovinAccounts")) return null;
				const api = await bitmovinClientForAccount(ctx, accountId);
				if (!api) return null;
				return {
					list: (q) => api.encoding.live.streamKeys.list(q),
					delete: (id) => api.encoding.live.streamKeys.delete(id),
				};
			},
			(line) => console.warn(line),
		);

		const customerReport = resetPostAvailableResponseSchema.safeParse({
			reportStatus: "available",
			...("deletedCounts" in outcome
				? {
						deletedCounts: outcome.deletedCounts,
						requiresSetup: false,
					}
				: {}),
			queueCleanupIncomplete: Object.values(drained).some(
				(count) => count === null,
			),
			temporaryStreamKeyCleanupUnconfirmed:
				(categories !== undefined && retainedLivePointers.length > 0) ||
				uniqueEncoderPointers(retainedLivePointers).length <
					outcome.encoders.liveProviderIdentityTotal ||
				streamKeys.failed > 0 ||
				streamKeys.skippedNoAccount > 0 ||
				streamKeys.accountErrors > 0,
			providerResources: customerVisibleEncoderReport(outcome.encoders),
			disabledWatchFolders: outcome.disarmed.map(({ name }) => ({ name })),
			// review-2 I5: writeAuditLog swallows its own failure, and this row
			// is the ONLY surviving record of the encoders — stepLog, where
			// stop-orphan-live.ts discovers them, was just deleted. If the row
			// did not land, the operator has to be told while they still have
			// the response in front of them.
			auditRecorded: audited,
		});
		if (!customerReport.success) {
			// The reset has already committed. Never turn a malformed result report
			// into a generic retryable failure: return the stable uncertainty state
			// while logging only schema paths/codes, not customer data.
			console.error(
				"[reset] customer result report invalid after commit",
				customerReport.error.issues.map(({ code, path }) => ({ code, path })),
			);
			return NextResponse.json(
				resetPostResponseSchema.parse({ reportStatus: "unconfirmed" }),
			);
		}
		return NextResponse.json(customerReport.data);
	} catch (err) {
		if (err instanceof AisaSnapshotRequired) {
			return jsonError(
				409,
				"Capture AI Scene Analysis from finished jobs into the Library before resetting their history.",
				customerErrorDetails("RESET_AISA_SNAPSHOT_REQUIRED"),
			);
		}
		return routeError(err);
	}
}
