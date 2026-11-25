import { hasPrivateStorageLocator } from "./hdr-source-paths";

/** Distinguish a query on an HTTP source from the same bytes in an object key.
 * Only the authored input or the exact provider input that fulfilled a step
 * can establish this distinction. SDK diagnostics are never object keys. */
const objectKinds = new Set([
	"S3",
	"GENERIC_S3",
	"GCS",
	"GCS_SERVICE_ACCOUNT",
	"AZURE",
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

/** The job/preset's typed Dolby rows and the actual steps with fulfilled
 * object inputs are the only public projection fields with this exception. */
export function dolbyObjectFields(
	plan: unknown,
	entries: unknown,
): WeakSet<object> {
	const fields = new WeakSet<object>();
	if (
		record(plan) &&
		Array.isArray(plan.inputs) &&
		Array.isArray(plan.dolbyStreams)
	) {
		const sources = new Map<string, boolean>();
		for (const input of plan.inputs) {
			if (record(input) && typeof input.key === "string")
				sources.set(
					input.key,
					!sources.has(input.key) &&
						typeof input.kind === "string" &&
						isObjectStorageInput(input.kind),
				);
		}
		for (const row of plan.dolbyStreams)
			if (
				record(row) &&
				row.kind === "VISION" &&
				typeof row.inputKey === "string" &&
				sources.get(row.inputKey)
			)
				fields.add(row);
	}
	if (Array.isArray(entries)) {
		const inputs = objectInputReceipts(entries);
		for (const row of entries) {
			if (
				!record(row) ||
				row.kind !== "CREATE_DOLBY_VISION_INPUT_STREAM" ||
				!hasCompletedResource(row) ||
				!record(row.payload) ||
				!record(row.request) ||
				!hasRecordedObjectInput(row, row.request, inputs)
			)
				continue;
			const { payload, request } = row;
			if (typeof payload.videoInputPath !== "string") continue;
			const matches = ["videoInputPath", "metadataInputPath"].every((field) => {
				const actual = request[field],
					compiled = payload[field];
				return (
					actual === compiled ||
					(actual === "[REDACTED]" &&
						typeof compiled === "string" &&
						hasPrivateStorageLocator(compiled) &&
						!hasPrivateStorageLocator(compiled, true))
				);
			});
			if (matches) {
				fields.add(payload);
				fields.add(request);
			}
		}
	}
	return fields;
}
