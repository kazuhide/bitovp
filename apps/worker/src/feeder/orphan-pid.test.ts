import { describe, expect, it, vi } from "vitest";
import { createKillLadder, looksLikeFeederFfmpeg } from "./orphan-pid";

const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";
const FEEDER_CMD = `ffmpeg -hide_banner -nostdin -re -stream_loop -1 -i /var/spool/${SESSION_ID}.mp4 -c copy -f flv rtmp://203.0.113.7/live/sk`;

describe("looksLikeFeederFfmpeg", () => {
	it("matches this session's infinite push", () => {
		expect(looksLikeFeederFfmpeg(FEEDER_CMD, SESSION_ID)).toBe(true);
	});

	it("rejects an unrelated process wearing the recycled pid", () => {
		expect(
			looksLikeFeederFfmpeg("/usr/sbin/nginx -g daemon off;", SESSION_ID),
		).toBe(false);
	});

	it("rejects ANOTHER session's feeder — the pid must belong to THIS row", () => {
		const other = FEEDER_CMD.replace(
			SESSION_ID,
			"00000000-0000-4000-8000-0000000000f2",
		);
		expect(looksLikeFeederFfmpeg(other, SESSION_ID)).toBe(false);
	});

	it("rejects a NON-loop ffmpeg over the same file (the VMAF pipeline reads these too)", () => {
		// This app runs ffmpeg for scoring as well as for pushing. Matching on
		// the session id alone would let a reclaim kill a measurement run.
		expect(
			looksLikeFeederFfmpeg(
				`ffmpeg -i /var/spool/${SESSION_ID}.mp4 -lavfi libvmaf -f null -`,
				SESSION_ID,
			),
		).toBe(false);
	});
});

describe("createKillLadder", () => {
	const ladder = (killPid?: (pid: number, sig: unknown) => void) =>
		createKillLadder({
			killPid: killPid as never,
			sleep: async () => {},
			killGraceMs: 1,
		});

	it("reports GONE without signalling when the pid is already dead", async () => {
		const killPid = vi.fn(() => {
			throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		});
		await expect(ladder(killPid)(4242)).resolves.toBe(true);
		expect(killPid.mock.calls).toEqual([[4242, 0]]);
	});

	it("escalates SIGTERM → SIGKILL and reports GONE when the pid finally exits", async () => {
		let killed = false;
		const calls: unknown[] = [];
		const killPid = vi.fn((_pid: number, signal: unknown) => {
			calls.push(signal);
			if (signal === 0 && killed) {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
			if (signal === "SIGKILL") {
				killed = true;
			}
		});
		await expect(ladder(killPid)(4242)).resolves.toBe(true);
		expect(calls).toEqual([0, "SIGTERM", 0, "SIGKILL", 0]);
	});

	it("reports NOT gone when the pid survives SIGKILL — the caller must not claim absence", async () => {
		await expect(ladder(() => {})(4242)).resolves.toBe(false);
	});

	it("reports NOT gone when no signalling ability is wired", async () => {
		await expect(ladder(undefined)(4242)).resolves.toBe(false);
	});
});
