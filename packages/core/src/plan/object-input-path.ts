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

/** Track specific path-bearing rows instead of blessing a string everywhere in
 * a mixed HTTP/storage plan. A preset can be copied before it is ever run. */
export function objectInputFields(
	plan: unknown,
	entries: unknown,
): WeakSet<object> {
	const fields = new WeakSet<object>();
	if (record(plan) && Array.isArray(plan.inputs)) {
		const sources = new Map<string, boolean>();
		for (const input of plan.inputs) {
			if (!record(input) || typeof input.key !== "string") continue;
			sources.set(
				input.key,
				!sources.has(input.key) &&
					typeof input.kind === "string" &&
					objectKinds.has(input.kind),
			);
		}
		function track(row: unknown) {
			if (
				record(row) &&
				typeof row.inputKey === "string" &&
				sources.get(row.inputKey)
			)
				fields.add(row);
		}
		for (const key of [
			"ingest",
			"fileStreams",
			"captionStreams",
			"dolbyStreams",
		]) {
			const rows = plan[key];
			if (Array.isArray(rows)) for (const row of rows) track(row);
		}
		if (Array.isArray(plan.renditions))
			for (const rendition of plan.renditions) {
				if (record(rendition)) track(rendition.burnInSrt);
			}
	}
	const inputs = objectInputReceipts(entries);
	if (inputs.size && Array.isArray(entries)) {
		for (const entry of entries) {
			if (
				!record(entry) ||
				!hasRecordedObjectInput(entry, entry.request, inputs)
			)
				continue;
			if (record(entry.request)) fields.add(entry.request);
			if (record(entry.payload)) fields.add(entry.payload);
		}
	}
	return fields;
}
