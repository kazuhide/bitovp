import type { MessageKey } from "@/lib/i18n";
import type {
	LiveScheduleActionKind,
	LiveScheduleOutcomeKind,
	LiveScheduleStatusKind,
} from "@/lib/live-runtime/schemas";

/* One exhaustive schedule-action label map is shared by the next-event header and schedule list, preventing raw enums or inconsistent translations when an action kind is added. */
export const SCHEDULE_ACTION_LABEL_KEYS = {
	START: "schedule.actionStart",
	STOP: "schedule.actionStop",
	SLATE_IN: "schedule.actionSlate",
	//  — the feeder-chain rows (created at scheduling time; the
	// manual arm form deliberately stays START/STOP/SLATE_IN).
	FEEDER_START: "schedule.actionFeederStart",
	FEEDER_SWITCH: "schedule.actionFeederSwitch",
} as const satisfies Record<LiveScheduleActionKind, MessageKey>;

/** Shared primary labels for every schedule status shown to an operator. */
export const SCHEDULE_STATUS_LABEL_KEYS = {
	ARMED: "schedule.statusArmed",
	FIRED: "schedule.statusFired",
	COMPLETED: "schedule.statusCompleted",
	CANCELED: "schedule.statusCanceled",
	MISSED: "schedule.statusMissed",
	ERROR: "schedule.statusError",
	SKIPPED_STALE_GENERATION: "schedule.statusSkippedStaleGeneration",
} as const satisfies Record<LiveScheduleStatusKind, MessageKey>;

/** Shared outcome sentences; delivery and request status must never drift. */
export const SCHEDULE_OUTCOME_LABEL_KEYS = {
	PENDING: "schedule.outcomePending",
	PROCESS_PUSHING: "schedule.outcomePushing",
	INGEST_CONNECTED: "schedule.outcomeIngestConnected",
	SLATE_ARMED: "schedule.outcomeSlateArmed",
	DELIVERED: "schedule.outcomeDelivered",
	FAILED: "schedule.outcomeFailed",
	UNKNOWN: "schedule.outcomeUnknown",
} as const satisfies Record<LiveScheduleOutcomeKind, MessageKey>;
