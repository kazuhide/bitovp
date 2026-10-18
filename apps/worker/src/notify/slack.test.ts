import {
	EVENT_VERSION,
	feederError,
	feederErrorEnglish,
	productEventSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { renderSlackMessage } from "./slack";

/**  PR2: blocks derive from the STRICT union — leak boundary inherited. */

const JOB = "00000000-0000-4000-8000-0000000000aa";

function make(over: Record<string, unknown>) {
	return productEventSchema.parse({
		eventVersion: EVENT_VERSION,
		occurredAt: "2026-08-12T00:00:00.000Z",
		link: `https://ovp.example.com/vod/jobs/${JOB}`,
		...over,
	});
}

describe("renderSlackMessage", () => {
	it("renders headline, link, labels and the fenced error", () => {
		const message = renderSlackMessage(
			make({
				kind: "JOB_ERROR",
				jobId: JOB,
				name: "nightly drama",
				labels: ["prod"],
				error: "encoder exploded",
			}),
		);
		expect(message.text).toBe(
			"🔴 Encoding failed: nightly drama — encoder exploded",
		);
		const json = JSON.stringify(message.blocks);
		expect(json).toContain("nightly drama");
		expect(json).toContain("encoder exploded");
		expect(json).toContain(`https://ovp.example.com/vod/jobs/${JOB}`);
		expect(json).toContain("prod");
	});

	//  review: a FEEDER_ERROR whose stored `error` is a structured
	// `{code, params}` refusal must reach Slack as the ENGLISH SENTENCE (the
	// emit site renders it through `feederErrorEnglish`), never as raw JSON. The
	// existing coverage used `error: "e"`, which is exactly why the leak slipped
	// through — this arm carries a REAL payload.
	it("a FEEDER_ERROR carrying a structured refusal shows English, never the JSON", () => {
		const emitted = feederErrorEnglish(
			feederError("sourceMismatch", {
				originKind: "runSource",
				differences: "frame rate 30000/1001 → 24/1",
			}),
		);
		const message = renderSlackMessage(
			make({
				kind: "FEEDER_ERROR",
				feederSessionId: JOB,
				liveChannelId: JOB,
				error: emitted,
			}),
		);
		const json = JSON.stringify(message.blocks);
		// The operator reads the sentence and the diff…
		expect(message.text).toContain(
			"does not match what this channel is ingesting",
		);
		expect(message.text).toContain("the source this run started on");
		expect(json).toContain("frame rate 30000/1001 → 24/1");
		// …and never the machine payload.
		expect(message.text).not.toContain("sourceMismatch");
		expect(message.text).not.toContain('{"code"');
		expect(json).not.toContain("sourceMismatch");
		expect(json).not.toContain("originKind");
	});

	it("covers EVERY kind with a headline (a new kind cannot render undefined)", () => {
		// Per-kind MINIMAL payloads (the union is strict — a kitchen-sink
		// object is rejected, which is the point of the leak boundary). The
		// table is pinned to the union in both directions like the core test.
		const minimal: Record<string, Record<string, unknown>> = {
			JOB_FINISHED: { jobId: JOB, name: "x" },
			JOB_ERROR: { jobId: JOB, name: "x", error: "e" },
			JOB_CANCELED: { jobId: JOB, name: "x" },
			JOB_QC_FAILED: { jobId: JOB, name: "x", reason: "r" },
			CHANNEL_RUNNING: { liveChannelId: JOB, name: "c" },
			CHANNEL_ERROR: { liveChannelId: JOB, name: "c", error: "e" },
			CHANNEL_STOPPED: { liveChannelId: JOB, name: "c" },
			FEEDER_ERROR: { feederSessionId: JOB, liveChannelId: JOB, error: "e" },
			VMAF_FINISHED: { vmafJobId: JOB },
			VMAF_ERROR: { vmafJobId: JOB, error: "e" },
			ALERT_OPENED: { alertId: JOB, liveChannelId: JOB, rule: "drops" },
			ALERT_RESOLVED: { alertId: JOB, liveChannelId: JOB, rule: "drops" },
			SCHEDULE_MISSED: { scheduleId: JOB, liveChannelId: JOB, reason: "r" },
			SCHEDULE_FIRED: { scheduleId: JOB, liveChannelId: JOB },
			SCHEDULE_NOT_RUNNING_AT_DEADLINE: {
				scheduleId: JOB,
				liveChannelId: JOB,
				airAt: "2026-08-22T00:00:00.000Z",
				channelStatus: "CREATED",
			},
			WATCH_SUBMITTED: {
				watchFolderId: JOB,
				objectPath: "in/a.mov",
				jobId: JOB,
			},
			WATCH_ERROR: { watchFolderId: JOB, objectPath: "in/a.mov", error: "e" },
			INGRESS_CHANGED: {
				mode: "quick-tunnel",
				baseUrl: "https://a.trycloudflare.com",
				previousBaseUrl: null,
			},
		};
		const kinds = productEventSchema.options.map(
			(option) => option.shape.kind.value,
		);
		expect(Object.keys(minimal).sort()).toEqual([...kinds].sort());
		// Expected SUBJECT per kind (review-185 N2: banning the literal
		// "undefined" left the fallback ORDER unpinned — deleting the
		// objectPath branch survived while WATCH_* degraded to echoing the
		// kind as its own subject).
		const subject: Record<string, string> = {
			JOB_FINISHED: "x",
			JOB_ERROR: "x",
			JOB_CANCELED: "x",
			JOB_QC_FAILED: "x",
			CHANNEL_RUNNING: "c",
			CHANNEL_ERROR: "c",
			CHANNEL_STOPPED: "c",
			FEEDER_ERROR: JOB,
			VMAF_FINISHED: JOB,
			VMAF_ERROR: JOB,
			ALERT_OPENED: JOB,
			ALERT_RESOLVED: JOB,
			SCHEDULE_MISSED: JOB,
			SCHEDULE_FIRED: JOB,
			SCHEDULE_NOT_RUNNING_AT_DEADLINE: JOB,
			WATCH_SUBMITTED: "in/a.mov",
			WATCH_ERROR: "in/a.mov",
			// WP-G G-1: the new URL is the subject — an operator reading Slack
			// needs the value, not the kind echoed back.
			INGRESS_CHANGED: "https://a.trycloudflare.com",
		};
		for (const [kind, payload] of Object.entries(minimal)) {
			const message = renderSlackMessage(make({ kind, ...payload }));
			expect(message.text, kind).not.toContain("undefined");
			expect(message.text, kind).toContain(subject[kind] ?? "");
		}
	});

	it("ESCAPES mrkdwn in every interpolated field (review-185 I1 — the forged-link payloads)", () => {
		// The reviewer's demonstrated payloads, verbatim: each rendered a LIVE
		// forged Slack link before the escaping landed.
		const forged = renderSlackMessage(
			make({
				kind: "WATCH_ERROR",
				watchFolderId: JOB,
				objectPath:
					"a.mov> <https://evil.example/phish|CLICK TO APPROVE RELEASE",
				error: "```fence-break``` <https://evil.example|retry here>",
			}),
		);
		const json = JSON.stringify(forged.blocks);
		// No angle bracket from the PAYLOAD survives un-escaped — the only <…>
		// in the whole message is OUR link, whose URL we authored.
		expect(json).not.toContain("<https://evil.example");
		expect(json).toContain("&lt;https://evil.example");
		// The fence cannot be closed from inside.
		expect(json).not.toContain("```fence-break```");
		const labelForged = renderSlackMessage(
			make({
				kind: "JOB_FINISHED",
				jobId: JOB,
				name: "ok",
				labels: ["<https://evil.example|ALL CLEAR>"],
			}),
		);
		expect(JSON.stringify(labelForged.blocks)).not.toContain(
			"<https://evil.example",
		);
	});

	it("escapes & FIRST — reordering double-encodes (review-185 closeout)", () => {
		// Their caveat: .replace(<) before (&) leaves the fixtures green while
		// output degrades to &amp;lt;. Pin the order by its observable.
		const message = renderSlackMessage(
			make({ kind: "JOB_FINISHED", jobId: JOB, name: "A&B <tag>", labels: [] }),
		);
		const json = JSON.stringify(message.blocks);
		expect(json).toContain("A&amp;B &lt;tag&gt;");
		expect(json).not.toContain("&amp;lt;");
	});

	it("a subject-less vmaf event falls back to its id, never 'undefined'", () => {
		const message = renderSlackMessage(
			make({ kind: "VMAF_FINISHED", vmafJobId: JOB }),
		);
		expect(message.text).toContain(JOB);
		expect(message.text).not.toContain("undefined");
	});
});
