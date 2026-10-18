import {
	type AlertMetric,
	compileExpectedLiveArtefacts,
	effectiveLivePlanForRun,
	evaluateOriginPlaylist,
	METRIC_CLASS,
	type OriginPlaylistCursor,
	type OriginPublishState,
	parseMediaPlaylist,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import {
	type BrowserCredential,
	createBrowserForCredential,
	storageErrorText,
	UnsupportedBrowseError,
} from "@bitovp/storage";
import type { EmitProductEvent } from "../notify/emitter";

/**
 * Origin observer  — bitovp's own delivery-side witness:
 * read each RUNNING channel's live MEDIA playlists from the origin and
 * evaluate liveness checks that do not depend on anything the encoder says
 * about itself. BITMOVIN stays primary; these BITOVP×DELIVERY signals are
 * deliberately few (stale / ENDLIST / edge delay).
 *
 * Fetch-path resolution is PER RUN (§3 revision ×2): a re-air moves the
 * output subtree (#155), so the observer composes core's
 * `effectiveLivePlanForRun` + `compileExpectedLiveArtefacts` — the same
 * derivation the verify engine uses — and reads through the plan's own
 * output credential. `null` ⇒ "observation unavailable, with reason";
 * never a guessed path.
 *
 * v1 scope (the row records the deferral): the STORAGE-DRIVER arm only.
 * The railed-HTTP arm (public-URL origins) bolts onto the same seam; MSL /
 * NetStorage / SFTP / role-based-S3 answer unobservable-with-reason, the
 * population derived from the driver's own refusal, not a hand list.
 */

export const MAX_PLAYLIST_BYTES = 256 * 1024;
/**
 * Reason code persisted when a playlist read hits the cap (MODERATE-1,
 * audit 2026-08-29 §9) — SCREAMING_SNAKE like the file's other context
 * flags (`INPUT_DISCONNECTED`, `ORIGIN_MANIFEST_STALE`) so it stays
 * greppable in the persisted record and the dashboard's raw reason text.
 */
const PLAYLIST_TRUNCATED_REASON = `PLAYLIST_TRUNCATED_AT_${MAX_PLAYLIST_BYTES / 1024}KIB`;
export const ORIGIN_SWEEP_INTERVAL_MS = 10_000;

export type OriginObservationState = {
	lastFetchAtMs?: number;
	dueAtMs?: number;
	unavailableReason?: string;
	/** This tick reached the bounded read cap; never a content verdict or total size. */
	playlistReadLimitReached?: true;
	playlists?: Record<string, OriginPlaylistCursor>;
	lastVerdicts?: Record<
		string,
		{ stale: boolean; endlist: boolean; edgeDelaySeconds: number | null }
	>;
	/**
	 * Has this RUN's origin published its first segment yet ?
	 * `core`'s `originPublishState` is the only reader — see the type there for
	 * what each state does and does not claim.
	 *
	 * The two states age differently, on purpose:
	 *  - `"PUBLISHED"` is a fact about the run's HISTORY (it went on air), so it
	 *    is STICKY — every persist below carries it forward, including the
	 *    unavailable early returns. A rotated credential must not un-publish a
	 *    channel that has been delivering for an hour.
	 *  - `"AWAITING"` is a claim about the PRESENT ("we asked the store just now
	 *    and the media playlists are not there"), so a tick that could not ask
	 *    drops it back to unknown rather than carrying it. Carrying it would
	 *    misrepresent one pre-publish tick as a current delivery observation.
	 */
	publish?: OriginPublishState;
};

/**
 * The `publish` fact an UNREACHABLE tick may carry forward: only the sticky
 * half. Used by every persist that never got as far as asking the store.
 */
function carryPublish(
	state: OriginObservationState,
): { publish: OriginPublishState } | Record<string, never> {
	return state.publish === "PUBLISHED" ? { publish: "PUBLISHED" } : {};
}

export type OriginObserverDeps = {
	prisma: AppPrismaClient;
	resolveCredential: (credentialId: string) => Promise<{
		provider: string;
		config: Record<string, unknown>;
		secret: Record<string, string>;
	}>;
	emitEvent?: EmitProductEvent;
	now?: () => Date;
};

/**
 * Bounded read that reports whether the cap was reached (MODERATE-1,
 * audit 2026-08-29 §9). The only call site range-requests exactly
 * `[0, cap - 1]` bytes from the driver (see the `browser.getObject` call
 * below), so once this loop has consumed `cap` bytes the underlying HTTP
 * body ends for one of two indistinguishable reasons: the object was
 * exactly `cap` bytes long, or it was longer and the range clipped it.
 * Neither `readBounded` nor its caller ever sees `Content-Range` or the
 * real object size — the driver interface's `getObject` resolves to a
 * bare `ReadableStream` (checked in `packages/storage/src/types.ts` and
 * every driver's implementation) — so there is no way to tell those two
 * cases apart from here.
 *
 * Boundary decision: `truncated` is therefore true whenever the cap is
 * REACHED (`total >= cap`) — whether by slicing an overflowing chunk or
 * by a whole chunk landing exactly on the boundary — not only when a
 * chunk had to be sliced. Treating the exact-boundary case as "complete"
 * would be assuming completeness the read cannot prove, which is the
 * defect this fixes: a long playlist truncated mid-line must not look
 * like a content defect of the channel. The cost is a genuinely-exact
 * `cap`-byte playlist occasionally read as unobservable for one tick;
 * that is the same safe degradation the file already applies to a
 * failed read (review-161-162 M2), and cheaper than a wrong
 * stale/endlist verdict on silently-cut data.
 */
async function readBounded(
	stream: NodeJS.ReadableStream,
	cap: number,
): Promise<{ text: string; truncated: boolean }> {
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;
	for await (const chunk of stream) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		// review-161-162 m9: slice the overflowing chunk — pushing it whole
		// let the cap be exceeded by up to one chunk.
		const room = cap - total;
		const take = buf.length > room ? buf.subarray(0, room) : buf;
		total += take.length;
		chunks.push(take);
		if (total >= cap) {
			truncated = true;
			break;
		}
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/**
 * Pages a single 10 s tick may read before handing the rest of the fleet to
 * the next tick (review-331 I2): 10 × 50 channels, so tick duration stays
 * bounded by a constant rather than by fleet size.
 */
const MAX_PAGES_PER_TICK = 10;

export function createOriginObserver(deps: OriginObserverDeps) {
	const now = deps.now ?? (() => new Date());

	/**
	 * Per-RULE open/resolve (review-161-162 M3/M4): each rule decides with
	 * its OWN threshold and windowPolls — the first cut took one minimum
	 * threshold across every matching rule and opened a channel-scoped CRIT
	 * on a global WARN's number. `decide` returns null to SKIP a rule
	 * entirely (no evidence must neither open nor resolve — M2's inversion
	 * was a failed origin read RESOLVING the very alert it should sustain).
	 */
	async function transition(
		liveChannelId: string,
		metric: AlertMetric,
		context: Record<string, unknown>,
		decide: (rule: {
			id: string;
			threshold: number | null;
			windowPolls: number;
		}) => boolean | null,
	): Promise<void> {
		const rules = await deps.prisma.alertRule.findMany({
			where: {
				enabled: true,
				metric,
				OR: [{ liveChannelId: null }, { liveChannelId }],
			},
			select: { id: true, threshold: true, windowPolls: true },
		});
		for (const rule of rules) {
			const breaching = decide(rule);
			if (breaching === null) {
				continue;
			}
			const open = await deps.prisma.alertEvent.findFirst({
				where: { ruleId: rule.id, liveChannelId, resolvedAt: null },
				select: { id: true },
			});
			if (breaching && !open) {
				try {
					const event = await deps.prisma.alertEvent.create({
						data: {
							ruleId: rule.id,
							liveChannelId,
							openedAt: now(),
							context: context as Prisma.InputJsonValue,
						},
					});
					await deps.emitEvent?.({
						kind: "ALERT_OPENED",
						alertId: event.id,
						liveChannelId,
						rule: metric,
						...METRIC_CLASS[metric],
						path: `/live/${liveChannelId}`,
					});
				} catch (err) {
					// P2002 on the partial unique index — another tick opened it.
					if ((err as { code?: string }).code !== "P2002") {
						throw err;
					}
				}
			} else if (!breaching && open) {
				const { count } = await deps.prisma.alertEvent.updateMany({
					where: { id: open.id, resolvedAt: null },
					data: { resolvedAt: now() },
				});
				if (count > 0) {
					await deps.emitEvent?.({
						kind: "ALERT_RESOLVED",
						alertId: open.id,
						liveChannelId,
						rule: metric,
						...METRIC_CLASS[metric],
						path: `/live/${liveChannelId}`,
					});
				}
			}
		}
	}

	async function observeChannel(channel: {
		id: string;
		plan: unknown;
		lastHeartbeat: unknown;
	}): Promise<void> {
		const run = await deps.prisma.liveChannelRun.findFirst({
			where: { liveChannelId: channel.id },
			orderBy: { seq: "desc" },
			select: {
				id: true,
				seq: true,
				outputPrefix: true,
				originObservation: true,
			},
		});
		if (!run) {
			return;
		}
		const state: OriginObservationState =
			(run.originObservation as OriginObservationState | null) ?? {};
		const nowMs = now().getTime();
		if (state.dueAtMs !== undefined && nowMs < state.dueAtMs) {
			return;
		}
		const effective = effectiveLivePlanForRun(channel.plan, {
			seq: run.seq,
			id: run.id,
			outputPrefix: run.outputPrefix ?? "",
		});
		const persist = async (next: OriginObservationState) => {
			await deps.prisma.liveChannelRun.updateMany({
				where: { id: run.id },
				data: { originObservation: next as Prisma.InputJsonValue },
			});
		};
		if (!effective) {
			await persist({
				lastFetchAtMs: nowMs,
				dueAtMs: nowMs + 60_000,
				unavailableReason: "run output prefix underivable (#155)",
				// review-161-162 M2: unavailability preserves the cursors — a
				// transient failure must not reset every progress epoch.
				playlists: state.playlists ?? {},
				...carryPublish(state),
			});
			return;
		}
		const artefacts = compileExpectedLiveArtefacts(effective);
		const hls = artefacts.manifests.filter(
			(manifest) => manifest.kind === "HLS" && manifest.mediaPlaylists.length,
		);
		if (hls.length === 0) {
			await persist({
				lastFetchAtMs: nowMs,
				dueAtMs: nowMs + 60_000,
				unavailableReason: "no HLS media playlists in the plan",
				playlists: state.playlists ?? {},
				...carryPublish(state),
			});
			return;
		}
		// Cadence: max(min segmentLength, 10s) — per channel, honored via the
		// cursor's due-at (no per-channel timers in this worker).
		// review-161-162 m10: Math.min over an EMPTY array is Infinity, which
		// would persist dueAtMs: Infinity — a silent permanent stall for that
		// channel. Likely unreachable (HLS media playlists imply muxings), so
		// the guard is cheap insurance, not a reachable-arm claim.
		// Expected live muxings exclude post-stop MP4 archives, which have no
		// segment cadence and must not shorten this observer's interval.
		const minSegmentSeconds = artefacts.muxings.length
			? Math.min(...artefacts.muxings.map((m) => m.segmentLengthSec))
			: 6;
		const intervalMs = Math.max(
			minSegmentSeconds * 1000,
			ORIGIN_SWEEP_INTERVAL_MS,
		);

		const outputs = new Map(effective.outputs.map((o) => [o.key, o]));
		const cursors = state.playlists ?? {};
		const nextCursors: Record<string, OriginPlaylistCursor> = {};
		const verdictsByKey: OriginObservationState["lastVerdicts"] = {};
		let anyEndlist = false;
		let maxEdgeDelay: number | null = null;
		/** Worst since-progress across playlists WITH evidence this tick —
		 * per-rule windows apply at transition time (review-161-162 M4). */
		let maxSinceProgressMs: number | null = null;
		// review-161-162 m1: one last-write-wins string hid every reason but
		// the final one on a mixed tick.
		const unavailableReasons: string[] = [];
		/**
		 * Did this tick get far enough to ASK the store for a media playlist
		 * ? A 404 from that ask is the pre-first-publish signal —
		 * the object is not there yet — so "asked and no cursor carries a
		 * segment" is this observer's evidence of absence, not capture readiness.
		 * Never having a reader at all says nothing, and must not.
		 */
		let askedForPlaylist = false;
		/**
		 * Did a playlist come back in a state this tick cannot judge? A body
		 * that hit the 256 KiB cap is INDETERMINATE about first publish in the
		 * loudest possible way: a playlist that big has thousands of segments,
		 * yet the truncation branch below deliberately produces no cursor. Left
		 * in, an observer meeting an hours-old channel for the first time
		 * through a truncated read would incorrectly report AWAITING.
		 */
		let indeterminatePlaylist = false;
		let playlistReadLimitReached = false;

		for (const manifest of hls) {
			const output = outputs.get(manifest.outputKey);
			if (!output) {
				continue;
			}
			let browser: ReturnType<typeof createBrowserForCredential>;
			try {
				const credential = await deps.resolveCredential(output.credentialId);
				browser = createBrowserForCredential(credential as BrowserCredential);
			} catch (err) {
				unavailableReasons.push(
					err instanceof UnsupportedBrowseError
						? `origin not driver-readable: ${err.message}`
						: // C20: the vendor/driver message never persists — the class
							// and status carry the operator signal; the full text goes
							// to the worker log only (review-161-162 B1).
							`credential resolution failed: ${storageErrorText(err)}`,
				);
				continue;
			}
			if (!browser.getObject) {
				unavailableReasons.push("storage driver has no object-read capability");
				continue;
			}
			// The output union spells its container differently per provider
			// (bucket vs container); SFTP has neither and is already refused
			// by the driver factory above.
			const bucket =
				"bucket" in output
					? output.bucket
					: "container" in output
						? output.container
						: null;
			if (bucket === null) {
				unavailableReasons.push(`output ${output.key} has no bucket/container`);
				continue;
			}
			for (const playlist of manifest.mediaPlaylists) {
				const key = `${manifest.dir.prefix}${playlist}`;
				try {
					// Before the await, not after: "we asked" is true whether the
					// object comes back, 404s, or the connection fails (#253).
					askedForPlaylist = true;
					const stream = await browser.getObject({
						bucket,
						key,
						range: { start: 0, end: MAX_PLAYLIST_BYTES - 1 },
					});
					const { text, truncated } = await readBounded(
						stream,
						MAX_PLAYLIST_BYTES,
					);
					if (truncated) {
						playlistReadLimitReached = true;
						// MODERATE-1 (audit 2026-08-29 §9): mirror the failed-read catch
						// below — log for the operator, record an UNOBSERVABLE reason,
						// keep the previous cursor (no evidence this tick), and skip
						// parse/evaluate rather than judge stale/endlist on a playlist
						// we know is incomplete.
						console.error(
							`[origin] playlist truncated (${key}): reached the ${MAX_PLAYLIST_BYTES}-byte cap`,
						);
						unavailableReasons.push(
							`playlist truncated (${key}): ${PLAYLIST_TRUNCATED_REASON}`,
						);
						indeterminatePlaylist = true;
						const previous = cursors[key];
						if (previous) {
							nextCursors[key] = previous;
						}
						continue;
					}
					const parsed = parseMediaPlaylist(text);
					const verdict = evaluateOriginPlaylist({
						parsed,
						cursor: cursors[key] ?? null,
						nowMs,
						intervalMs,
						// review-161-162 NIT 1: this DEFAULT window (2) drives the
						// panel's STALE badge — "is it advancing right now". The
						// ALERT decision uses each RULE's own windowPolls at
						// transition time (M4), so a rule at windowPolls:20 opens
						// later than the badge reddens. Two questions, two
						// windows, on purpose.
						// The rule's own windowPolls applies at transition time;
						// the cursor-level staleness uses the DEFAULT window (2)
						// as the evidence floor.
						windowPolls: 2,
					});
					nextCursors[key] = verdict.nextCursor;
					verdictsByKey[key] = {
						stale: verdict.stale,
						endlist: verdict.endlist,
						edgeDelaySeconds: verdict.edgeDelaySeconds,
					};
					maxSinceProgressMs = Math.max(
						maxSinceProgressMs ?? 0,
						verdict.sinceProgressMs,
					);
					anyEndlist = anyEndlist || verdict.endlist;
					if (verdict.edgeDelaySeconds !== null) {
						maxEdgeDelay = Math.max(
							maxEdgeDelay ?? 0,
							verdict.edgeDelaySeconds,
						);
					}
				} catch (err) {
					// C20 (review-161-162 B1): a raw driver message here rendered
					// ENOTFOUND/ECONNREFUSED hostnames on the channel page — a
					// network-probe oracle. Full text to the worker log only.
					console.error(
						`[origin] playlist read failed (${key}):`,
						err instanceof Error ? err.message : err,
					);
					unavailableReasons.push(
						`playlist read failed (${key}): ${storageErrorText(err)}`,
					);
					// review-161-162 M2: a failed READ is not evidence — keep the
					// playlist's previous cursor (its progress epoch survives the
					// outage) and let the alert rules SKIP rather than resolve.
					const previous = cursors[key];
					if (previous) {
						nextCursors[key] = previous;
					}
				}
			}
		}

		// m1: every reason survives the tick, capped for the persisted column.
		const unavailableReason =
			unavailableReasons.length === 0
				? undefined
				: unavailableReasons.length <= 3
					? unavailableReasons.join("; ")
					: `${unavailableReasons.slice(0, 3).join("; ")}; +${unavailableReasons.length - 3} more`;
		/**
		 * FIRST PUBLISH . A cursor with `segmentCount > 0` is the
		 * observer's witness that the origin has published — the playlist names
		 * a segment, and Bitmovin writes the segment before the line that
		 * references it. `nextCursors` (not the parsed verdicts) is the right
		 * population: it also carries a previous tick's cursor forward across a
		 * failed read, so one unreadable tick cannot un-publish the run.
		 */
		const published =
			state.publish === "PUBLISHED" ||
			Object.values(nextCursors).some((cursor) => cursor.segmentCount > 0);
		const publish: OriginPublishState | undefined = published
			? "PUBLISHED"
			: askedForPlaylist && !indeterminatePlaylist
				? "AWAITING"
				: undefined;
		await persist({
			lastFetchAtMs: nowMs,
			dueAtMs: nowMs + intervalMs,
			...(unavailableReason ? { unavailableReason } : {}),
			...(playlistReadLimitReached
				? { playlistReadLimitReached: true as const }
				: {}),
			playlists: nextCursors,
			lastVerdicts: verdictsByKey,
			...(publish ? { publish } : {}),
		});

		// Three-way discriminator, third arm : origin stale × ingest
		// DISCONNECTED ⇒ INPUT_DISCONNECTED owns it — suppress the origin
		// alert as a duplicate rather than double-paging the operator.
		const heartbeat = channel.lastHeartbeat as {
			raw?: { ingest?: { status?: string } };
		} | null;
		const ingestDisconnected =
			heartbeat?.raw?.ingest?.status !== undefined &&
			heartbeat.raw.ingest.status !== "CONNECTED";
		/** Evidence gate (M2): at least one playlist actually read this tick.
		 * Without it, every rule SKIPS — an unobservable origin neither opens
		 * nor resolves anything. */
		const hadEvidence = maxSinceProgressMs !== null;

		// Bitmovin-side witness for the alert context (§3's first two arms):
		// is the encoder's own output block advancing? Two most recent
		// heartbeats' newest latestMediaPresentationTime, compared.
		let bitmovinOutputAdvancing: boolean | null = null;
		const lastTwo = await deps.prisma.liveHeartbeat.findMany({
			where: { liveChannelId: channel.id },
			orderBy: { at: "desc" },
			take: 2,
			select: { raw: true },
		});
		if (lastTwo.length === 2) {
			const newest = presentationTimeOf(lastTwo[0]?.raw);
			const previous = presentationTimeOf(lastTwo[1]?.raw);
			if (newest !== null && previous !== null) {
				bitmovinOutputAdvancing = newest > previous;
			}
		}
		const context = {
			verdicts: verdictsByKey,
			bitmovinOutputAdvancing,
			...(ingestDisconnected ? { suppressedBy: "INPUT_DISCONNECTED" } : {}),
		};

		// M4: the rule's OWN windowPolls decides staleness at transition time
		// (the first cut passed a literal 2 while the settings panel offered
		// the field for every metric — a named slot, unfilled).
		await transition(channel.id, "ORIGIN_MANIFEST_STALE", context, (rule) => {
			if (!hadEvidence || maxSinceProgressMs === null) {
				return null;
			}
			const breaching = maxSinceProgressMs > rule.windowPolls * intervalMs;
			return breaching && !ingestDisconnected;
		});
		await transition(channel.id, "ORIGIN_ENDLIST_PRESENT", context, () =>
			hadEvidence ? anyEndlist : null,
		);
		// M3: each edge-delay rule judges against its OWN threshold — the
		// first cut took the MINIMUM across all rules and opened a
		// channel-scoped CRIT on a global WARN's number; and a tick with no
		// PDT evidence SKIPS instead of never-resolving.
		await transition(
			channel.id,
			"ORIGIN_EDGE_DELAY_ABOVE",
			{ ...context, edgeDelaySeconds: maxEdgeDelay },
			(rule) =>
				maxEdgeDelay === null || rule.threshold === null
					? null
					: maxEdgeDelay > rule.threshold,
		);
	}

	/**
	 * Where the NEXT tick resumes when this one hit its page budget — a
	 * closure value, not a column: the observer is one long-lived sweep per
	 * worker, and a restart simply starts the fleet over.
	 */
	let resumeAfterId: string | undefined;
	return async function sweep(): Promise<{
		observed: number;
		failed: number;
		total: number;
		/** Set when the tick stopped at its page budget; the next tick continues here. */
		resumeAfter?: string;
	}> {
		// EVERY running channel, read in pages (paid audit
		// MODERATE-15): a single `take: 50` silently left the 51st running
		// channel unobserved — no alert could ever open for it, and nothing
		// said so.
		//
		// Keyset, not offset (review-331 I2): `skip` re-counts from the top on
		// every page, so a channel that stops between two pages shifts every
		// later one down a slot and the channel at the new boundary is skipped
		// — the same gap, intermittent. `id > last` cannot skip anything: ids
		// are immutable and the order is by id.
		const PAGE = 50;
		let failed = 0;
		let total = 0;
		let pages = 0;
		let after = resumeAfterId;
		for (;;) {
			const channels = await deps.prisma.liveChannel.findMany({
				where: {
					status: "RUNNING",
					// Probes are excluded: they stop seconds after RUNNING and their
					// synthetic output would only add observer noise.
					purpose: null,
					...(after ? { id: { gt: after } } : {}),
				},
				select: { id: true, plan: true, lastHeartbeat: true },
				orderBy: { id: "asc" },
				take: PAGE,
			});
			total += channels.length;
			pages += 1;
			for (const channel of channels) {
				try {
					await observeChannel(channel);
				} catch (err) {
					failed += 1;
					console.error(
						`origin observation failed for ${channel.id}:`,
						err instanceof Error ? err.message : err,
					);
				}
			}
			const last = channels[channels.length - 1];
			if (channels.length < PAGE || !last) {
				resumeAfterId = undefined;
				break;
			}
			after = last.id;
			// A tick is bounded (review-331 I2): MAX_PAGES_PER_TICK pages of
			// sequential network reads, then the NEXT tick resumes from here —
			// instead of one tick running for as long as the fleet is large
			// and starving every 10 s tick queued behind the in-flight latch.
			if (pages >= MAX_PAGES_PER_TICK) {
				resumeAfterId = after;
				break;
			}
		}
		return {
			observed: total - failed,
			failed,
			total,
			...(resumeAfterId ? { resumeAfter: resumeAfterId } : {}),
		};
	};
}

function presentationTimeOf(raw: unknown): string | null {
	const updates = (
		raw as {
			output?: {
				manifests?: {
					hls?: Array<{
						manifestUpdates?: Array<{
							latestMediaPresentationTime?: string;
						}>;
					}>;
				};
			};
		}
	)?.output?.manifests?.hls?.[0]?.manifestUpdates;
	// PR0 measured: manifestUpdates is NEWEST-FIRST — entry[0] is the edge.
	const value = updates?.[0]?.latestMediaPresentationTime;
	return typeof value === "string" ? value : null;
}
