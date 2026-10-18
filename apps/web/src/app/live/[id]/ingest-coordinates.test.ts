import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { messagesFor, translate } from "@/lib/i18n";
import { ingestCoordinates } from "./ingest-coordinates";

const fixturesDir = join(
	__dirname,
	"../../../../../../packages/core/src/live/__fixtures__",
);

function loadPlan(name: string) {
	return liveChannelPlanSchema.parse(
		JSON.parse(readFileSync(join(fixturesDir, `${name}.plan.json`), "utf8")),
	);
}

describe("ingestCoordinates", () => {
	it.each([
		"GENERATE",
		"ASSIGN",
	] as const)("never offers the generic key for static %s, before or after live details", (type) => {
		const plan = loadPlan("live-static-ingest");
		plan.liveInput = {
			key: "main",
			kind: "REDUNDANT_RTMP",
			name: "Static input",
			staticIngestPoints: [
				{
					name: "primary",
					streamKeyConfiguration: {
						type,
						...(type === "ASSIGN"
							? { streamKeyId: "11111111-1111-4111-8111-111111111111" }
							: {}),
					},
				},
			],
		};
		for (const key of [null, "genericLiveDetailsKey"]) {
			const rows = ingestCoordinates(plan, key, null);
			expect(rows).toContainEqual(
				expect.objectContaining({
					labelKey: "ingest.streamKey",
					value: null,
					valueKey: "feeder.staticKeyHint",
					copyable: false,
				}),
			);
			expect(rows).toContainEqual(
				expect.objectContaining({
					labelKey: "ingest.staticIngestPointNamed",
					copyable: true,
				}),
			);
			expect(
				rows.some((row) => row.value === (key ?? plan.start.streamKey)),
			).toBe(false);
		}
	});

	it("derives the RTMP push URL, stream key and combined target", () => {
		const rows = ingestCoordinates(
			loadPlan("live-rtmp-simple"),
			"liveKey",
			"203.0.113.99",
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.rtmpPushUrl",
				value: "rtmp://203.0.113.99/live",
				copyable: true,
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.streamKey",
				value: "liveKey",
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.fullRtmpTarget",
				value: "rtmp://203.0.113.99/live/liveKey",
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.encoderIp",
				value: "203.0.113.99",
			}),
		);
	});

	it("marks coordinates pending (not copyable) before the encoder IP exists", () => {
		const rows = ingestCoordinates(loadPlan("live-rtmp-simple"), null, null);
		const push = rows.find((r) => r.labelKey === "ingest.rtmpPushUrl");
		expect(push?.copyable).toBe(false);
		// `null` IS the pending signal now — the copy lives in the catalogue, so the
		// caller formats it and this stays a data assertion.
		expect(push?.value).toBeNull();
		// streamKey column absent → the plan's start.streamKey is shown.
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.streamKey",
				value: "myStreamKey",
			}),
		);
	});

	it("forms the SRT listener URL (and backups) from the encoder IP and ports", () => {
		const rows = ingestCoordinates(
			loadPlan("live-srt-listener"),
			"abc",
			"198.51.100.7",
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.srtCallerTarget",
				value: "srt://198.51.100.7:2088",
				copyable: true,
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.backupListenerN",
				labelValues: { n: 1 },
				value: "srt://198.51.100.7:2089",
			}),
		);
	});

	it("gives a CALLER backup its host:port as localized prose, not a coordinate", () => {
		// A CALLER backup is an address Bitmovin dials, so main rendered
		// "Bitmovin calls host:port" in the value column. That column is the one
		// always on screen — the hint beside it is `hidden` below `lg` — so the copy
		// rides `valueKey` rather than `hintKey`, and the host/port stay data.
		const listener = loadPlan("live-srt-listener");
		const plan = {
			...listener,
			liveInput: {
				...listener.liveInput,
				backup: {
					srtInputs: [
						{ mode: "CALLER" as const, host: "203.0.113.40", port: 9001 },
					],
				},
			},
		} as typeof listener;
		const rows = ingestCoordinates(plan, "abc", "198.51.100.7");
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.backupListenerN",
				labelValues: { n: 1 },
				value: null,
				valueKey: "ingest.bitmovinCallsHost",
				valueValues: { host: "203.0.113.40", port: 9001 },
				// never copyable: there is nothing to paste into an encoder here
				copyable: false,
			}),
		);
	});

	it("points SRT caller mode at the source (Bitmovin dials out)", () => {
		const rows = ingestCoordinates(loadPlan("live-srt-caller"), "abc", null);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.srtSourceBitmovinCalls",
				value: "203.0.113.10:7000",
				copyable: true,
			}),
		);
	});

	it("lists redundant-RTMP ingest points per application name", () => {
		const rows = ingestCoordinates(
			loadPlan("live-redundant-rtmp"),
			"redundantKey",
			"192.0.2.5",
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.ingestPointNamed",
				labelValues: { name: "liveA" },
				value: "rtmp://192.0.2.5/liveA/primaryFeed",
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.ingestPointNamed",
				labelValues: { name: "liveB" },
				value: "rtmp://192.0.2.5/liveB/backupFeed",
			}),
		);
	});

	it("shows the Zixi pull source", () => {
		const rows = ingestCoordinates(loadPlan("live-zixi"), "zKey", null);
		expect(rows).toContainEqual(
			expect.objectContaining({
				labelKey: "ingest.zixiSource",
				value: "zixi-feeder.example.com:2077 / channelOne",
			}),
		);
	});
});

/**
 * The dynamic `t(coordinate.labelKey, coordinate.labelValues)` calls in
 * `channel-detail.tsx` are invisible to `__tests__/t-call-sites.test.ts`, which only
 * matches `t("literal")`. Nothing verified that a coordinate's placeholder names
 * match the values it ships — the same class that made the live wizard's Output step
 * throw and land on `global-error`.
 *
 * So translate every coordinate this function can produce, in both locales:
 * `translate` throws on a missing key or an unfilled placeholder, which turns this
 * into an assertion by construction.
 */
describe("every coordinate translates in both locales", () => {
	// Every live fixture on disk, so a new one is covered without editing this list.
	const FIXTURES = readdirSync(fixturesDir)
		.filter((f) => f.endsWith(".plan.json"))
		.map((f) => f.replace(".plan.json", ""));

	it("renders no missing key and no unfilled placeholder", () => {
		let checked = 0;
		for (const name of FIXTURES) {
			let plan: ReturnType<typeof loadPlan>;
			try {
				plan = loadPlan(name);
			} catch {
				continue; // a fixture set that does not carry this scenario
			}
			// every streamKey / encoderIp combination, since both gate whole branches
			for (const streamKey of [null, "abc"]) {
				for (const encoderIp of [null, "198.51.100.7"]) {
					for (const rows of [ingestCoordinates(plan, streamKey, encoderIp)]) {
						for (const row of rows) {
							for (const locale of ["en", "ja"] as const) {
								const messages = messagesFor(locale);
								translate(messages, row.labelKey, row.labelValues);
								if (row.hintKey) {
									translate(messages, row.hintKey);
								}
								if (row.valueKey) {
									translate(messages, row.valueKey, row.valueValues);
								}
								checked += 1;
							}
							// a pending row is never copyable, and a prose row never carries
							// both a literal value and a key
							if (row.value === null) {
								expect(row.copyable, row.labelKey).toBe(false);
							}
							if (row.valueKey) {
								expect(row.value, row.labelKey).toBeNull();
							}
						}
					}
				}
			}
		}
		expect(checked).toBeGreaterThan(80);
	});
});
