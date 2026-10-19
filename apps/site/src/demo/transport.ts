import {
	DEFAULT_BRANDING_SETTINGS,
	encodingPlanSchema,
	liveChannelPlanSchema,
	providerHeartbeatEvents,
} from "@bitovp/core";
import { z } from "zod";
import type {
	HeartbeatLogResponse,
	HeartbeatLogRow,
} from "@/app/api/live-channels/[id]/runs/[runId]/heartbeats/route";
import {
	DEMO_ACCOUNT_ID,
	DEMO_BUCKET,
	DEMO_LIVE_CHANNEL_ID,
	DEMO_ORGANIZATION_ID,
	DEMO_STORAGE_ID,
	DEMO_USER_ID,
	DEMO_VMAF_JOB_ID,
	DEMO_VOD_JOB_ID,
	type DemoRecord,
	demoAccount,
	demoChannels,
	demoCredentials,
	demoHealth,
	demoHeartbeatHistory,
	demoJobs,
	demoSession,
	demoUsage,
	demoVmafReport,
	heartbeatRaw,
	liveRecord,
	vodRecord,
} from "./fixtures";

export const DEMO_STORAGE_KEY = "bitovp.pages-demo.v2";
export const DEMO_LIMITATION_EVENT = "bitovp:demo-limitation";
const MAX_RECORDS = 25;
const MAX_STORED_CHARACTERS = 800_000;
const MAX_REQUEST_CHARACTERS = 160_000;
const DEMO_LIMITATION =
	"This operation is not available in the browser demo. No cloud request was sent.";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const entrySchema = z.strictObject({
	id: z.uuid(),
	kind: z.enum(["vod", "live"]),
	plan: z.unknown(),
	createdAt: z.number().finite().nonnegative(),
	status: z.enum(["AUTO", "FINISHED", "CANCELED", "RUNNING", "STOPPED"]),
	requestKey: z.string().min(1).max(200).optional(),
	generation: z.number().int().nonnegative().max(1000).optional(),
});
const stateSchema = z.strictObject({
	version: z.literal(2),
	entries: z.array(entrySchema).max(MAX_RECORDS),
});
type Entry = z.infer<typeof entrySchema>;
type State = z.infer<typeof stateSchema>;
const heartbeatLogQuerySchema = z
	.object({
		from: z.iso.datetime({ offset: true }).optional(),
		to: z.iso.datetime({ offset: true }).optional(),
		cursor: z.uuid().optional(),
		limit: z.coerce.number().int().min(1).max(500).default(200),
	})
	.refine(
		(query) =>
			!query.from ||
			!query.to ||
			Date.parse(query.from) <= Date.parse(query.to),
	);

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"x-bitovp-demo": "simulated",
		},
	});
}

function error(status: number, message = DEMO_LIMITATION) {
	return json({ error: message }, status);
}

class DemoRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The demo accepts plans, not credentials, headers, or signed playback URLs. */
function containsSecret(value: unknown, depth = 0): boolean {
	if (depth > 60) return true;
	if (typeof value === "string") {
		return /\bBearer\s+|:\/\/[^/\s]*@|[?&](?:x-amz-|x-goog-|sig=|token=|key=)/i.test(
			value,
		);
	}
	if (Array.isArray(value))
		return value.some((item) => containsSecret(item, depth + 1));
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(
		([key, item]) =>
			(/(?:password|passphrase|secret|apiKey|accessKeyId|authorization|licenseKey|serviceAccountJson)$/i.test(
				key,
			) &&
				item !== "" &&
				item !== undefined &&
				item !== null) ||
			containsSecret(item, depth + 1),
	);
}

function parsePlan(kind: Entry["kind"], value: unknown) {
	if (containsSecret(value))
		throw new DemoRequestError(
			400,
			"Use sample references in the demo. Credentials and signed URLs are not accepted or stored.",
		);
	const parsed =
		kind === "vod"
			? encodingPlanSchema.safeParse(value)
			: liveChannelPlanSchema.safeParse(value);
	if (!parsed.success)
		throw new DemoRequestError(
			400,
			"The demo plan does not pass the application's plan validation.",
		);
	return parsed.data;
}

