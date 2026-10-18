import { ApiError } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/context";

/**
 * Stable, locale-independent reasons that customer-facing API routes return in
 * `details.code`. The top-level `error` remains an English diagnostic for logs
 * and API clients; browser UI must render catalogue copy from this code.
 */
export const CUSTOMER_ERROR_CODES = [
	"AUTH_NOT_CONFIGURED",
	"AUTH_PROVIDER_UNAVAILABLE",
	"AUTH_INVALID_CREDENTIALS",
	"AUTH_PASSWORD_EXPIRED",
	"AUTH_RATE_LIMITED",
	"AUTH_BUSY",
	"AUTH_PASSWORD_REQUIRED",
	"AUTH_EMAIL_REQUIRED",
	"AUTH_CREDENTIALS_CHANGED",
	"AUTH_PASSWORD_CHANGE_REQUIRED",
	"AUTH_MODE_UNSUPPORTED",
	"AUTH_SETUP_REQUIRED",
	"TENANT_IP_DENIED",
	"TENANT_CHANGED",
	"TENANT_MEMBERSHIP_REQUIRED",
	"TENANT_IP_INVALID",
	"STORAGE_ENDPOINT_NOT_ALLOWED",
	"STORAGE_BROWSE_UNSUPPORTED",
	"RESET_CLEANUP_UNCONFIRMED",
	"RESET_PROVIDER_RESOURCES_UNCONFIRMED",
	"RESET_LOCAL_WORK_ACTIVE",
	"RESET_ACTIVE_WORK",
	"RESET_STATE_CHANGED",
	"RESET_AISA_SNAPSHOT_REQUIRED",
	"LIVE_ACTION_NOT_STARTABLE",
	"LIVE_ACTION_RUN_ALREADY_ACTIVE",
	"LIVE_ACTION_NOT_STOPPABLE",
	"LIVE_ACTION_STOP_HANDOFF_MISSING",
	"LIVE_ACTION_STOP_HANDOFF_COMPLETE",
	"LIVE_ACTION_NOT_RESTARTABLE",
	"LIVE_ACTION_RESTART_REQUIRES_NEW_RUN",
	"LIVE_ACTION_STATE_CHANGED",
	"LIVE_ACTION_NO_ENCODING",
	"LIVE_ACTION_CURRENT_RUN_MISSING",
	"LIVE_ACTION_PROVIDER_ENCODING_MISSING",
	"LIVE_ACTION_PROVIDER_TRANSITIONAL",
	"LIVE_ACTION_PROVIDER_UNOBSERVED",
	"LIVE_ACTION_PROVIDER_UNKNOWN",
	"LIVE_ACTION_PROVIDER_TERMINAL",
	"LIVE_ACTION_DEPLOYMENT_RESTRICTED",
	"LIVE_ACTION_TIMESHIFT_REQUIRES_RUNNING",
	"LIVE_ACTION_CUE_REQUIRES_RUNNING",
	"LIVE_ACTION_REQUEST_CONFLICT",
	"LIVE_ACTION_REQUEST_AMBIGUOUS",
	"LIVE_ACTION_REQUEST_IN_PROGRESS",
	"LIVE_RUNTIME_ACCOUNT_MISSING",
	"LIVE_RUNTIME_ACCOUNT_MISMATCH",
	"LIVE_RUNTIME_REQUIRES_RUNNING",
	"LIVE_RUNTIME_INGEST_NOT_CONNECTED",
	"LIVE_RUNTIME_ENCODING_UNAVAILABLE",
	"LIVE_RUNTIME_ACCOUNT_UNAVAILABLE",
	"LIVE_VMAF_NOT_RUNNING",
	"LIVE_VMAF_OUTPUT_UNREADABLE",
	"LIVE_VMAF_FEEDER_REQUIRED",
	"LIVE_VMAF_FIRST_SEGMENT_PENDING",
	"LIVE_VMAF_READINESS_UNOBSERVABLE",
	"LIVE_CHANNEL_STOP_BEFORE_DELETE",
	"LIVE_CHANNEL_VMAF_IN_PROGRESS",
	"LIVE_CHANNEL_STATE_CHANGED",
	"LIVE_CHANNEL_RUNTIME_CAP_BEFORE_PROGRAM_END",
	"FEEDER_LIMIT_REACHED",
	"FEEDER_CHANNEL_OCCUPIED",
	"FEEDER_SWITCH_REQUIRES_ACTIVE",
	"FEEDER_CHANNEL_NOT_READY",
	"FEEDER_RUN_MISSING",
	"FEEDER_STOP_NOT_NEEDED",
	"FEEDER_STOP_BEFORE_DELETE",
	"FEEDER_SHUTDOWN_PENDING",
	"FEEDER_STATE_CHANGED",
	"FEEDER_CHANNEL_NOT_FOUND",
	"FEEDER_SOURCE_CREDENTIAL_MISSING",
	"FEEDER_SRT_CREDENTIAL_INVALID",
	"FEEDER_SOURCE_UNREADABLE",
	"SCHEDULE_LEAD_TIME_TOO_SHORT",
	"SCHEDULE_FIRE_TIME_NOT_FUTURE",
	"SCHEDULE_OUTSIDE_RUN_WINDOW",
	"SCHEDULE_CONTENT_NOT_FOUND",
	"SCHEDULE_CONTENT_NOT_READY",
	"SCHEDULE_NOT_CANCELLABLE",
	"CONTENT_REQUEST_CONFLICT",
	"CONTENT_STATE_CHANGED",
	"CONTENT_REQUEST_BLOCKED",
	"CONTENT_INSERT_NOT_ACTIVE",
	"CONTENT_RESERVATION_NOT_CANCELLABLE",
	"SLATE_INCOMPATIBLE",
	"SLATE_UNSUPPORTED_IMAGE",
	"SLATE_UNINSPECTED",
	"SLATE_SOURCE_UNSUPPORTED",
	"ALERT_CHANNEL_NOT_FOUND",
	"ALERT_ALREADY_RESOLVED",
] as const;

