import { createFeederSessionSchema } from "@bitovp/core";
import { z } from "zod";
import type {
	FeederSessionDetail,
	FeederSessionDiagnostics,
	FeederSessionListItem,
} from "@/app/live/feeders/feeder-shared";
import {
	DEMO_BUCKET,
	DEMO_LIVE_CHANNEL_ID,
	DEMO_STORAGE_ID,
	DEMO_VOD_SAMPLE_KEY,
	type DemoRecord,
} from "./fixtures";

const SAMPLE_ID = "00000000-0000-4000-8000-000000000801";
const DEMO_RTMP_URL = "rtmp://203.0.113.10/live";
const LOOP_MS = 10_000;
const MAX_SESSIONS = 25;
const listQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.uuid().optional(),
	liveChannelId: z.uuid().optional(),
});
const stopAction = z.strictObject({ action: z.literal("stop") });

type Session = {
	id: string;
	channelId: string;
	channelName: string;
	startedAt: number;
	stoppedAt: number | null;
};

function timestamp(time: number) {
	return new Date(time).toISOString();
}

function project(session: Session) {
	const startedAt = timestamp(session.startedAt);
	const stoppedAt =
		session.stoppedAt === null ? null : timestamp(session.stoppedAt);
	return {
		id: session.id,
		liveChannelId: session.channelId,
		protocol: "RTMP",
		status: stoppedAt === null ? "PUSHING" : "STOPPED",
		sourceBucket: DEMO_BUCKET,
		sourceKey: DEMO_VOD_SAMPLE_KEY,
		error: null,
		internalFailure: false,
		startedAt,
		stoppedAt,
		createdAt: startedAt,
		updatedAt: stoppedAt ?? startedAt,
	} satisfies Omit<FeederSessionListItem, "pid" | "processGoneAt">;
}

function diagnostics(session: Session, now: number): FeederSessionDiagnostics {
	const elapsed = Math.max(0, (session.stoppedAt ?? now) - session.startedAt);
	const count = Math.floor(elapsed / LOOP_MS);
	const retained = Math.min(count, 20);
	const recentLoopBoundaries = Array.from({ length: retained }, (_, index) => {
		const loopIndex = count - retained + index + 1;
		return {
			loopIndex,
			wallClock: timestamp(session.startedAt + loopIndex * LOOP_MS),
			streamTimeSec: (loopIndex * LOOP_MS) / 1_000,
		};
	});
	const startedAt = timestamp(session.startedAt);
	const logTail = [
		`${startedAt} [demo] Sample source prepared`,
		`${startedAt} [demo] RTMP input connected`,
		...recentLoopBoundaries.map(
			(loop) => `${loop.wallClock} [demo] Loop ${loop.loopIndex} completed`,
		),
	];
	if (session.stoppedAt !== null)
		logTail.push(`${timestamp(session.stoppedAt)} [demo] File input stopped`);
	return {
		pid: null,
		ownerHost: null,
		processGoneAt: null,
		error: null,
		logTail,
		loopBoundaryCount: count,
		recentLoopBoundaries,
	};
}

