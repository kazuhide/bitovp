import {
	matchesHistoricalUserinfoMask,
	REDACTED,
} from "../crypto/url-userinfo";
import {
	hasPrivateStorageLocator,
	type StoragePathKind,
	type StoragePathProvenance,
} from "./hdr-source-paths";

/** Distinguish a query on an HTTP source from the same bytes in an object key.
 * Only the authored input or the exact provider input that fulfilled a step
 * can establish this distinction. SDK diagnostics are never object keys. */
const objectKinds = new Set([
	"S3",
	"S3_ROLE_BASED",
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

export function recordedStorageFields(kind: unknown): readonly string[] {
	switch (kind) {
		case "CREATE_DOLBY_VISION_INPUT_STREAM":
			return ["videoInputPath", "metadataInputPath"];
		case "CREATE_INGEST_INPUT_STREAM":
		case "CREATE_FILE_INPUT_STREAM":
		case "CREATE_DOLBY_ATMOS_INPUT_STREAM":
		case "CREATE_DOLBY_VISION_METADATA_INPUT_STREAM":
		case "CREATE_CEA608_INPUT_STREAM":
		case "CREATE_CEA708_INPUT_STREAM":
		case "CREATE_DVB_SUBTITLE_INPUT_STREAM":
		case "CREATE_BURN_IN_SRT":
			return ["inputPath"];
		default:
			return [];
	}
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
	const prefix = step.split(":", 1)[0];
	const candidates =
		prefix === "ingest"
			? plan.ingest
			: prefix === "file"
				? plan.fileStreams
				: prefix === "caption"
					? plan.captionStreams
					: prefix === "dolby"
						? plan.dolbyStreams
						: undefined;
	if (!Array.isArray(candidates)) return false;
	const streams = candidates.filter(
		(row) =>
			record(row) &&
			typeof row.key === "string" &&
			step === `${prefix}:${row.key}`,
	);
	const [stream] = streams;
	if (
		streams.length !== 1 ||
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
): StoragePathProvenance {
	const fields: StoragePathProvenance = new WeakMap();
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
		const track = (row: unknown, dolbyVision = false) => {
			if (!record(row) || typeof row.inputKey !== "string") return;
			const kind = sources.get(row.inputKey) ?? "UNKNOWN";
			fields.set(
				row,
				new Map(
					dolbyVision
						? [
								["videoInputPath", kind],
								["metadataInputPath", kind],
							]
						: [["inputPath", kind]],
				),
			);
		};
		for (const rows of [plan.ingest, plan.fileStreams, plan.captionStreams]) {
			if (!Array.isArray(rows)) continue;
			for (const row of rows) track(row);
		}
		if (Array.isArray(plan.dolbyStreams))
			for (const row of plan.dolbyStreams)
				track(row, record(row) && row.kind === "VISION");
		if (Array.isArray(plan.renditions))
			for (const rendition of plan.renditions)
				if (record(rendition)) track(rendition.burnInSrt);
	}
	if (Array.isArray(entries)) {
		const inputs = objectInputReceipts(entries);
		for (const row of entries) {
			if (
				!record(row) ||
				!hasCompletedResource(row) ||
				!record(row.payload) ||
				!record(row.request) ||
				!hasRecordedObjectInput(row, row.request, inputs)
			)
				continue;
			const { payload, request } = row;
			const paths = recordedStorageFields(row.kind);
			const [primary] = paths;
			if (!primary || typeof payload[primary] !== "string") continue;
			const matches = paths.every((field) => {
				const actual = request[field],
					compiled = payload[field];
				return (
					(actual === undefined && compiled === undefined) ||
					matchesRecordedObjectPath(actual, compiled)
				);
			});
			if (matches) {
				const proven = new Map(
					paths.map((path) => [path, "OBJECT_KEY" as const]),
				);
				fields.set(payload, proven);
				fields.set(request, proven);
			}
		}
	}
	return fields;
}
