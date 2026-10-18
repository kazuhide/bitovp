import { describe, expect, it } from "vitest";
import {
	finalizeLiveCleanupSeal,
	type LiveCleanupFacts,
	liveCleanupSeal,
	unestablishedCleanupElements,
} from "./live-cleanup-seal";

/**
 * The durable Live cleanup seal (row 268, audit 602ec286 BLOCKER-2 / §16-3).
 *
 * The property the whole fix turns on: the run seals CLEAN only when all five
 * elements are POSITIVELY established, and a missing one is not run success.
 * Each arm below isolates one not-established element and pins `clean === false`
 * on it — so dropping that element's requirement from the `clean` conjunction
 * makes the arm read clean and the test go red. providerTerminal,
 * feederProcessGone and queueDrained are each independently decisive; the
 * localTerminal and hostProcessGone elements are recorded first-class evidence
 * whose `clean` contribution is subsumed by the two stricter checks above them
 * (a non-terminal channel also fails providerTerminal; an unreclaimed pid also
 * fails feederProcessGone), so those two are pinned on their `established` flag.
 */

function cleanFacts(
	overrides: Partial<LiveCleanupFacts> = {},
): LiveCleanupFacts {
	return {
		channelId: "chan-1",
		channelStatus: "STOPPED",
		channelError: null,
		feederListRead: true,
		feeders: [
			{
				id: "f1",
				pid: null,
				processGoneAt: "2026-08-30T00:05:00.000Z",
				startedAt: "2026-08-30T00:00:00.000Z",
				queued: false,
			},
		],
		...overrides,
	};
}

function withExactProviderReadback(facts: LiveCleanupFacts) {
	return finalizeLiveCleanupSeal(liveCleanupSeal(facts), {
		established: true,
		detail: "EV-01 exact provider set read enc-1 CANCELED",
	});
}