export function createDemoFeederRoutes({
	json,
	readBody,
	now,
	findChannel,
}: {
	json: (value: unknown, status?: number) => Response;
	readBody: (request: Request) => Promise<DemoRecord>;
	now: () => number;
	findChannel: (id: string) => DemoRecord | undefined;
}) {
	const sessions = new Map<string, Session>();

	function reset() {
		sessions.clear();
		const channel = findChannel(DEMO_LIVE_CHANNEL_ID);
		if (typeof channel?.name !== "string") return;
		const time = now();
		sessions.set(SAMPLE_ID, {
			id: SAMPLE_ID,
			channelId: DEMO_LIVE_CHANNEL_ID,
			channelName: channel.name,
			startedAt: time - 120_000,
			stoppedAt: time - 54_000,
		});
	}
	reset();

	function list(url: URL) {
		const parsed = listQuery.safeParse({
			limit: url.searchParams.get("limit") ?? undefined,
			cursor: url.searchParams.get("cursor") ?? undefined,
			liveChannelId: url.searchParams.get("liveChannelId") ?? undefined,
		});
		if (!parsed.success)
			return json({ error: "Invalid demo session filter." }, 400);
		const { limit, cursor, liveChannelId } = parsed.data;
		const rows = [...sessions.values()]
			.filter((row) => !liveChannelId || row.channelId === liveChannelId)
			.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
		const offset = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
		if (cursor && offset === 0)
			return json({ error: "The demo session cursor was not found." }, 404);
		const items: FeederSessionListItem[] = rows
			.slice(offset, offset + limit)
			.map((row) => ({
				...project(row),
				liveChannel: { name: row.channelName },
				pid: null,
				processGoneAt: null,
			}));
		return json({
			items,
			nextCursor: offset + limit < rows.length ? items.at(-1)?.id : undefined,
		});
	}

	function create(body: DemoRecord) {
		const parsed = createFeederSessionSchema.safeParse(body);
		if (!parsed.success)
			return json({ error: "Invalid demo file input." }, 400);
		const input = parsed.data;
		if (
			input.source.credentialId !== DEMO_STORAGE_ID ||
			input.source.bucket !== DEMO_BUCKET ||
			input.source.key !== DEMO_VOD_SAMPLE_KEY ||
			input.protocol !== "RTMP" ||
			input.target.url !== DEMO_RTMP_URL ||
			input.target.streamKey !== "demo-stream-key"
		)
			return json(
				{
					error:
						"Use the bundled sample and the demo RTMP destination. No cloud request was sent.",
				},
				501,
			);
		const channel = findChannel(input.liveChannelId);
		if (typeof channel?.name !== "string")
			return json({ error: "The demo channel was not found." }, 404);
		if (channel.status !== "RUNNING" && channel.status !== "PROVISIONING")
			return json({ error: "Start the demo channel before feeding it." }, 409);
		const active = [...sessions.values()].find(
			(row) => row.channelId === input.liveChannelId && row.stoppedAt === null,
		);
		if (Boolean(active) !== Boolean(input.switchFromActive))
			return json(
				{
					error: active
						? "The demo channel already has a file input."
						: "There is no demo file input to switch from.",
				},
				409,
			);
		if (sessions.size >= MAX_SESSIONS)
			return json(
				{
					error: "Delete an ended demo session or reset the demo to continue.",
				},
				409,
			);
		const id = crypto.randomUUID();
		const time = now();
		if (active) active.stoppedAt = time;
		sessions.set(id, {
			id,
			channelId: input.liveChannelId,
			channelName: channel.name,
			startedAt: time,
			stoppedAt: null,
		});
		return json({ id, status: "PUSHING" }, 201);
	}

	return {
		async route(request: Request, url: URL): Promise<Response | undefined> {
			const match =
				/^\/api\/feeder-sessions(?:\/([^/]+)(\/actions)?)?\/?$/.exec(
					url.pathname,
				);
			if (!match) return undefined;
			const [, id, action] = match;
			const method = request.method;
			if (!id) {
				if (method === "GET") return list(url);
				if (method === "POST") return create(await readBody(request));
				return undefined;
			}
			if (action && method === "POST") {
				const parsed = stopAction.safeParse(await readBody(request));
				if (!parsed.success)
					return json({ error: "Invalid demo file input action." }, 400);
			}
			const row = sessions.get(id);
			if (!row) return json({ error: "The demo session was not found." }, 404);
			const stoppable = row.stoppedAt === null;
			if (action && method === "POST") {
				if (!stoppable)
					return json(
						{ error: "The demo file input has already stopped." },
						409,
					);
				row.stoppedAt = now();
				return json({ id, action: "stop", status: "STOPPED" });
			}
			if (!action && method === "GET") {
				if (url.searchParams.get("diagnostics") === "1")
					return json(diagnostics(row, now()));
				return json({
					...project(row),
					target: { url: DEMO_RTMP_URL },
					stoppable,
				} satisfies FeederSessionDetail);
			}
			if (!action && method === "DELETE") {
				if (stoppable)
					return json(
						{ error: "Stop the demo file input before deleting it." },
						409,
					);
				sessions.delete(id);
				return new Response(null, { status: 204 });
			}
			return undefined;
		},
		stopChannel(id: string) {
			for (const session of sessions.values()) {
				if (session.channelId === id && session.stoppedAt === null)
					session.stoppedAt = now();
			}
		},
		deleteChannel(id: string) {
			for (const [key, session] of sessions) {
				if (session.channelId === id) sessions.delete(key);
			}
		},
		reset,
	};
}
