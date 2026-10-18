import { z } from "zod";

/**
 * Program-slot scheduling at CHANNEL CREATION .
 *
 * The operator's mental model is a broadcast slot, not three rows: "the
 * program runs 21:00–22:00, the stream comes up at 20:45, and a slate covers
 * it until air" (slate insertion). This module is that slot as a contract — the wizard
 * submits ONE object, the server derives the LiveSchedule rows from it, and
 * both ends agree on the derivation because it lives here.
 *
 * Two mechanism changes ride with it, both forced by reality rather than
 * taste:
 *
 *  - The slate's DURATION cannot be fixed at arm time. START fires at
 *    streamUpAt but the channel takes minutes to provision, so the slate
 *    actually fires late — and a fixed duration computed from streamUpAt
 *    would then overrun INTO the program it exists to protect. Rows created
 *    here carry `slateUntil` (= programStartAt) instead, and the sweep
 *    computes the duration AT FIRE TIME.
 *
 *  - The slate's content cannot be registered at creation. Insertable
 *    content is a per-ENCODING resource ("content ids die with their
 *    encoding" — the arm route's own words), and at creation there is no
 *    encoding. Rows carry the SOURCE (`slateSource`), and the worker
 *    registers it once the channel is RUNNING, claimed via
 *    `contentClaimedAt` so two sweep ticks cannot register twice.
 */

/**
 * Where the slate clip lives — the feeder's source shape, deliberately: the
 * app only ever LISTS customer buckets, and the picker hands back exactly
 * this triple.
 */
export const slateSourceSchema = z.strictObject({
	credentialId: z.uuid(),
	bucket: z.string().min(1).max(255),
	key: z.string().min(1).max(2048),
});
export type SlateSource = z.infer<typeof slateSourceSchema>;

/**
 *  — WHICH BYTES, not just which key (audit 2026-08-29 HIGH-4).
 *
 * `slateSourceSchema` names a LOCATION, and a location is not a version: an
 * object replaced under the same key between arm and air aired content the
 * operator never chose, and nothing on the row could tell the two apart.
 * This is the provider's own name for one version of those bytes, captured by
 * `headObject` when the row is armed and demanded when the feeder downloads.
 *
 * Mirrors `ObjectVersion & { size }` from `@bitovp/storage` rather than
 * importing it — core is dependency-free by design, and this shape crosses a
 * DB column and a queue payload, so it needs its own zod parse either way.
 * Every selector is optional because the providers genuinely disagree about
 * which they have (etag: S3 + Azure; versionId: S3/Azure on a versioned
 * bucket; generation: GCS only) and a required field would force a driver to
 * invent one. `size` is required: every driver reports it, and it is the one
 * check that works even where the version expectation is inexpressible.
 *
 * Values are VERBATIM, never normalized — S3 returns quoted ETags and expects
 * the same quoted form back in `If-Match`, so stripping the quotes on capture
 * would be a silent always-mismatch: failing closed, but for the wrong reason.
 */
export const sourceIdentitySchema = z.strictObject({
	etag: z.string().min(1).max(512).optional(),
	versionId: z.string().min(1).max(1024).optional(),
	generation: z.string().min(1).max(64).optional(),
	size: z.number().int().nonnegative(),
});
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

/**
 * A feeder row's source WITH its seal. Separate from `slateSourceSchema`
 * because that one is `strictObject` and is also the wire shape a slate
 * registration parses: widening it would let a slate be armed with an
 * identity nothing ever checks (a named slot nobody fills), and narrowing the
 * feeder to it would make every sealed row fail its own parse and land ERROR.
 *
 * `identity` is optional and stays optional: rows armed before this existed
 * carry none, and a provider whose driver has no `headObject` cannot produce
 * one. Absent means "nothing to demand" — the pre-seal behaviour, named.
 */
export const sealedFeederSourceSchema = slateSourceSchema.extend({
	identity: sourceIdentitySchema.optional(),
});
export type SealedFeederSource = z.infer<typeof sealedFeederSourceSchema>;

/**
 * The storage drivers slate registration can turn into a Bitmovin input
 * (worker `slate-register.ts`'s provider table). ONE list, three consumers:
 * the wizard's picker offers exactly these, the creation route refuses any
 * other at 422, and the worker's default case is the backstop — so a form
 * choice can never become a scheduled failure (review-223 F4).
 */
export const SLATE_SUPPORTED_PROVIDERS = [
	"AWS_S3",
	"GENERIC_S3",
	"AKAMAI_OBJECT_STORAGE",
	"OCI_OBJECT_STORAGE",
	"GCS_HMAC",
	"AZURE_BLOB",
] as const;