function initialState(now: number): State {
	return {
		version: 2,
		entries: [
			...demoJobs(now).map(
				(row): Entry => ({
					id: String(row.id),
					kind: "vod",
					plan: row.plan,
					createdAt: Date.parse(String(row.createdAt)),
					status: "FINISHED",
				}),
			),
			...demoChannels(now).map(
				(row): Entry => ({
					id: String(row.id),
					kind: "live",
					plan: row.plan,
					createdAt: Date.parse(String(row.createdAt)),
					status: row.status === "RUNNING" ? "RUNNING" : "STOPPED",
				}),
			),
		],
	};
}

function restore(storage: Store | undefined, now: number): State {
	try {
		storage?.removeItem("bitovp.pages-demo.v1");
		const raw = storage?.getItem(DEMO_STORAGE_KEY);
		if (!raw) return initialState(now);
		if (raw.length > MAX_STORED_CHARACTERS)
			throw new Error("Oversized demo state");
		const state = stateSchema.parse(JSON.parse(raw));
		if (
			new Set(state.entries.map((entry) => entry.id)).size !==
			state.entries.length
		)
			throw new Error("Duplicate demo IDs");
		for (const entry of state.entries) {
			if (
				entry.createdAt > now + 60_000 ||
				now - entry.createdAt > 7 * 86_400_000
			)
				throw new Error("Expired demo state");
			entry.plan = parsePlan(entry.kind, entry.plan);
		}
		return state;
	} catch {
		try {
			storage?.removeItem(DEMO_STORAGE_KEY);
		} catch {
			/* Storage may be unavailable. */
		}
		return initialState(now);
	}
}

function record(entry: Entry, now: number): DemoRecord {
	const elapsed = now - entry.createdAt;
	if (entry.kind === "vod") {
		const status =
			entry.status === "AUTO"
				? elapsed < 1_200
					? "QUEUED"
					: elapsed < 8_000
						? "RUNNING"
						: "FINISHED"
				: entry.status;
		const row = vodRecord(
			entry.id,
			entry.plan,
			entry.createdAt + 60_000,
			status,
		);
		row.updatedAt = new Date(now).toISOString();
		if (status === "FINISHED")
			row.finishedAt = new Date(entry.createdAt + 8_000).toISOString();
		return row;
	}
	const status =
		entry.status === "AUTO"
			? elapsed < 1_200
				? "PROVISIONING"
				: "RUNNING"
			: entry.status;
	const row = liveRecord(entry.id, entry.plan, now, status);
	row.liveEffectFenceVersion = entry.generation ?? 0;
	row.createdAt = new Date(entry.createdAt).toISOString();
	const run = row.currentRun as DemoRecord;
	run.createdAt = row.createdAt;
	run.runningSince = new Date(entry.createdAt + 1_200).toISOString();
	const health = row.health as DemoRecord;
	health.runningSince = run.runningSince;
	return row;
}

function utcDay(now: number) {
	return new Date(now).toISOString().slice(0, 10);
}

