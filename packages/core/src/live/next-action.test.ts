import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	LIVE_CHANNEL_STATUS_VALUES,
	type LiveNextActionInput,
	liveNextAction,
} from "./next-action";

const REPO_ROOT = join(__dirname, "../../../..");

const base: LiveNextActionInput = {
	status: "RUNNING",
	ingestConnected: true,
	hasEncoding: true,
	playableCount: 1,
	armedStartCount: 0,
	overdueArmedCount: 0,
	openAlerts: 0,
};
const at = (over: Partial<LiveNextActionInput>) =>
	liveNextAction({ ...base, ...over });

describe("liveNextAction — the page's first layer (ledger #103)", () => {
	it("is TOTAL over the status enum — every status yields an action", () => {
		// A status added to the DB and forgotten here would otherwise fall
		// through to NOTHING_TO_DO, i.e. the page would tell an operator there
		// is nothing to do on a state nobody has thought about.
		// Crossed with the alert tri-state: the
		// `"unknown"` arm must be total too, or a status added later would
		// fall through to NOTHING_TO_DO only when the alerts query happened
		// to be down — the hardest class of bug to reproduce.
		for (const status of LIVE_CHANNEL_STATUS_VALUES) {
			for (const openAlerts of [0, 2, "unknown"] as const) {
				const action = at({ status, openAlerts });
				expect(action.code, `${status}/${openAlerts}`).toBeTruthy();
				expect(action.section, `${status}/${openAlerts}`).toMatch(/^sec-/);
			}
		}
	});

	it("ranks a failed start above everything, and points at the encoder only when one exists", () => {
		expect(at({ status: "ERROR", hasEncoding: true })).toEqual({
			code: "RECOVER_FROM_ERROR",
			tone: "act",
			section: "sec-actions",
		});
		// No encoding ⇒ the step log is where the failure is readable; the
		// action buttons would have nothing to act on.
		expect(at({ status: "ERROR", hasEncoding: false }).section).toBe(
			"sec-steps",
		);
		// ERROR outranks even an armed schedule and open alerts.
		expect(
			at({ status: "ERROR", armedStartCount: 3, openAlerts: 2 }).code,
		).toBe("RECOVER_FROM_ERROR");
	});

	it("a RUNNING channel with no connected ingest outranks its alerts — the 2026-08-15 incident's stage ③", () => {
		expect(
			at({ status: "RUNNING", ingestConnected: false, openAlerts: 5 }),
		).toEqual({ code: "CONNECT_INPUT", tone: "act", section: "sec-feeders" });
	});

	it("row #280: a RUNNING channel whose PROVIDER view is unknown is PROVIDER_UNKNOWN (act, never watch) — ahead of ingest, alerts and output; other statuses keep their verb", () => {
		// The healthiest possible page otherwise — connected, no alerts, a
		// playable manifest — must still not say ON_AIR on a lost observation.
		expect(at({ providerUnknown: true })).toEqual({
			code: "PROVIDER_UNKNOWN",
			tone: "act",
			section: "sec-actions",
		});
		expect(
			at({ providerUnknown: true, ingestConnected: false, openAlerts: 5 }).code,
		).toBe("PROVIDER_UNKNOWN");
		expect(at({ providerUnknown: true, openAlerts: "unknown" }).code).toBe(
			"PROVIDER_UNKNOWN",
		);
		// Absent or false: the pre-#280 answer.
		expect(at({ providerUnknown: false }).code).toBe("ON_AIR");
		expect(at({}).code).toBe("ON_AIR");
		// Only RUNNING asks the question: ERROR is still a recovery, STOPPED a
		// new run, PROVISIONING a boot.
		expect(at({ status: "ERROR", providerUnknown: true }).code).toBe(
			"RECOVER_FROM_ERROR",
		);
		expect(at({ status: "STOPPED", providerUnknown: true }).code).toBe(
			"START_NEW_RUN",
		);
		expect(at({ status: "PROVISIONING", providerUnknown: true }).code).toBe(
			"WAIT_FOR_BOOT",
		);
	});

	it("walks a healthy RUNNING channel from alerts to output to on-air", () => {
		expect(at({ openAlerts: 1 }).code).toBe("REVIEW_ALERTS");
		expect(at({ openAlerts: 0, playableCount: 0 }).code).toBe(
			"WAIT_FOR_OUTPUT",
		);
		expect(at({ openAlerts: 0, playableCount: 2 })).toEqual({
			code: "ON_AIR",
			tone: "watch",
			section: "sec-actions",
		});
	});

	it("an alert list that could not be READ is never ON_AIR", () => {
		// The production shape: a RUNNING channel whose alerts query failed.
		// The web layer passed `alerts.data?.open.length ?? 0`, which made
		// that indistinguishable from a measured zero, so a channel nobody
		// could monitor got the emerald ON_AIR card. Table over the
		// surroundings that would otherwise have produced a reassuring
		// answer — every one of them must yield the unknown action instead.
		const cases: { why: string; over: Partial<LiveNextActionInput> }[] = [
			{ why: "playable output, everything else healthy", over: {} },
			{ why: "several playable renditions", over: { playableCount: 5 } },
			{ why: "output not up yet", over: { playableCount: 0 } },
			{ why: "a schedule armed as well", over: { armedStartCount: 1 } },
			{ why: "no encoding recorded", over: { hasEncoding: false } },
		];
		for (const { why, over } of cases) {
			const action = at({ ...over, status: "RUNNING", openAlerts: "unknown" });
			expect(action.code, why).not.toBe("ON_AIR");
			expect(action, why).toEqual({
				code: "ALERTS_UNKNOWN",
				// `act`, never `watch`: an unmonitored channel must not be
				// painted with the healthy treatment.
				tone: "act",
				section: "sec-alerts",
			});
		}
	});

	it("unknown alerts do not outrank a failed start or a disconnected ingest, and off-air states ignore them", () => {
		// The unknown takes the ALERT slot's priority — no more, no less.
		expect(at({ status: "ERROR", openAlerts: "unknown" }).code).toBe(
			"RECOVER_FROM_ERROR",
		);
		expect(
			at({ status: "RUNNING", ingestConnected: false, openAlerts: "unknown" })
				.code,
		).toBe("CONNECT_INPUT");
		// Off air, the alert list is not what the operator acts on.
		expect(at({ status: "STOPPED", openAlerts: "unknown" }).code).toBe(
			"START_NEW_RUN",
		);
		expect(at({ status: "PROVISIONING", openAlerts: "unknown" }).code).toBe(
			"WAIT_FOR_BOOT",
		);
		expect(at({ status: "STOPPING", openAlerts: "unknown" }).code).toBe(
			"WAIT_FOR_STOP",
		);
		expect(at({ status: "CREATED", openAlerts: "unknown" }).code).toBe(
			"START_ENCODER",
		);
	});

	it("never says START on a channel whose schedule will start it", () => {
		// The pre-air state the owner actually operates in: created, armed,
		// waiting for 10:00. "Start the encoder" would be wrong advice.
		expect(at({ status: "CREATED", armedStartCount: 1 }).code).toBe(
			"SCHEDULED_ONLY",
		);
		expect(at({ status: "CREATED", armedStartCount: 0 }).code).toBe(
			"START_ENCODER",
		);
		expect(at({ status: "STOPPED", armedStartCount: 1 }).code).toBe(
			"SCHEDULED_ONLY",
		);
		//  PR3: a STOPPED channel's honest verb is a NEW RUN — the
		// old NOTHING_TO_DO pinned the model gap #110 recorded.
		expect(at({ status: "STOPPED", armedStartCount: 0 }).code).toBe(
			"START_NEW_RUN",
		);
		// IDLE (derived — never ran) shares CREATED's verb: start the encoder.
		expect(at({ status: "IDLE", armedStartCount: 0 }).code).toBe(
			"START_ENCODER",
		);
		expect(at({ status: "IDLE", armedStartCount: 1 }).code).toBe(
			"SCHEDULED_ONLY",
		);
	});

	it("treats both transitional states as waits — and never calls a STOP a boot", () => {
		expect(at({ status: "PROVISIONING" })).toEqual({
			code: "WAIT_FOR_BOOT",
			tone: "wait",
			section: "sec-actions",
		});
		// review-234 I2: STOPPING used to render the BOOT copy, which says
		// "the encoder instance is coming up" and quotes the boot measurement
		// (n=4) — wrong twice, on a channel shutting down. Asserting the CODE,
		// not just the tone, is what makes that a failure.
		expect(at({ status: "STOPPING" })).toEqual({
			code: "WAIT_FOR_STOP",
			tone: "wait",
			section: "sec-steps",
		});
	});

	it("an armed STOP is NOT 'the schedule will act' — review-234 C1", () => {
		// The everyday route in: START 10:00 / STOP 11:00, the worker restarts,
		// the START is marked MISSED past its grace, and the STOP stays armed.
		// The page used to say "you do not have to start anything by hand" for
		// the next ~50 minutes, with the programme off air.
		expect(
			at({ status: "STOPPED", armedStartCount: 0, overdueArmedCount: 0 }).code,
			// #108 PR3: START_NEW_RUN — an act tone, so the off-air programme
			// is a visible call to action, never a shrug.
		).toBe("START_NEW_RUN");
		expect(
			at({ status: "CREATED", armedStartCount: 0, overdueArmedCount: 0 }).code,
		).toBe("START_ENCODER");
	});

	it("an OVERDUE armed row means the sweep is not running — never promise automation", () => {
		// The sweep reaps due rows within one 30s tick, so a row still armed
		// past its deadline is evidence the worker is down. Promising that a
		// dead automation will act is the exact false reassurance this layer
		// exists to remove.
		expect(
			at({ status: "STOPPED", armedStartCount: 2, overdueArmedCount: 1 }).code,

			// #108 PR3: the fallback for a dead sweep on a STOPPED channel is
			// the manual verb — START_NEW_RUN, an act tone the operator sees.
		).toBe("START_NEW_RUN");
		expect(
			at({ status: "CREATED", armedStartCount: 2, overdueArmedCount: 1 }).code,
		).toBe("START_ENCODER");
		// Healthy sweep, armed START ⇒ the promise is honest.
		expect(
			at({ status: "CREATED", armedStartCount: 1, overdueArmedCount: 0 }).code,
		).toBe("SCHEDULED_ONLY");
	});

	it("the status union matches the Prisma enum AND the web layer's list", () => {
		// Core is the canonical home; these are the two places the same six
		// values are spelled out. A fork in either direction is a real defect:
		// the DB would accept a status this function cannot rank, or the web
		// list would offer one the DB rejects.
		const prisma = readFileSync(
			join(REPO_ROOT, "packages/db/prisma/schema.prisma"),
			"utf8",
		);
		const block = /enum LiveChannelStatus \{([^}]*)\}/.exec(prisma)?.[1];
		expect(
			block,
			"LiveChannelStatus enum not found in schema.prisma",
		).toBeTruthy();
		const fromPrisma = (block as string)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("//"));
		expect(fromPrisma).toEqual([...LIVE_CHANNEL_STATUS_VALUES]);

		const shared = readFileSync(
			join(REPO_ROOT, "apps/web/src/app/live/live-shared.ts"),
			"utf8",
		);
		const webBlock = /LIVE_CHANNEL_STATUSES = \[([^\]]*)\]/.exec(shared)?.[1];
		expect(
			webBlock,
			"LIVE_CHANNEL_STATUSES not found in live-shared.ts",
		).toBeTruthy();
		const fromWeb = [...(webBlock as string).matchAll(/"([A-Z_]+)"/g)].map(
			(m) => m[1],
		);
		expect(fromWeb).toEqual([...LIVE_CHANNEL_STATUS_VALUES]);
	});
});