export function isSlateSupportedProvider(provider: string): boolean {
	return (SLATE_SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The storage drivers the FEEDER can download a source from
 * (`createBrowserForCredential` + `getObject` — everything else throws
 * UnsupportedBrowseError). One list, three consumers (review-226 I2, the
 * same discipline as SLATE_SUPPORTED_PROVIDERS): the wizard's pickers, the
 * creation route's 422, and row 96's record. Note it is a SUPERSET of the
 * slate list (adds GCS_SERVICE_ACCOUNT): a slate that rides the feeder
 * chain is checked against THIS set, a splice slate against the other.
 */
export const FEEDER_SUPPORTED_PROVIDERS = [
	"AWS_S3",
	"GENERIC_S3",
	"AKAMAI_OBJECT_STORAGE",
	"OCI_OBJECT_STORAGE",
	"GCS_HMAC",
	"GCS_SERVICE_ACCOUNT",
	"AZURE_BLOB",
] as const;

export function isFeederSupportedProvider(provider: string): boolean {
	return (FEEDER_SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

/** How far ahead a slot may be armed. Catches year-typos, not planning. */
export const PROGRAM_SCHEDULE_HORIZON_DAYS = 30;

/**
 * Auto-derived runaway cap: the program's own span plus this margin. The STOP
 * row is the intended end; `maxRunMinutes` is the backstop for the day the
 * sweep is down — a scheduled channel must never be able to bill unbounded
 * .
 */
export const MAX_RUN_CAP_MARGIN_MINUTES = 30;

/**
 * A slate window shorter than this at fire time is refused as "program
 * already started" — inserting a 2-second slate at air time is worse than
 * inserting nothing.
 */
export const MIN_SLATE_FIRE_SECONDS = 5;

export const liveProgramScheduleSchema = z
	.strictObject({
		/** When the channel provisions (START row). */
		streamUpAt: z.iso.datetime(),
		/** When the program begins — the slate, if any, covers until here. */
		programStartAt: z.iso.datetime(),
		/** When the channel stops (STOP row). */
		programEndAt: z.iso.datetime(),
		/** slate insertion: cover [streamUpAt → programStartAt] with this clip. */
		slate: z
			.strictObject({
				source: slateSourceSchema,
			})
			.optional(),
		/**
		 * : the PROGRAM itself is a file the platform should feed
		 * (pseudo-live) from programStartAt. With this set, the slate is
		 * realised as a FEEDER too (loop the slate clip from stream-up, switch
		 * to the program at air) — no insertable-content splice at all, which
		 * is the right tool when no external ingest exists (#95's incident:
		 * a splice needs an already-flowing input).
		 */
		programFeed: z
			.strictObject({
				source: slateSourceSchema,
			})
			.optional(),
	})
	.superRefine((value, ctx) => {
		const up = Date.parse(value.streamUpAt);
		const start = Date.parse(value.programStartAt);
		const end = Date.parse(value.programEndAt);
		if (up > start) {
			ctx.addIssue({
				code: "custom",
				path: ["streamUpAt"],
				message: "streamUpAt must not be after programStartAt",
			});
		}
		if (start >= end) {
			ctx.addIssue({
				code: "custom",
				path: ["programEndAt"],
				message: "programEndAt must be after programStartAt",
			});
		}
		if (value.slate && up >= start) {
			// A slate with a zero-length window is a misconfiguration, not a
			// degenerate success: the operator asked for cover and gets none.
			ctx.addIssue({
				code: "custom",
				path: ["slate"],
				message: "A slate needs streamUpAt strictly before programStartAt",
			});
		}
		if (value.programFeed && !value.slate && up < start) {
			// : a file-fed program with a pre-air window and no slate
			// means the platform has NOTHING to feed before air — the encoder
			// would sit unbound exactly like #95's incident. Either add a
			// slate (it becomes the pre-air feed) or set streamUpAt = air.
			ctx.addIssue({
				code: "custom",
				path: ["programFeed"],
				message:
					"A file-fed program with a pre-air window needs a slate — there is nothing to feed between stream-up and air",
			});
		}
	});
export type LiveProgramSchedule = z.infer<typeof liveProgramScheduleSchema>;

/** One derived LiveSchedule row (before Prisma adds ids/status). */
export type DerivedScheduleRow = {
	action: LiveScheduleAction;
	fireAt: Date;
	slateSource?: SlateSource;
	/**
	 * The row's USEFUL-UNTIL bound. For SLATE_IN it is the fire-time duration
	 * source; for FEEDER rows (#96) it is the deadline past which firing is
	 * pointless (a pre-air feeder after air, a program feeder after end) —
	 * the same F2 window machinery reads it for all three.
	 */
	slateUntil?: Date;
	/**
	 * : the file this FEEDER row pushes (feeders always loop).
	 * : the creation route seals the object's version onto it before
	 * the row is written — derivation is pure, so the seal is captured by the
	 * caller that holds the credential, not here.
	 */
	feederSource?: SealedFeederSource;
};

export type DerivedProgramSchedule = {
	rows: DerivedScheduleRow[];
	programStartAt: Date;
	programEndAt: Date;
	/** ceil(span) + MAX_RUN_CAP_MARGIN_MINUTES — see the constant. */
	maxRunMinutes: number;
};

/**
 * Time-window checks that need a clock, split from the schema so the schema
 * stays deterministic for tests. Returns translated-key-free English detail;
 * the route maps these to its own 422s.
 */
export function programScheduleWindowError(
	schedule: LiveProgramSchedule,
	now: Date,
): string | null {
	const up = Date.parse(schedule.streamUpAt);
	if (up <= now.getTime()) {
		return "streamUpAt must be in the future";
	}
	const horizonMs = PROGRAM_SCHEDULE_HORIZON_DAYS * 24 * 60 * 60_000;
	if (Date.parse(schedule.programEndAt) - now.getTime() > horizonMs) {
		return `the slot ends more than ${PROGRAM_SCHEDULE_HORIZON_DAYS} days out — likely a date typo`;
	}
	return null;
}

/**
 * Derive schedule rows and channel columns from a validated program slot.
 * Provisioning begins at channel creation, so no START row is derived.
 * streamUpAt anchors slate and feeder actions. The runtime cap starts from
 * provisioning time and ends after programEndAt plus the configured margin.
 */
export function deriveProgramSchedule(
	schedule: LiveProgramSchedule,
	opts: { provisionAtMs: number },
): DerivedProgramSchedule {
	const streamUpAt = new Date(schedule.streamUpAt);
	const programStartAt = new Date(schedule.programStartAt);
	const programEndAt = new Date(schedule.programEndAt);

	const rows: DerivedScheduleRow[] = [];
	if (schedule.programFeed) {
		//  — the fully file-fed chain: the slate (if any) IS the
		// pre-air feed, and the program arrives by switching the feeder. No
		// insertable-content splice: with no external ingest there is no
		// flowing input to splice over (#95), and feeding the program early
		// would burn its opening minutes under the cover.
		if (schedule.slate) {
			rows.push({
				action: "FEEDER_START",
				fireAt: streamUpAt,
				feederSource: schedule.slate.source,
				slateUntil: programStartAt,
			});
		}
		rows.push({
			action: "FEEDER_SWITCH",
			fireAt: programStartAt,
			feederSource: schedule.programFeed.source,
			slateUntil: programEndAt,
		});
	} else if (schedule.slate) {
		rows.push({
			action: "SLATE_IN",
			// Armed AT stream-up: the sweep holds it (channel not RUNNING /
			// content not READY yet) inside the ordinary grace, then fires
			// with duration computed against slateUntil.
			fireAt: streamUpAt,
			slateSource: schedule.slate.source,
			slateUntil: programStartAt,
		});
	}
	rows.push({ action: "STOP", fireAt: programEndAt });

	const spanMinutes = Math.ceil(
		(programEndAt.getTime() - opts.provisionAtMs) / 60_000,
	);
	return {
		rows,
		programStartAt,
		programEndAt,
		maxRunMinutes: spanMinutes + MAX_RUN_CAP_MARGIN_MINUTES,
	};
}

/**
 * How long past `fireAt` the sweep still fires a start-like row before marking
 * it MISSED. The worker owns the runtime value (`SCHEDULE_START_GRACE_MINUTES`
 * may override it); core owns the DEFAULT so the web layer can reason about
 * "is this row overdue?" without re-typing the number — review-234 I2 caught a
 * bare `(10 * 60 + 30) * 1000` in the page, the same duplicated-constant class
 * #104 had just removed for the VMAF model.
 */
export const DEFAULT_SCHEDULE_START_GRACE_MINUTES = 10;

/**
 * The actions that can bring a channel UP. Only these justify telling an
 * operator "the schedule will act" on a channel that is not running: the sweep
 * refuses SLATE_IN and FEEDER_* unless the channel is ALREADY RUNNING (a slate
 * cuts into a running program; a feeder pushes at a live ingest), so an armed
 * one on a stopped channel starts nothing and goes MISSED at its deadline.
 * review-234 I1 measured that residual after the first C1 fix.
 */
export const CHANNEL_STARTING_SCHEDULE_ACTIONS = ["START"] as const;

/**
 * Every schedule action, named in core so a caller can be TOTAL over them.
 * The union was written inline here and separately as `LIVE_SCHEDULE_ACTIONS`
 * in the web layer — the same fork the channel-status enum had, and the reason
 * a table meant to cover "every action" could silently cover four of five.
 * Pinned against the web list in `program-schedule.test.ts`.
 */
export const LIVE_SCHEDULE_ACTION_VALUES = [
	"START",
	"STOP",
	"SLATE_IN",
	"FEEDER_START",
	"FEEDER_SWITCH",
] as const;
export type LiveScheduleAction = (typeof LIVE_SCHEDULE_ACTION_VALUES)[number];
