import {
	matchesHistoricalUserinfoMask,
	REDACTED,
} from "../crypto/url-userinfo";
import {
	hasPrivateStorageLocator,
	type StoragePathKind,
} from "./hdr-source-paths";

/** Distinguish a query on an HTTP source from the same bytes in an object key.
 * Only the authored input or the exact provider input that fulfilled a step
 * can establish this distinction. SDK diagnostics are never object keys. */
const objectKinds = new Set([
	"S3",
	"GENERIC_S3",
	"GCS",
	"GCS_SERVICE_ACCOUNT",
	"AZURE",
	"AKAMAI_NETSTORAGE",
]);

export function isObjectStorageInput(kind: string) {
	return objectKinds.has(kind);
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A second producer with the same step name makes its binding ambiguous. */
export function objectInputReceipts(
	entries: unknown,
): ReadonlyMap<string, string | null> {
	const inputs = new Map<string, string | null>();
	if (!Array.isArray(entries)) return inputs;
	for (const entry of entries) {
		if (
			!record(entry) ||
			typeof entry.step !== "string" ||
			!entry.step.startsWith("input:")
		)
			continue;
		const kind =
			typeof entry.kind === "string" && entry.kind.startsWith("CREATE_INPUT_")
				? entry.kind.slice("CREATE_INPUT_".length)
				: "";
		const id =
			!inputs.has(entry.step) &&
			objectKinds.has(kind) &&
			entry.status === "DONE" &&
			typeof entry.resourceId === "string" &&
			entry.resourceId.length > 0
				? entry.resourceId
				: null;
		inputs.set(entry.step, id);
	}
	return inputs;
}

export function hasRecordedObjectInput(
	entry: unknown,
	request: unknown,
	inputs?: ReadonlyMap<string, string | null>,
): boolean {
	if (
		!inputs ||
		!record(entry) ||
		!record(entry.refs) ||
		typeof entry.refs.inputId !== "string" ||
		!record(request) ||
		!record(request.refs)
	)
		return false;
	const id = inputs.get(entry.refs.inputId);
	return typeof id === "string" && id === request.refs.inputId;
}

export function hasCompletedResource(row: unknown) {
	return (
		record(row) &&
		row.status === "DONE" &&
		typeof row.resourceId === "string" &&
		row.resourceId.length > 0 &&
		record(row.response) &&
		row.response.id === row.resourceId
	);
}

/** A successful object-input request used either the exact compiler bytes or
 * one of the request masks used by earlier workers. */
export function matchesRecordedObjectPath(actual: unknown, compiled: unknown) {
	if (
		typeof actual !== "string" ||
		typeof compiled !== "string" ||
		hasPrivateStorageLocator(compiled, "OBJECT_KEY")
	)
		return false;
	return (
		actual === compiled ||
		matchesHistoricalUserinfoMask(actual, compiled) ||
		(actual === REDACTED && hasPrivateStorageLocator(compiled))
	);
}

/** Use the independently retained authored plan to distinguish a literal
 * "[REDACTED]" in an object name from a projected/legacy placeholder. */
export function authoredObjectPath(
	plan: unknown,
	step: string,
	source: unknown,
	field: string,
	value: string,
) {
	if (!record(plan) || !Array.isArray(plan.inputs)) return false;
	const ingest = field === "inputPath";
	const candidates = ingest ? plan.ingest : plan.dolbyStreams;
	if (!Array.isArray(candidates)) return false;
	const prefix = ingest ? "ingest" : "dolby";
	const streams = candidates.filter(
		(row) =>
			record(row) &&
			typeof row.key === "string" &&
			step === `${prefix}:${row.key}`,
	);
	const [stream] = streams;
	if (
		streams.length !== 1 ||
		(!ingest && stream.kind !== "VISION") ||
		typeof stream.inputKey !== "string" ||
		source !== `input:${stream.inputKey}` ||
		stream[field] !== value
	)
		return false;
	const inputs = plan.inputs.filter(
		(input) => record(input) && input.key === stream.inputKey,
	);
	return inputs.length === 1 && isObjectStorageInput(inputs[0].kind);
}
/** The job/preset's typed input rows and the actual steps with fulfilled
 * object inputs are the only public projection fields with this exception. */
export function vodObjectPathFields(
	plan: unknown,
	entries: unknown,
): WeakMap<object, StoragePathKind> {
	const fields = new WeakMap<object, StoragePathKind>();
	if (record(plan) && Array.isArray(plan.inputs)) {
		const sources = new Map<string, StoragePathKind>();
		for (const input of plan.inputs) {
			if (record(input) && typeof input.key === "string")
				sources.set(
					input.key,
					sources.has(input.key)
						? "UNKNOWN"
						: input.kind === "HTTPS"
							? "HTTPS_PATH"
							: typeof input.kind === "string" &&
									isObjectStorageInput(input.kind)
								? "OBJECT_KEY"
								: "UNKNOWN",
				);
		}
		for (const [rows, vision] of [
			[plan.ingest, false],
			[plan.dolbyStreams, true],
		] as const) {
			if (!Array.isArray(rows)) continue;
			for (const row of rows)
				if (
					record(row) &&
					(!vision || row.kind === "VISION") &&
					typeof row.inputKey === "string"
				)
					fields.set(row, sources.get(row.inputKey) ?? "UNKNOWN");
		}
	}
	if (Array.isArray(entries)) {
		const inputs = objectInputReceipts(entries);
		for (const row of entries) {
			if (
				!record(row) ||
				(row.kind !== "CREATE_DOLBY_VISION_INPUT_STREAM" &&
					row.kind !== "CREATE_INGEST_INPUT_STREAM") ||
				!hasCompletedResource(row) ||
				!record(row.payload) ||
				!record(row.request) ||
				!hasRecordedObjectInput(row, row.request, inputs)
			)
				continue;
			const { payload, request } = row;
			const ingest = row.kind === "CREATE_INGEST_INPUT_STREAM";
			if (typeof payload[ingest ? "inputPath" : "videoInputPath"] !== "string")
				continue;
			const matches = (
				ingest ? ["inputPath"] : ["videoInputPath", "metadataInputPath"]
			).every((field) => {
				const actual = request[field],
					compiled = payload[field];
				return (
					(actual === undefined && compiled === undefined) ||
					matchesRecordedObjectPath(actual, compiled)
				);
			});
			if (matches) {
				fields.set(payload, "OBJECT_KEY");
				fields.set(request, "OBJECT_KEY");
			}
		}
	}
	return fields;
}