/** Pure factory keeps the transport independently testable without a running server. */
export function createDemoTransport(
	options: {
		storage?: Store;
		now?: () => number;
		origin?: string;
		assetBase?: string;
		assetFetch?: typeof fetch;
	} = {},
) {
	const now = options.now ?? Date.now;
	const origin =
		options.origin ?? globalThis.location?.origin ?? "https://demo.invalid";
	const assetBase = options.assetBase ?? "/bitovp/";
	let state = restore(options.storage, now());
	const templates: DemoRecord[] = [];
	const deletedReports = new Set<string>();
	const heartbeatSnapshots = new Map<
		string,
		{ identity: string; rows: HeartbeatLogRow[] }
	>();

	function persist() {
		const serialized = JSON.stringify(state);
		if (serialized.length > MAX_STORED_CHARACTERS)
			throw new DemoRequestError(
				413,
				"The demo's local data limit was reached. Reset the demo to continue.",
			);
		try {
			options.storage?.setItem(DEMO_STORAGE_KEY, serialized);
		} catch {
			/* In-memory exploration still works without storage. */
		}
	}

	function find(id: string, kind: Entry["kind"]) {
		const entry = state.entries.find(
			(item) => item.id === id && item.kind === kind,
		);
		if (!entry)
			throw new DemoRequestError(
				404,
				"This demo record was not found. Reset the demo to restore the samples.",
			);
		return entry;
	}

	function heartbeatLog(
		entry: Entry,
		run: DemoRecord,
		url: URL,
		timestamp: number,
	): Response {
		const parsed = heartbeatLogQuerySchema.safeParse({
			from: url.searchParams.get("from") ?? undefined,
			to: url.searchParams.get("to") ?? undefined,
			cursor: url.searchParams.get("cursor") ?? undefined,
			limit: url.searchParams.get("limit") ?? undefined,
		});
		if (!parsed.success) return error(400, "Invalid demo Heartbeat log query.");
		const { from, to, cursor, limit } = parsed.data;
		// A bounded snapshot keeps row IDs stable across pages and isolated between runs.
		const identity = `${String(run.id)}:${entry.createdAt}:${entry.generation ?? 0}`;
		let snapshot = heartbeatSnapshots.get(entry.id);
		if (snapshot?.identity !== identity) {
			const start = Date.parse(String(run.createdAt));
			const end = run.endedAt ? Date.parse(String(run.endedAt)) : timestamp;
			const count = Math.min(
				37,
				Math.floor(Math.max(0, end - start) / 30_000) + 1,
			);
			snapshot = {
				identity,
				rows: Array.from({ length: count }, (_, index) => {
					const at = start + index * 30_000;
					return {
						id: crypto.randomUUID(),
						at: new Date(at).toISOString(),
						raw: {
							...heartbeatRaw(at),
							events: [
								{
									time: new Date(start).toISOString(),
									details: {
										eventType: "INPUT_CONNECTED",
										message: "Simulated input connected",
									},
								},
							],
						},
						deltas: {
							droppedPacketsVideo: index === 12 ? 2 : 0,
							droppedPacketsAudio: 0,
							corruptPacketsVideo: 0,
							corruptPacketsAudio: 0,
						},
					};
				}),
			};
			heartbeatSnapshots.set(entry.id, snapshot);
		}
		const filtered = snapshot.rows.filter(
			(sample) =>
				(!from || Date.parse(sample.at) >= Date.parse(from)) &&
				(!to || Date.parse(sample.at) <= Date.parse(to)),
		);
		const cursorIndex = cursor
			? filtered.findIndex((sample) => sample.id === cursor)
			: -1;
		if (cursor && cursorIndex === -1)
			return error(
				400,
				"The demo Heartbeat cursor does not belong to this run and time window.",
			);
		const offset = cursorIndex + 1;
		const rows = filtered.slice(offset, offset + limit);
		const response: HeartbeatLogResponse = {
			run: {
				id: String(run.id),
				seq: Number(run.seq),
				status: String(run.status),
				createdAt: String(run.createdAt),
				endedAt: run.endedAt ? String(run.endedAt) : null,
				summary: null,
			},
			rows,
			...(filtered.length > offset + limit
				? { nextCursor: rows.at(-1)?.id }
				: {}),
			...(!cursor
				? { latestEvents: providerHeartbeatEvents(snapshot.rows.at(-1)?.raw) }
				: {}),
		};
		return json(response);
	}

	function create(kind: Entry["kind"], raw: unknown, requestKey?: string) {
		const plan = parsePlan(kind, raw);
		if (requestKey) {
			const prior = state.entries.find(
				(entry) => entry.requestKey === requestKey && entry.kind === kind,
			);
			if (prior) {
				if (JSON.stringify(prior.plan) !== JSON.stringify(plan))
					throw new DemoRequestError(
						409,
						"This demo request key already belongs to another plan.",
					);
				return { id: prior.id };
			}
		}
		if (state.entries.length >= MAX_RECORDS)
			throw new DemoRequestError(
				409,
				"The demo holds up to 20 new jobs and channels. Reset it to continue.",
			);
		const entry: Entry = {
			id: crypto.randomUUID(),
			kind,
			plan,
			createdAt: now(),
			status: "AUTO",
			...(requestKey ? { requestKey } : {}),
		};
		const next = { ...state, entries: [entry, ...state.entries] };
		if (JSON.stringify(next).length > MAX_STORED_CHARACTERS)
			throw new DemoRequestError(
				413,
				"The demo's local data limit was reached. Reset it to continue.",
			);
		state = next;
		persist();
		return { id: entry.id };
	}

	async function body(request: Request): Promise<DemoRecord> {
		const text = await request.text();
		if (text.length > MAX_REQUEST_CHARACTERS)
			throw new DemoRequestError(
				413,
				"This plan is too large for the browser demo.",
			);
		try {
			const value: unknown = JSON.parse(text);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("Not an object");
			return value as DemoRecord;
		} catch {
			throw new DemoRequestError(
				400,
				"The demo request must contain a JSON object.",
			);
		}
	}

	async function route(request: Request, url: URL): Promise<Response> {
		const path = url.pathname.replace(/\/$/, "");
		const method = request.method;
		const get = method === "GET";
		const timestamp = now();
		const page = (items: unknown[]) =>
			json({
				items,
				totalCount: items.length,
				offset: 0,
				limit: 100,
				serverNow: new Date(timestamp).toISOString(),
			});
		if (get && path === "/api/auth/session") return json(demoSession);
		if (get && path === "/api/settings/branding")
			return json({ ...DEFAULT_BRANDING_SETTINGS, displayName: "bitovp demo" });
		if (get && path === "/api/bitmovin-accounts")
			return json([demoAccount(timestamp)]);
		if (get && path === `/api/bitmovin-accounts/${DEMO_ACCOUNT_ID}`)
			return json(demoAccount(timestamp));
		if (get && path === "/api/credentials")
			return json(demoCredentials(timestamp));
		if (get && path === `/api/credentials/${DEMO_STORAGE_ID}/storage/buckets`)
			return json({ buckets: [DEMO_BUCKET] });
		if (get && path === `/api/credentials/${DEMO_STORAGE_ID}/storage/objects`) {
			const prefix = url.searchParams.get("prefix") ?? "";
			const keys = [
				"samples/big-buck-bunny-10s.mp4",
				"encodings/",
				"live/studio/",
			];
			const prefixes = [
				...new Set(
					keys
						.filter((key) => key.startsWith(prefix))
						.map((key) => {
							const next = key.indexOf("/", prefix.length);
							return next >= 0 ? key.slice(0, next + 1) : "";
						})
						.filter(Boolean),
				),
			];
			return json({
				prefixes,
				objects: keys
					.filter(
						(key) =>
							!key.endsWith("/") &&
							key.startsWith(prefix) &&
							!key.slice(prefix.length).includes("/"),
					)
					.map((key) => ({
						key,
						size: 3_200_000,
						lastModified: new Date(timestamp - 86_400_000).toISOString(),
					})),
			});
		}
		if (get && path === "/api/storage-presets")
			return json([
				{
					id: "demo-input",
					name: "Sample input",
					credentialId: DEMO_STORAGE_ID,
					bucket: DEMO_BUCKET,
					prefix: "samples/",
					role: "INPUT",
				},
				{
					id: "demo-output",
					name: "Demo output",
					credentialId: DEMO_STORAGE_ID,
					bucket: DEMO_BUCKET,
					prefix: "encodings/",
					role: "OUTPUT",
				},
			]);
		if (get && path === "/api/dashboard/usage") {
			const from =
				url.searchParams.get("from") ?? utcDay(timestamp - 29 * 86_400_000);
			const to = url.searchParams.get("to") ?? utcDay(timestamp);
			if (
				!/^\d{4}-\d{2}-\d{2}$/.test(from) ||
				!/^\d{4}-\d{2}-\d{2}$/.test(to) ||
				!Number.isFinite(Date.parse(from)) ||
				!Number.isFinite(Date.parse(to)) ||
				from > to ||
				Date.parse(to) - Date.parse(from) >= 366 * 86_400_000
			)
				return error(400, "Select a demo range of up to one year.");
			const series = demoUsage(from, to, timestamp);
			const label = url.searchParams.get("label");
			return label
				? json({
						scope: "LABEL",
						account: { id: DEMO_ACCOUNT_ID, label: "Demo account (simulated)" },
						label,
						from,
						to,
						days: series.days.map((day) => ({
							date: day.date,
							billableEncodingMinutes: day.VOD.billableEncodingMinutes / 2,
							bytesEncoded: day.VOD.bytesEncoded / 2,
							billableEgressBytes: day.VOD.bytesEgress / 2,
						})),
						totals: {
							billableEncodingMinutes:
								series.totals.VOD.billableEncodingMinutes / 2,
							bytesEncoded: series.totals.VOD.bytesEncoded / 2,
							billableEgressBytes: series.totals.VOD.bytesEgress / 2,
						},
						breakdown: [
							{
								codec: "H264",
								resolution: "HD",
								billableMinutes: series.totals.VOD.billableEncodingMinutes / 2,
							},
						],
						coverage: { missingDays: 0 },
						refreshedAt: new Date(timestamp).toISOString(),
					})
				: json(series);
		}
		if (get && path === "/api/dashboard/usage/labels")
			return json({
				labels: ["demo", "Big Buck Bunny"],
				totalCount: 2,
				offset: 0,
				nextOffset: null,
				readAt: new Date(timestamp).toISOString(),
				source: "CACHE",
			});
		if (path === "/api/dashboard/usage/backfill" && (get || method === "POST"))
			return json({ job: null });
		if (get && path === "/api/vmaf-compute-profiles") return page([]);
		if (get && path === "/api/infrastructure/infrastructures")
			return json({ items: [], skipped: [] });
		if (
			get &&
			[
				"/api/infrastructure/static-ips",
				"/api/infrastructure/prewarmed-pools",
				"/api/live/inputs",
				"/api/live/stream-keys",
				"/api/feeder-sessions",
			].includes(path)
		)
			return page([]);
		if (get && path === "/api/storage-inspections")
			return json({ items: [], latest: null });
		if (get && path === "/api/sample-presets") return json([]);
		if (get && path.startsWith("/api/sample-presets/")) {
			const { samplePresetPlan } = await import("@bitovp/core/presets");
			const plan = samplePresetPlan(
				decodeURIComponent(path.slice("/api/sample-presets/".length)),
			);
			return plan
				? json(plan)
				: error(404, "This sample preset was not found.");
		}
		if (path === "/api/presets" && get) return json(templates);
		if (path === "/api/presets" && method === "POST") {
			const input = await body(request);
			if (templates.length >= 10)
				return error(409, "The demo holds up to ten templates per visit.");
			const raw = input.plan ?? input.body;
			const kind =
				input.kind === "LIVE" ||
				(raw && typeof raw === "object" && "liveInput" in raw)
					? "live"
					: "vod";
			const plan = parsePlan(kind, raw);
			const template = {
				id: crypto.randomUUID(),
				name:
					typeof input.name === "string"
						? input.name.slice(0, 120)
						: "Demo template",
				kind: kind.toUpperCase(),
				body: plan,
				revision: 1,
				createdAt: new Date(timestamp).toISOString(),
				updatedAt: new Date(timestamp).toISOString(),
			};
			templates.push(template);
			return json(template, 201);
		}
		if (get && path.startsWith("/api/presets/")) {
			const template = templates.find((item) => item.id === path.split("/")[3]);
			return template
				? json(template)
				: error(404, "This demo template was not found.");
		}
		if (get && path === "/api/vmaf-jobs") {
			const report = demoVmafReport(timestamp);
			const encodingId = url.searchParams.get("encodingJobId");
			return page(
				!deletedReports.has(report.id) &&
					(!encodingId || encodingId === report.encodingJobId)
					? [
							{
								...report,
								renditionMeans: report.results.map((result) => ({
									label: result.renditionRef.label,
									mean: result.pooled.mean,
								})),
							},
						]
					: [],
			);
		}
		if (path.startsWith("/api/vmaf-jobs/")) {
			const id = path.split("/")[3];
			if (id !== DEMO_VMAF_JOB_ID || deletedReports.has(id))
				return error(404, "This demo report was not found.");
			if (get && path === `/api/vmaf-jobs/${id}`)
				return json(demoVmafReport(timestamp));
			if (method === "DELETE" && path === `/api/vmaf-jobs/${id}`) {
				deletedReports.add(id);
				return new Response(null, { status: 204 });
			}
			if (get && path.endsWith("/export")) {
				const report = demoVmafReport(timestamp);
				if (url.searchParams.get("format") === "csv")
					return new Response(
						`Illustrative demo scores; not measured results\nheight,bitrate,mean\n${report.results.map((result) => `${result.renditionRef.height},${result.renditionRef.bitrate},${result.pooled.mean}`).join("\n")}\n`,
						{ headers: { "content-type": "text/csv" } },
					);
				return json({ illustrative: true, ...report });
			}
		}

		const resource = path.match(
			/^\/api\/(encoding-jobs|live-channels)(?:\/([^/]+))?(?:\/(.*))?$/,
		);
		if (resource) {
			const kind = resource[1] === "encoding-jobs" ? "vod" : "live";
			const id = resource[2];
			const suffix = resource[3];
			if (!id && get) {
				let items = state.entries
					.filter((entry) => entry.kind === kind)
					.map((entry) => record(entry, timestamp));
				const status = url.searchParams.get("status");
				const query = url.searchParams.get("q")?.toLowerCase();
				if (status) items = items.filter((item) => item.status === status);
				if (query)
					items = items.filter((item) =>
						String(item.name).toLowerCase().includes(query),
					);
				return page(items);
			}
			if (!id && method === "POST") {
				const input = await body(request);
				if (
					kind === "live" &&
					input.schedule !== undefined &&
					input.schedule !== null
				)
					return error(
						501,
						"Live schedules are not simulated in the browser demo. Turn off Schedule actions to create a demo channel. No channel was created and no cloud request was sent.",
					);
				return json(
					create(
						kind,
						input.plan,
						request.headers.get("Idempotency-Key") ?? undefined,
					),
					201,
				);
			}
			if (!id) return error(405);
			const entry = find(id, kind);
			const row = record(entry, timestamp);
			if (!suffix && get) return json(row);
			if (!suffix && method === "DELETE") {
				if (
					["QUEUED", "RUNNING", "PROVISIONING", "STOPPING"].includes(
						String(row.status),
					)
				)
					return error(409, "Stop this simulated record before deleting it.");
				state.entries = state.entries.filter((item) => item !== entry);
				heartbeatSnapshots.delete(id);
				persist();
				return new Response(null, { status: 204 });
			}
			if (!suffix && method === "PATCH" && kind === "live") {
				return error(
					501,
					"Runtime caps are not simulated in the browser demo. No limit was saved and no cloud request was sent.",
				);
			}
			if (kind === "vod") {
				if (suffix === "analysis" && get)
					return json({ enabled: false, source: null });
				if (suffix === "re-run-as-new" && method === "POST")
					return json(create("vod", entry.plan), 201);
				if (suffix === "cancel" && method === "POST") {
					entry.status = "CANCELED";
					persist();
					return json({ ok: true });
				}
			}
			if (kind === "live") {
				const run = row.currentRun as DemoRecord;
				const heartbeatLogPath = suffix?.match(/^runs\/([^/]+)\/heartbeats$/);
				if (heartbeatLogPath && get) {
					if (heartbeatLogPath[1] !== run.id)
						return error(404, "This run was not found on the demo channel.");
					return heartbeatLog(entry, run, url, timestamp);
				}
				if (suffix === "actions" && method === "POST") {
					const input = await body(request);
					if (input.action === "stop") entry.status = "STOPPED";
					else if (input.action === "start" || input.action === "restart") {
						entry.status = "RUNNING";
						entry.createdAt = timestamp - 1_200;
						entry.generation = Math.min(1000, (entry.generation ?? 0) + 1);
					} else return error(501);
					persist();
					return json({ ok: true, id: entry.id, simulated: true });
				}
				if (suffix === "alerts" && get) return json({ open: [], history: [] });
				if (suffix === "runs" && get) return json({ runs: [run] });
				if (suffix === "heartbeats" && get)
					return json(demoHeartbeatHistory(timestamp));
				if (suffix?.match(/^runs\/[^/]+\/health$/) && get)
					return json(demoHealth(row, timestamp));
				if (suffix?.match(/^runs\/[^/]+\/heartbeat-receipts$/) && get)
					return json({ items: [], truncated: false });
				if (suffix === "schedules" && get) return json([]);
				if (
					!get &&
					(suffix === "schedules" || suffix?.startsWith("schedules/"))
				)
					return error(
						501,
						"Live schedules are not simulated in the browser demo. No schedule was saved, changed, or removed and no cloud request was sent.",
					);
				if (
					[
						"dns-mappings",
						"insertable-content",
						"insertable-content/scheduled",
						"insertable-content/normalizations",
					].includes(suffix ?? "") &&
					get
				)
					return page([]);
			}
		}
		return error(501);
	}

	const demoFetch: typeof fetch = async (input, init) => {
		let request: Request;
		try {
			const inputUrl =
				input instanceof Request
					? input.url
					: input instanceof URL
						? input.href
						: input;
			const url = new URL(inputUrl, `${origin}/`);
			if (url.origin !== origin)
				return error(
					403,
					"External requests are disabled in the browser demo.",
				);
			request =
				input instanceof Request
					? new Request(input, init)
					: new Request(url, init);
			if (request.signal.aborted)
				throw new DOMException("The demo request was aborted.", "AbortError");
			if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
				return await route(request, url);
			const underBase = url.pathname.startsWith(
				assetBase.endsWith("/") ? assetBase : `${assetBase}/`,
			);
			const devAsset =
				/^\/(?:@vite\/client|@react-refresh|@fs\/|src\/|node_modules\/\.vite\/)/.test(
					url.pathname,
				);
			if (
				request.method === "GET" &&
				(underBase || devAsset) &&
				/\.(?:js|mjs|ts|tsx|css|woff2?|svg|png|jpe?g|webp|avif|ico|mp4|m4s|m3u8|mpd|vtt|json)$|^\/@(?:vite\/client|react-refresh)$/.test(
					url.pathname,
				) &&
				options.assetFetch
			) {
				return options.assetFetch(request, { credentials: "omit" });
			}
			return error(
				403,
				"Only bundled site assets and simulated API requests are available in the demo.",
			);
		} catch (failure) {
			if (failure instanceof DOMException && failure.name === "AbortError")
				throw failure;
			return error(
				failure instanceof DemoRequestError ? failure.status : 400,
				failure instanceof DemoRequestError
					? failure.message
					: "The demo request could not be read. No cloud request was sent.",
			);
		}
	};
	return {
		fetch: demoFetch,
		reset() {
			state = initialState(now());
			templates.length = 0;
			deletedReports.clear();
			heartbeatSnapshots.clear();
			try {
				options.storage?.removeItem(DEMO_STORAGE_KEY);
			} catch {
				/* Reset memory even when storage is unavailable. */
			}
		},
	};
}

