const stages = ["PREPARING", "RENDERING", "VALIDATING"] as const;
const operations = [
	"RESOURCE_PREPARATION",
	"INPUT_RESOLUTION",
	"AUTOMATIC_BINDING",
	"COMPOSITION_INPUT",
	"OUTPUT_STORAGE",
	"LEASE_CHECKPOINT",
	"STATE_TRANSITION",
	"RECOVERY_HEAD",
	"RECOVERY_DOWNLOAD",
	"RECOVERY_PROBE",
	"ATTEMPT_RESUMPTION",
	"SOURCE_STORAGE",
	"SOURCE_DOWNLOAD",
	"SOURCE_PROBE",
	"IMAGE_STORAGE",
	"IMAGE_DOWNLOAD",
	"COMPOSITION_RENDER",
	"LEGACY_RENDER",
	"ARTIFACT_UPLOAD",
	"ARTIFACT_HEAD",
	"ARTIFACT_ADOPTION",
] as const;
export type RenderFailureStage = (typeof stages)[number];
export type RenderFailureOperation = (typeof operations)[number];
export type RenderFailureContext = {
	runId: string;
	organizationId: string;
	projectId: string;
	revisionId: string;
	stage: RenderFailureStage;
	operation: RenderFailureOperation;
	schemaVersion: 1 | 2 | null;
	previousAttempts: number;
	elapsedMs: number;
};
const classes = [
	"MediaOperationError",
	"AutomaticBindingError",
	"ZodError",
	"Error",
	"TypeError",
	"RangeError",
	"AbortError",
	"TimeoutError",
] as const;
const codes = [
	"PROCESS_FAILED",
	"TIMED_OUT",
	"OUTPUT_LIMIT",
	"CANCELED",
	"LEASE_LOST",
	"SOURCE_UNVERIFIED",
	"SOURCE_TOO_LARGE",
	"SOURCE_CHANGED",
	"SOURCE_INCOMPLETE",
	"UNSUPPORTED_MEDIA",
	"INVALID_MEDIA_PROBE",
	"INVALID_RENDER_INPUT",
	"INVALID_RENDER_RECIPE",
	"INVALID_IMAGE_ASSET",
	"INVALID_LOCAL_PATH",
	"RECIPE_TOO_COMPLEX",
	"UNSUPPORTED_FFMPEG",
	"FONT_UNAVAILABLE",
	"OUTPUT_UNVERIFIED",
	"RENDER_VALIDATION_FAILED",
	"AccessDenied",
	"NoSuchKey",
	"NotFound",
	"ECONNRESET",
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"ENOSPC",
	"EACCES",
] as const;

/** Never evaluate an error getter, toJSON, message, stack or custom coercion. */
function data(value: unknown, key: string): unknown {
	if ((typeof value !== "object" && typeof value !== "function") || !value)
		return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}
function member<T extends string>(value: unknown, values: readonly T[]) {
	return typeof value === "string" && values.includes(value as T)
		? (value as T)
		: "UNKNOWN";
}
function errorClass(error: unknown) {
	let value = error;
	for (let depth = 0; depth < 3; depth++) {
		const name = member(data(value, "name"), classes);
		if (name !== "UNKNOWN") return name;
		try {
			if (!value || typeof value !== "object") break;
			value = Object.getPrototypeOf(value);
		} catch {
			break;
		}
	}
	return "UNKNOWN";
}
function status(value: unknown) {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 100 &&
		value <= 599
		? value
		: null;
}
const uuid = (value: unknown) =>
	typeof value === "string" &&
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
		? value
		: null;
const count = (value: unknown) =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= Number.MAX_SAFE_INTEGER
		? Math.floor(value)
		: null;
const signatures = [
	["OUT_OF_MEMORY", /cannot allocate memory|out of memory/i],
	["DISK_FULL", /no space left on device/i],
	[
		"RESOURCE_LIMIT",
		/resource temporarily unavailable|pthread_create|thread creation failed/i,
	],
	[
		"FILTER_GRAPH",
		/no such filter|error initializing (?:complex )?filters|failed to configure output pad|error reinitializing filters|invalid stream specifier|matches no streams|unable to parse option value/i,
	],
	[
		"ENCODER",
		/unknown encoder|error while opening encoder|error initializing output stream|could not open encoder/i,
	],
	["MISSING_FILE", /no such file or directory/i],
	["ACCESS_DENIED", /permission denied|access denied/i],
	[
		"INVALID_MEDIA",
		/invalid data found|moov atom not found|error while decoding/i,
	],
	[
		"OUTPUT_IO",
		/error writing trailer|av_interleaved_write_frame|error muxing|broken pipe/i,
	],
	["INVALID_ARGUMENT", /invalid argument|unrecognized option/i],
] as const;

export function renderFailureDiagnostic(
	context: RenderFailureContext,
	error: unknown,
) {
	const name = errorClass(error);
	const diagnostic =
		name === "MediaOperationError" ? data(error, "diagnostic") : undefined;
	const stderr = typeof diagnostic === "string" ? diagnostic.slice(-4000) : "";
	const schemaVersion = data(context, "schemaVersion");
	return {
		event: "library_render_failed",
		version: 1,
		entryPoint: "LIBRARY_EDITING_SWEEP",
		runId: uuid(data(context, "runId")),
		organizationId: uuid(data(context, "organizationId")),
		projectId: uuid(data(context, "projectId")),
		revisionId: uuid(data(context, "revisionId")),
		stage: member(data(context, "stage"), stages),
		operation: member(data(context, "operation"), operations),
		schemaVersion:
			schemaVersion === 1 || schemaVersion === 2 ? schemaVersion : null,
		previousAttempts: count(data(context, "previousAttempts")),
		elapsedMs: count(data(context, "elapsedMs")),
		errorClass: name,
		errorCode: member(data(error, "code"), codes),
		httpStatus:
			status(data(error, "statusCode")) ??
			status(data(error, "status")) ??
			status(data(data(error, "$metadata"), "httpStatusCode")),
		processSignature:
			signatures.find(([, pattern]) => pattern.test(stderr))?.[0] ?? "UNKNOWN",
	};
}

/** Private best-effort telemetry must never interfere with durable failure handling. */
export function logRenderFailureDiagnostic(
	context: RenderFailureContext,
	error: unknown,
	emit?: (line: string) => void,
) {
	try {
		const line = JSON.stringify(renderFailureDiagnostic(context, error));
		if (emit) emit(line);
		else console.warn(line);
	} catch {
		// The existing cancellation, lease and retry paths retain authority.
	}
}
