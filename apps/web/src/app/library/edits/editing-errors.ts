import { ApiError } from "@/lib/api";
import type { Translator } from "@/lib/i18n/context";

export function editingFailureCode(failure: unknown): string {
	if (
		failure instanceof ApiError &&
		typeof failure.details === "object" &&
		failure.details !== null &&
		"code" in failure.details &&
		typeof failure.details.code === "string"
	)
		return failure.details.code;
	return typeof failure === "string"
		? failure
		: failure instanceof Error
			? failure.message
			: "";
}

export function editingErrorMessage(failure: unknown, t: Translator): string {
	if (failure instanceof ApiError && failure.status === 401)
		return t("editing.errors.signIn");
	if (failure instanceof ApiError && failure.status === 403)
		return t("editing.errors.permission");
	const code = editingFailureCode(failure);
	const keys = {
		HLS_UNSUPPORTED: "editing.errors.hlsUnsupported",
		HLS_LIMIT: "editing.errors.hlsLimit",
		CLIP_EDITING_UNAVAILABLE: "editing.errors.clipUnavailable",
		LOCAL_SEMANTIC_UNAVAILABLE: "editing.errors.clipUnavailable",
		LOCAL_STORY_ENGINE_UNAVAILABLE: "editing.errors.clipUnavailable",
		LOCAL_CAPTION_TRANSLATION_UNAVAILABLE: "editing.errors.clipUnavailable",
		MEDIA_NOT_READY: "editing.errors.mediaNotReady",
		MEDIA_VERSION_UNVERIFIED: "editing.errors.mediaUnverified",
		SOURCE_UNVERIFIED: "editing.errors.mediaUnverified",
		SOURCE_CHANGED: "editing.errors.sourceChanged",
		SOURCE_TOO_LARGE: "editing.errors.sourceLarge",
		SOURCE_INCOMPLETE: "editing.errors.sourceRead",
		SOURCE_FILE_NOT_FOUND: "editing.errors.sourceMissing",
		SOURCE_STORAGE_ACCESS_DENIED: "editing.errors.sourceDenied",
		SOURCE_READ_FAILED: "editing.errors.sourceRead",
		NO_EDITABLE_MP4: "editing.noFiles",
		OUTPUT_WRITE_UNSUPPORTED: "editing.errors.outputUnsupported",
		OUTPUT_WATCHED_INPUT: "editing.errors.watchedInput",
		EDIT_CONFLICT: "editing.conflict",
		EDIT_VARIANT_MISMATCH: "editing.errors.variant",
		UNCONFIRMED_FRAMING: "editing.errors.unconfirmed",
		SUBJECT_PROTECTION_ADOPTION_LIMIT: "editing.errors.subjectProtectionLimit",
		ANALYSIS_BINDING_UNVERIFIED: "editing.analysisUnverified",
		NO_ELIGIBLE_WINDOW: "editing.autoPortrait.noWindow",
		AUTO_SELECTION_LIMIT: "editing.autoPortrait.selectionLimit",
		AUTO_GENERATION_IMMUTABLE: "editing.autoPortrait.provenanceLocked",
		REQUEST_KEY_REUSED: "editing.errors.requestKey",
		SOURCE_OUT_OF_BOUNDS: "editing.rangeInvalid",
		TIME_MAP_MISMATCH: "editing.errors.mapping",
		UNSUPPORTED_MEDIA: "editing.support",
		CANCELED: "editing.states.CANCELED",
		TIMED_OUT: "editing.errors.timeout",
	} as const;
	if (Object.hasOwn(keys, code)) return t(keys[code as keyof typeof keys]);
	if (failure instanceof ApiError && failure.status === 409)
		return t("editing.conflict");
	return t("editing.failed");
}