describe("liveCleanupSeal", () => {
	it("does not promote a local STOPPED/null projection to provider-terminal or clean evidence", () => {
		const seal = liveCleanupSeal(cleanFacts());
		expect(seal).toMatchObject({
			localClean: true,
			providerTerminal: { established: false },
			clean: false,
		});
		expect(seal.providerTerminal.detail).not.toMatch(
			/confirmed the provider stop/i,
		);
	});

	it("seals CLEAN only when every element is positively established", () => {
		const seal = withExactProviderReadback(cleanFacts());
		expect(seal.clean).toBe(true);
		expect(seal.providerTerminal.established).toBe(true);
		expect(seal.localTerminal.established).toBe(true);
		expect(seal.feederProcessGone.established).toBe(true);
		expect(seal.hostProcessGone.established).toBe(true);
		expect(seal.queueDrained.established).toBe(true);
		expect(unestablishedCleanupElements(seal)).toEqual([]);
	});

	it("a channel STOPPED with a non-null error is not a clean local stop projection", () => {
		// The worker writes `error` non-null exactly when a stop did not confirm
		// (an encoding never seen terminal, OR — row 268 — a feeder stop that
		// could not be enqueued). That word must block a clean seal even though
		// the local row is terminal.
		const seal = withExactProviderReadback(
			cleanFacts({
				channelStatus: "STOPPED",
				channelError: "stop did not confirm — bm-enc: still RUNNING",
			}),
		);
		expect(seal.providerTerminal.established).toBe(true);
		expect(seal.productStopProjection.established).toBe(false);
		expect(seal.localTerminal.established).toBe(true);
		expect(seal.clean).toBe(false);
		expect(unestablishedCleanupElements(seal)).toEqual([
			expect.stringContaining("local product stop projection"),
		]);
	});

	it("does not copy a provider/channel error credential into the persisted seal", () => {
		const seal = liveCleanupSeal(
			cleanFacts({
				channelError:
					"stop failed at https://user:password-secret@provider.example/x?token=query-secret",
			}),
		);
		const persisted = JSON.stringify(seal);
		expect(seal.clean).toBe(false);
		expect(persisted).not.toContain("password-secret");
		expect(persisted).not.toContain("query-secret");
		expect(persisted).not.toContain("user:");
	});

	it("an ERROR channel is locally terminal but not a confirmed provider stop", () => {
		const seal = liveCleanupSeal(cleanFacts({ channelStatus: "ERROR" }));
		expect(seal.localTerminal.established).toBe(true);
		expect(seal.providerTerminal.established).toBe(false);
		expect(seal.clean).toBe(false);
	});

	it("a channel still RUNNING is neither locally nor provider terminal", () => {
		const seal = liveCleanupSeal(cleanFacts({ channelStatus: "RUNNING" }));
		expect(seal.localTerminal.established).toBe(false);
		expect(seal.providerTerminal.established).toBe(false);
		expect(seal.clean).toBe(false);
	});

	it("a feeder that pushed but was never proven gone blocks a clean seal", () => {
		// The audit's exact shape: startedAt set (it ran ffmpeg), pid nulled on
		// the terminal write, but processGoneAt never stamped — proof of gone is
		// missing. hostProcessGone reads clean here (no pid), so this ISOLATES
		// feederProcessGone as the sole failing element.
		const seal = liveCleanupSeal(
			cleanFacts({
				feeders: [
					{
						id: "f1",
						pid: null,
						processGoneAt: null,
						startedAt: "2026-08-30T00:00:00.000Z",
						queued: false,
					},
				],
			}),
		);
		expect(seal.feederProcessGone.established).toBe(false);
		expect(seal.hostProcessGone.established).toBe(true); // isolates feederProcessGone
		expect(seal.clean).toBe(false);
		expect(seal.feederProcessGone.detail).toContain("f1");
	});

	it("a feeder still holding an unreclaimed pid is not host-process-gone", () => {
		const seal = liveCleanupSeal(
			cleanFacts({
				feeders: [
					{
						id: "f1",
						pid: 4242,
						processGoneAt: null,
						startedAt: "2026-08-30T00:00:00.000Z",
						queued: false,
					},
				],
			}),
		);
		expect(seal.hostProcessGone.established).toBe(false);
		expect(seal.hostProcessGone.detail).toContain("4242");
		expect(seal.clean).toBe(false);
	});

	it("a feeder with a still-pending queue job blocks a clean seal", () => {
		const seal = liveCleanupSeal(
			cleanFacts({
				feeders: [
					{
						id: "f1",
						pid: null,
						processGoneAt: "2026-08-30T00:05:00.000Z",
						startedAt: "2026-08-30T00:00:00.000Z",
						queued: true,
					},
				],
			}),
		);
		expect(seal.queueDrained.established).toBe(false);
		expect(seal.feederProcessGone.established).toBe(true); // isolates queueDrained
		expect(seal.hostProcessGone.established).toBe(true);
		expect(seal.clean).toBe(false);
	});

	it("an UNKNOWN queue state (Redis down) cannot prove drained", () => {
		// null is unknown, not zero — a queue we could not read is not a queue we
		// proved empty, so it must not seal clean.
		const seal = liveCleanupSeal(
			cleanFacts({
				feeders: [
					{
						id: "f1",
						pid: null,
						processGoneAt: "2026-08-30T00:05:00.000Z",
						startedAt: "2026-08-30T00:00:00.000Z",
						queued: null,
					},
				],
			}),
		);
		expect(seal.queueDrained.established).toBe(false);
		expect(seal.clean).toBe(false);
	});

	it("a run with NO feeder seals clean on the channel elements alone", () => {
		// MSL / non-feedable scenarios create no feeder. Nothing pushed, so the
		// three feeder-derived elements are vacuously established.
		const seal = withExactProviderReadback(cleanFacts({ feeders: [] }));
		expect(seal.feederProcessGone.established).toBe(true);
		expect(seal.hostProcessGone.established).toBe(true);
		expect(seal.queueDrained.established).toBe(true);
		expect(seal.clean).toBe(true);
	});

	it("a feeder that never pushed needs no processGoneAt", () => {
		// CREATED then abandoned before feeding: no startedAt, no pid, no gone.
		// It never engaged a process, so it is not held against feederProcessGone.
		const seal = withExactProviderReadback(
			cleanFacts({
				feeders: [
					{
						id: "f1",
						pid: null,
						processGoneAt: null,
						startedAt: null,
						queued: false,
					},
				],
			}),
		);
		expect(seal.feederProcessGone.established).toBe(true);
		expect(seal.hostProcessGone.established).toBe(true);
		expect(seal.clean).toBe(true);
	});

	it("an unread feeder list cannot prove any feeder-derived element", () => {
		const seal = withExactProviderReadback(
			cleanFacts({ feederListRead: false, feeders: [] }),
		);
		expect(seal.feederProcessGone.established).toBe(false);
		expect(seal.hostProcessGone.established).toBe(false);
		expect(seal.queueDrained.established).toBe(false);
		// The channel elements are still readable from the channel row.
		expect(seal.providerTerminal.established).toBe(true);
		expect(seal.localTerminal.established).toBe(true);
		expect(seal.clean).toBe(false);
	});

	it("one dirty feeder among several still blocks the whole seal", () => {
		const seal = liveCleanupSeal(
			cleanFacts({
				feeders: [
					{
						id: "clean",
						pid: null,
						processGoneAt: "2026-08-30T00:05:00.000Z",
						startedAt: "2026-08-30T00:00:00.000Z",
						queued: false,
					},
					{
						id: "dirty",
						pid: 99,
						processGoneAt: null,
						startedAt: "2026-08-30T00:00:00.000Z",
						queued: false,
					},
				],
			}),
		);
		expect(seal.clean).toBe(false);
		expect(seal.hostProcessGone.detail).toContain("dirty");
		expect(seal.hostProcessGone.detail).not.toContain("clean (pid");
	});
});
