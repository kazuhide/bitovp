import { describe, expect, it } from "vitest";
import {
	EVENT_VERSION,
	eventMatchesFilter,
	notificationRuleFilterSchema,
	PRODUCT_EVENT_KINDS,
	productEventSchema,
} from "./schema";

/**
 * : the event union is the leak boundary — the payload contract
 * says ids/names/labels/error/link and NOTHING else, so strictness is the
 * security property, not a style choice.
 */

const envelope = {
	eventVersion: EVENT_VERSION,
	occurredAt: "2026-08-12T00:00:00.000Z",
	link: "https://ovp.example.com/vod/jobs/x",
};

const JOB = "00000000-0000-4000-8000-0000000000aa";

describe("productEventSchema", () => {
	it("accepts every declared kind with its minimal payload", () => {
		const minimal: Record<string, Record<string, unknown>> = {
			JOB_FINISHED: { jobId: JOB, name: "j" },
			JOB_ERROR: { jobId: JOB, name: "j", error: "boom" },
			JOB_CANCELED: { jobId: JOB, name: "j" },
			JOB_QC_FAILED: { jobId: JOB, name: "j", reason: "vmaf < floor" },
			CHANNEL_RUNNING: { liveChannelId: JOB, name: "c" },
			CHANNEL_ERROR: { liveChannelId: JOB, name: "c", error: "boom" },
			CHANNEL_STOPPED: { liveChannelId: JOB, name: "c" },
			FEEDER_ERROR: {
				feederSessionId: JOB,
				liveChannelId: JOB,
				error: "boom",
			},
			VMAF_FINISHED: { vmafJobId: JOB },
			VMAF_ERROR: { vmafJobId: JOB, error: "boom" },
			ALERT_OPENED: { alertId: JOB, liveChannelId: JOB, rule: "drops" },
			ALERT_RESOLVED: { alertId: JOB, liveChannelId: JOB, rule: "drops" },
			SCHEDULE_MISSED: { scheduleId: JOB, liveChannelId: JOB, reason: "x" },
			SCHEDULE_NOT_RUNNING_AT_DEADLINE: {
				scheduleId: JOB,
				liveChannelId: JOB,
				airAt: "2026-08-22T00:00:00.000Z",
				channelStatus: "CREATED",
			},
			SCHEDULE_FIRED: { scheduleId: JOB, liveChannelId: JOB },
			WATCH_SUBMITTED: {
				watchFolderId: JOB,
				objectPath: "in/a.mov",
				jobId: JOB,
			},
			WATCH_ERROR: { watchFolderId: JOB, objectPath: "in/a.mov", error: "x" },
			INGRESS_CHANGED: {
				mode: "quick-tunnel",
				baseUrl: "https://a.trycloudflare.com",
				previousBaseUrl: null,
			},
		};
		// The table IS the union: a kind added to the schema without a row here
		// fails, and a row without a schema kind fails below.
		expect(Object.keys(minimal).sort()).toEqual(
			[...PRODUCT_EVENT_KINDS].sort(),
		);
		for (const [kind, payload] of Object.entries(minimal)) {
			const parsed = productEventSchema.safeParse({
				kind,
				...envelope,
				...payload,
			});
			expect(parsed.success, kind).toBe(true);
		}
	});

	it("REJECTS an unknown field — the leak boundary", () => {
		const parsed = productEventSchema.safeParse({
			kind: "JOB_FINISHED",
			...envelope,
			jobId: JOB,
			name: "j",
			// The exact class the design forbids: plan JSON riding along.
			plan: { inputs: [] },
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a non-URL link and a non-ISO timestamp", () => {
		expect(
			productEventSchema.safeParse({
				kind: "JOB_FINISHED",
				...envelope,
				link: "/vod/jobs/x",
				jobId: JOB,
				name: "j",
			}).success,
		).toBe(false);
		expect(
			productEventSchema.safeParse({
				kind: "JOB_FINISHED",
				...envelope,
				occurredAt: "yesterday",
				jobId: JOB,
				name: "j",
			}).success,
		).toBe(false);
	});
});

describe("eventMatchesFilter", () => {
	const jobEvent = productEventSchema.parse({
		kind: "JOB_FINISHED",
		...envelope,
		jobId: JOB,
		name: "j",
		labels: ["prod", "drama"],
	});
	const channelEvent = productEventSchema.parse({
		kind: "CHANNEL_ERROR",
		...envelope,
		liveChannelId: JOB,
		name: "c",
		error: "boom",
	});

	it.each([
		["empty filter matches", {}, jobEvent, true],
		["label overlap matches", { labels: ["drama"] }, jobEvent, true],
		// ANY-overlap, not all (review-183 N1: .some→.every survived 2831
		// tests — no row had a multi-label filter with partial overlap).
		[
			"partial overlap matches (ANY, not ALL)",
			{ labels: ["news", "drama"] },
			jobEvent,
			true,
		],
		["label miss refuses", { labels: ["news"] }, jobEvent, false],
		[
			"label filter refuses a label-less event family",
			{ labels: ["prod"] },
			channelEvent,
			false,
		],
		[
			"channel filter matches its channel",
			{ liveChannelIds: [JOB] },
			channelEvent,
			true,
		],
		[
			"channel filter refuses an event without liveChannelId",
			{ liveChannelIds: [JOB] },
			jobEvent,
			false,
		],
	] as const)("%s", (_name, filter, event, expected) => {
		expect(
			eventMatchesFilter(event, notificationRuleFilterSchema.parse(filter)),
		).toBe(expected);
	});
});