let installed: ReturnType<typeof createDemoTransport> | undefined;

export function installDemoTransport(): void {
	if (installed) return;
	let storage: Store | undefined;
	try {
		storage = window.sessionStorage;
	} catch {
		/* Private browsing may disable storage. */
	}
	installed = createDemoTransport({
		storage,
		origin: window.location.origin,
		assetBase: import.meta.env.BASE_URL,
		assetFetch: window.fetch.bind(window),
	});
	const transport = installed;
	window.fetch = async (...args) => {
		const response = await transport.fetch(...args);
		if (response.status === 501) {
			const body = await response
				.clone()
				.json()
				.catch(() => null);
			if (typeof body?.error === "string") {
				window.dispatchEvent(
					new CustomEvent(DEMO_LIMITATION_EVENT, { detail: body.error }),
				);
			}
		}
		return response;
	};
}

export function resetDemoData(): void {
	installed?.reset();
	try {
		const prefix = `bitovp.wizard-draft:[${JSON.stringify(DEMO_ORGANIZATION_ID)},${JSON.stringify(DEMO_USER_ID)},`;
		const storage = window.localStorage;
		for (const key of Object.keys(storage)) {
			if (key.startsWith(prefix)) storage.removeItem(key);
		}
	} catch {
		/* Reset still works when draft storage is unavailable. */
	}
}

export { DEMO_LIVE_CHANNEL_ID, DEMO_VMAF_JOB_ID, DEMO_VOD_JOB_ID };
