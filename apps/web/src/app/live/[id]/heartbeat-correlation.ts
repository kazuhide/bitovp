const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEYS = ["heartbeatRunId", "heartbeatFrom", "heartbeatTo"] as const;
export type HeartbeatWindow = { from: string; to: string };
export type HeartbeatCorrelation =
	| { kind: "none" }
	| { kind: "invalid" }
	| ({ kind: "requested"; runId: string } & HeartbeatWindow);
type Search =
	| URLSearchParams
	| Readonly<Record<string, string | string[] | undefined>>;
const exactUtc = (value: string) =>
	UTC.test(value) &&
	Number.isFinite(Date.parse(value)) &&
	new Date(value).toISOString() === value;
export function parseHeartbeatCorrelation(
	search: Search,
): HeartbeatCorrelation {
	const values = KEYS.map((key) => {
		if (search instanceof URLSearchParams) return search.getAll(key);
		const value = search[key];
		return typeof value === "string" ? [value] : (value ?? []);
	});
	if (values.every((value) => value.length === 0)) return { kind: "none" };
	if (values.some((value) => value.length !== 1)) return { kind: "invalid" };
	const runId = values[0]?.[0] ?? "",
		from = values[1]?.[0] ?? "",
		to = values[2]?.[0] ?? "";
	if (!UUID.test(runId) || !exactUtc(from) || !exactUtc(to))
		return { kind: "invalid" };
	const duration = Date.parse(to) - Date.parse(from);
	return duration >= 0 && duration <= 600_000
		? { kind: "requested", runId, from, to }
		: { kind: "invalid" };
}
export function buildHeartbeatCorrelationUrl(
	channelId: string,
	runId: string,
	from: string,
	to: string,
): string | null {
	const query = new URLSearchParams({
		heartbeatRunId: runId,
		heartbeatFrom: from,
		heartbeatTo: to,
	});
	if (
		!UUID.test(channelId) ||
		parseHeartbeatCorrelation(query).kind !== "requested"
	)
		return null;
	return `/live/${channelId}?${query}#sec-heartbeat-log`;
}
export function heartbeatWindowContains(
	window: HeartbeatWindow,
	value: string | null | undefined,
) {
	const stamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return (
		Number.isFinite(stamp) &&
		stamp >= Date.parse(window.from) &&
		stamp <= Date.parse(window.to)
	);
}