export type CustomerErrorCode = (typeof CUSTOMER_ERROR_CODES)[number];
const CUSTOMER_ERROR_CODE_SET = new Set<string>(CUSTOMER_ERROR_CODES);

export type CustomerErrorDetails = Readonly<
	{ code: CustomerErrorCode } & Record<string, unknown>
>;

export function customerErrorDetails(
	code: CustomerErrorCode,
	details: Readonly<Record<string, string | number | boolean | null>> = {},
): CustomerErrorDetails {
	return { ...details, code };
}

function detailsOf(error: unknown): Record<string, unknown> | undefined {
	if (
		!(error instanceof ApiError) ||
		typeof error.details !== "object" ||
		error.details === null ||
		Array.isArray(error.details)
	) {
		return undefined;
	}
	return error.details as Record<string, unknown>;
}

/**
 * The structured per-attribute differences a 422 `SLATE_INCOMPATIBLE` carries
 * (C36). STRUCTURED DATA, not prose: every `attribute` is one of the core
 * comparison table's own names and the two values are measured AV tokens
 * (`30/1`, `48000 Hz`), the same vocabulary the feeder's `differences` param
 * already renders verbatim. Anything else in `details` — including any
 * provider sentence — is dropped here, which is what lets the panel render
 * the list beside catalogue copy without ever showing the route's prose.
 */
export function slateDifferencesOf(error: unknown): {
	attribute: string;
	reference: string;
	candidate: string;
	blocking: boolean;
}[] {
	const code = apiCustomerErrorCode(error);
	if (code !== "SLATE_INCOMPATIBLE" && code !== "SLATE_UNSUPPORTED_IMAGE") {
		return [];
	}
	const raw = detailsOf(error)?.differences;
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: {
		attribute: string;
		reference: string;
		candidate: string;
		blocking: boolean;
	}[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) {
			continue;
		}
		const d = item as Record<string, unknown>;
		if (
			typeof d.attribute === "string" &&
			typeof d.reference === "string" &&
			typeof d.candidate === "string"
		) {
			out.push({
				attribute: d.attribute.slice(0, 64),
				reference: d.reference.slice(0, 64),
				candidate: d.candidate.slice(0, 64),
				blocking: d.blocking === true,
			});
		}
	}
	return out;
}

