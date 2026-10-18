import { describe, expect, it, vi } from "vitest";
import { createWakeBus } from "../notify/wake-bus";
import { pollSleepFor } from "./poll-sleep";

/**
 * Review-186 I1: the seam was dead code under the entire suite — collapsing
 * the inline ternary (wakeSleep required) and even a THROWING poll sleep
 * both survived 842/842, because no processor test reaches ctx.poll.sleep.
 * These pins are the design's own §8 requirement ("pub/sub wake shortens a
 * fake awaitTask poll") at the extracted seam.
 */

describe("pollSleepFor", () => {
	it("ABSENT wakeSleep ⇒ the returned function IS deps.sleep (identity, not a wrapper)", () => {
		const sleep = vi.fn().mockResolvedValue(undefined);
		const produced = pollSleepFor({ sleep }, new Map());
		// Identity, so the fixed-interval floor is byte-identical prior
		// behaviour — a wrapper could drift; the same function cannot.
		expect(produced).toBe(sleep);
	});

	it("PRESENT wakeSleep ⇒ called with the ms and a LATE-READ ids getter", async () => {
		const sleep = vi.fn().mockResolvedValue(undefined);
		const wakeSleep = vi.fn().mockResolvedValue(undefined);
		const ids = new Map<string, string>();
		const produced = pollSleepFor({ sleep, wakeSleep }, ids);
		ids.set("encoding", "enc-1"); // set AFTER production — the getter must see it
		await produced(10_000);
		expect(sleep).not.toHaveBeenCalled();
		expect(wakeSleep).toHaveBeenCalledTimes(1);
		const [ms, getIds] = wakeSleep.mock.calls[0] as [number, () => string[]];
		expect(ms).toBe(10_000);
		expect(getIds()).toEqual(["enc-1"]);
	});

	it("a pub/sub wake SHORTENS the poll sleep (design §8, end to end at the seam)", async () => {
		const bus = createWakeBus();
		const ids = new Map<string, string>([["encoding", "enc-1"]]);
		const produced = pollSleepFor(
			{
				sleep: () => new Promise((r) => setTimeout(r, 10_000)),
				wakeSleep: (ms, interested) =>
					bus.sleep(ms, (id) => interested().includes(id)),
			},
			ids,
		);
		const started = Date.now();
		const parked = produced(10_000);
		await new Promise((r) => setTimeout(r, 5));
		bus.signal("enc-1");
		await parked;
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