export function apiCustomerErrorCode(
	error: unknown,
): CustomerErrorCode | undefined {
	const code = detailsOf(error)?.code;
	return typeof code === "string" && CUSTOMER_ERROR_CODE_SET.has(code)
		? (code as CustomerErrorCode)
		: undefined;
}

/** Only controlled identifiers/state words are interpolated into customer UI. */
function safeDetail(
	details: Record<string, unknown> | undefined,
	key: string,
	fallback: string,
): string {
	const value = details?.[key];
	if (typeof value !== "string" && typeof value !== "number") {
		return fallback;
	}
	return String(value)
		.replace(/\p{Cc}/gu, " ")
		.slice(0, 160);
}

/**
 * Map a structured API failure to locale-owned customer copy. Unknown and
 * unstructured failures deliberately use the caller's generic key; raw API or
 * provider prose never becomes the normal browser error state.
 */
export function localizedCustomerError(
	t: Translator,
	error: unknown,
	fallbackKey: MessageKey,
): string {
	const code = apiCustomerErrorCode(error);
	const details = detailsOf(error);
	const status = safeDetail(details, "status", t("common.unknown"));
	if (!code) {
		return t(fallbackKey);
	}
	switch (code) {
		case "AUTH_NOT_CONFIGURED":
			return t("customerError.authNotConfigured");
		case "AUTH_PROVIDER_UNAVAILABLE":
			return t("customerError.authProviderUnavailable");
		case "AUTH_INVALID_CREDENTIALS":
			return t("customerError.authInvalidCredentials");
		case "AUTH_PASSWORD_EXPIRED":
			return t("customerError.authPasswordExpired");
		case "AUTH_RATE_LIMITED":
			return t("customerError.authRateLimited");
		case "AUTH_BUSY":
			return t("customerError.authBusy");
		case "AUTH_PASSWORD_REQUIRED":
			return t("customerError.authPasswordRequired");
		case "AUTH_EMAIL_REQUIRED":
			return t("customerError.authEmailRequired");
		case "AUTH_CREDENTIALS_CHANGED":
			return t("customerError.authCredentialsChanged");
		case "AUTH_PASSWORD_CHANGE_REQUIRED":
			return t("rotate.subtitle");
		case "AUTH_MODE_UNSUPPORTED":
			return t("customerError.authModeUnsupported");
		case "AUTH_SETUP_REQUIRED":
			return t("customerError.authSetupRequired");
		case "TENANT_IP_DENIED":
			return t("customerError.tenantIpDenied");
		case "TENANT_CHANGED":
			return t("customerError.tenantChanged");
		case "TENANT_MEMBERSHIP_REQUIRED":
			return t("customerError.tenantMembershipRequired");
		case "TENANT_IP_INVALID":
			return t("customerError.tenantIpInvalid");
		case "STORAGE_ENDPOINT_NOT_ALLOWED":
			return t("customerError.storageEndpointNotAllowed");
		case "STORAGE_BROWSE_UNSUPPORTED":
			return t("customerError.storageBrowseUnsupported");
		case "RESET_CLEANUP_UNCONFIRMED":
			return t("customerError.resetCleanupUnconfirmed");
		case "RESET_PROVIDER_RESOURCES_UNCONFIRMED":
			return t("customerError.resetProviderResourcesUnconfirmed");
		case "RESET_LOCAL_WORK_ACTIVE":
			return t("customerError.resetLocalWorkActive");
		case "RESET_ACTIVE_WORK":
			return t("customerError.resetActiveWork");
		case "RESET_STATE_CHANGED":
			return t("customerError.resetStateChanged");
		case "RESET_AISA_SNAPSHOT_REQUIRED":
			return t("customerError.resetAisaSnapshotRequired");
		case "LIVE_ACTION_NOT_STARTABLE":
			return t("customerError.liveNotStartable", { status });
		case "LIVE_ACTION_RUN_ALREADY_ACTIVE":
			return t("customerError.liveRunAlreadyActive");
		case "LIVE_ACTION_NOT_STOPPABLE":
			return t("customerError.liveNotStoppable", { status });
		case "LIVE_ACTION_STOP_HANDOFF_MISSING":
			return t("customerError.liveStopHandoffMissing");
		case "LIVE_ACTION_STOP_HANDOFF_COMPLETE":
			return t("customerError.liveStopHandoffComplete");
		case "LIVE_ACTION_NOT_RESTARTABLE":
			return t("customerError.liveNotRestartable", { status });
		case "LIVE_ACTION_RESTART_REQUIRES_NEW_RUN":
			return t("customerError.liveRestartRequiresNewRun");
		case "LIVE_ACTION_STATE_CHANGED":
			return t("customerError.liveStateChanged");
		case "LIVE_ACTION_NO_ENCODING":
			return t("customerError.liveNoEncoding");
		case "LIVE_ACTION_CURRENT_RUN_MISSING":
			return t("customerError.liveCurrentRunMissing");
		case "LIVE_ACTION_PROVIDER_ENCODING_MISSING":
			return t("customerError.liveProviderEncodingMissing");
		case "LIVE_ACTION_PROVIDER_TRANSITIONAL":
			return t("customerError.liveProviderTransitional");
		case "LIVE_ACTION_PROVIDER_UNOBSERVED":
			return t("customerError.liveProviderUnobserved");
		case "LIVE_ACTION_PROVIDER_UNKNOWN":
			return t("customerError.liveProviderUnknown");
		case "LIVE_ACTION_PROVIDER_TERMINAL":
			return t("customerError.liveProviderTerminal");
		case "LIVE_ACTION_DEPLOYMENT_RESTRICTED":
			return t("customerError.liveDeploymentRestricted");
		case "LIVE_ACTION_TIMESHIFT_REQUIRES_RUNNING":
			return t("customerError.liveTimeshiftRequiresRunning", { status });
		case "LIVE_ACTION_CUE_REQUIRES_RUNNING":
			return t("customerError.liveCueRequiresRunning", { status });
		case "LIVE_ACTION_REQUEST_CONFLICT":
			return t("customerError.liveRequestConflict");
		case "LIVE_ACTION_REQUEST_AMBIGUOUS":
			return t("customerError.liveRequestAmbiguous");
		case "LIVE_ACTION_REQUEST_IN_PROGRESS":
			return t("customerError.liveRequestInProgress");
		case "LIVE_RUNTIME_ACCOUNT_MISSING":
			return t("customerError.liveAccountMissing");
		case "LIVE_RUNTIME_ACCOUNT_MISMATCH":
			return t("customerError.liveAccountMismatch");
		case "LIVE_RUNTIME_REQUIRES_RUNNING":
			return t("customerError.liveRequiresRunning", { status });
		case "LIVE_RUNTIME_INGEST_NOT_CONNECTED":
			return t("customerError.liveIngestNotConnected");
		case "LIVE_RUNTIME_ENCODING_UNAVAILABLE":
			return t("customerError.liveEncodingUnavailable");
		case "LIVE_RUNTIME_ACCOUNT_UNAVAILABLE":
			return t("customerError.liveAccountUnavailable");
		case "LIVE_VMAF_NOT_RUNNING":
			return t("customerError.vmafNotRunning", { status });
		case "LIVE_VMAF_OUTPUT_UNREADABLE":
			return t("customerError.vmafOutputUnreadable", {
				output: safeDetail(details, "output", t("common.unknown")),
				rendition: safeDetail(details, "rendition", t("common.unknown")),
			});
		case "LIVE_VMAF_FEEDER_REQUIRED":
			return t("customerError.vmafFeederRequired");
		case "LIVE_VMAF_FIRST_SEGMENT_PENDING":
			return t("customerError.vmafFirstSegmentPending");
		case "LIVE_VMAF_READINESS_UNOBSERVABLE":
			return t("customerError.vmafReadinessUnobservable");
		case "LIVE_CHANNEL_STOP_BEFORE_DELETE":
			return t("customerError.channelStopBeforeDelete", { status });
		case "LIVE_CHANNEL_VMAF_IN_PROGRESS":
			return t("customerError.channelVmafInProgress", { status });
		case "LIVE_CHANNEL_STATE_CHANGED":
			return t("customerError.channelStateChanged");
		case "LIVE_CHANNEL_RUNTIME_CAP_BEFORE_PROGRAM_END":
			return t("customerError.runtimeCapBeforeProgramEnd");
		case "FEEDER_LIMIT_REACHED":
			return t("customerError.feederLimitReached", {
				current: safeDetail(details, "current", t("common.unknown")),
				limit: safeDetail(details, "limit", t("common.unknown")),
			});
		case "FEEDER_CHANNEL_OCCUPIED":
			return t("customerError.feederChannelOccupied");
		case "FEEDER_SWITCH_REQUIRES_ACTIVE":
			return t("customerError.feederSwitchRequiresActive");
		case "FEEDER_CHANNEL_NOT_READY":
			return t("customerError.feederChannelNotReady", { status });
		case "FEEDER_RUN_MISSING":
			return t("customerError.feederRunMissing");
		case "FEEDER_STOP_NOT_NEEDED":
			return t("customerError.feederStopNotNeeded", { status });
		case "FEEDER_STOP_BEFORE_DELETE":
			return t("customerError.feederStopBeforeDelete");
		case "FEEDER_SHUTDOWN_PENDING":
			return t("customerError.feederShutdownPending");
		case "FEEDER_STATE_CHANGED":
			return t("customerError.feederStateChanged");
		case "FEEDER_CHANNEL_NOT_FOUND":
			return t("customerError.feederChannelNotFound");
		case "FEEDER_SOURCE_CREDENTIAL_MISSING":
			return t("customerError.feederSourceCredentialMissing");
		case "FEEDER_SRT_CREDENTIAL_INVALID":
			return t("customerError.feederSrtCredentialInvalid");
		case "FEEDER_SOURCE_UNREADABLE":
			return t("customerError.feederSourceUnreadable");
		case "SCHEDULE_LEAD_TIME_TOO_SHORT":
			return t("customerError.scheduleLeadTimeTooShort", {
				seconds: safeDetail(details, "seconds", t("common.unknown")),
			});
		case "SCHEDULE_FIRE_TIME_NOT_FUTURE":
			return t("customerError.scheduleFireTimeNotFuture");
		case "SCHEDULE_OUTSIDE_RUN_WINDOW":
			return t("customerError.scheduleOutsideRunWindow");
		case "SCHEDULE_CONTENT_NOT_FOUND":
			return t("customerError.scheduleContentNotFound");
		case "SCHEDULE_CONTENT_NOT_READY":
			return t("customerError.scheduleContentNotReady", { status });
		case "SCHEDULE_NOT_CANCELLABLE":
			return t("customerError.scheduleNotCancellable", { status });
		case "CONTENT_REQUEST_CONFLICT":
			return t("customerError.contentRequestConflict");
		case "CONTENT_STATE_CHANGED":
			return t("customerError.contentStateChanged");
		case "CONTENT_REQUEST_BLOCKED":
			return t("customerError.contentRequestBlocked");
		case "CONTENT_INSERT_NOT_ACTIVE":
			return t("customerError.contentInsertNotActive");
		case "CONTENT_RESERVATION_NOT_CANCELLABLE":
			return t("customerError.contentReservationNotCancellable");
		case "SLATE_INCOMPATIBLE":
			return t("customerError.slateIncompatible");
		case "SLATE_UNSUPPORTED_IMAGE":
			return t("customerError.slateUnsupportedImage");
		case "SLATE_UNINSPECTED":
			return t("customerError.slateUninspected");
		case "SLATE_SOURCE_UNSUPPORTED":
			return t("customerError.slateSourceUnsupported");
		case "ALERT_CHANNEL_NOT_FOUND":
			return t("customerError.alertChannelNotFound");
		case "ALERT_ALREADY_RESOLVED":
			return t("customerError.alertAlreadyResolved");
	}
	const exhaustive: never = code;
	return exhaustive;
}
