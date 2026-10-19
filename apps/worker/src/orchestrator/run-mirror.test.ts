import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { createHeartbeatDoor, createRunMirror } from "./run-mirror";

type MirrorRow = {
	id: string;
	seq: number;
	status: string;
	endedAt?: Date | null;
};
function stub(rows: MirrorRow[]) {
	const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
		const row = {
			id: `run-${rows.length + 1}`,
			seq: args.data.seq as number,
			status: args.data.status as string,
		};
		rows.push(row);
		return { id: row.id };
	});
	const update = vi.fn(
		async (args: { where: { id: string }; data: Record<string, unknown> }) =>
			Object.assign(
				rows.find((row) => row.id === args.where.id) ?? {},
				args.data,
			),
	);
	const updateMany = vi.fn(
		async (args: {
			where: { id: string; status: string; endedAt: null };
			data: { endedAt: Date };
		}) => {
			const row = rows.find(
				(r) =>
					r.id === args.where.id &&
					r.status === args.where.status &&
					r.endedAt == null,
			);
			if (!row) return { count: 0 };
			Object.assign(row, args.data);
			return { count: 1 };
		},
	);
	const prisma = {
		liveChannelRun: {
			findFirst: vi.fn(async () => rows[rows.length - 1] ?? null),
			create,
			update,
			updateMany,
		},
	} as unknown as AppPrismaClient;
	return { mirror: createRunMirror(prisma), create, update, updateMany };
}

describe("createRunMirror (ledger #108 PR2 — the dual-write seam)", () => {
	it.each([
		"run",
		"channel",
		"history",
	])("rolls a monitoring sample back if its deadline fires during the %s write", async (abortAt) => {
		const controller = new AbortController();
		const reason = new Error("monitoring expired");
		const writes: string[] = [];
		const write = (stage: string) => {
			writes.push(stage);
			if (stage === abortAt) controller.abort(reason);
		};
		const tx = {
			$queryRaw: vi.fn(async () => [{ id: "ch" }]),
			liveChannelRun: {
				findFirst: vi.fn(async () => ({ id: "run" })),
				updateMany: vi.fn(async () => {
					write("run");
					return { count: 1 };
				}),
			},
			liveChannel: {
				updateMany: vi.fn(async () => {
					write("channel");
					return { count: 1 };
				}),
			},
			liveHeartbeat: {
				create: vi.fn(async () => {
					write("history");
					return {};
				}),
			},
		};
		const door = createHeartbeatDoor({
			$transaction: async (fn: (client: typeof tx) => Promise<void>) => {
				const before = [...writes];
				try {
					await fn(tx);
				} catch (error) {
					writes.splice(0, writes.length, ...before);
					throw error;
				}
			},
		} as unknown as AppPrismaClient);
		await expect(
			door.recordHeartbeat(
				"ch",
				"enc",
				new Date(),
				{},
				{ runId: "run", encodingId: "enc", epoch: 1 },
				{ raw: {}, deltas: {} },
				controller.signal,
			),
		).rejects.toBe(reason);
		expect(writes).toEqual([]);
	});

	it("ensure returns the existing LIVE run without creating", async () => {
		const rows = [{ id: "run-1", seq: 1, status: "RUNNING" }];
		const { mirror, create } = stub(rows);
		expect(await mirror.ensureCurrentRun("ch")).toBe("run-1");
		expect(create).not.toHaveBeenCalled();
	});

	it("ensure creates seq+1 after a TERMINAL run — a re-air is a new run, never a resurrection", async () => {
		const rows = [{ id: "run-1", seq: 1, status: "STOPPED" }];
		const { mirror, create } = stub(rows);
		const id = await mirror.ensureCurrentRun("ch");
		expect(id).toBe("run-2");
		expect(create.mock.calls[0]?.[0]?.data).toMatchObject({
			seq: 2,
			status: "CREATED",
			outputPrefix: "",
		});
	});

	it("a P2002 race re-reads and returns the winner's run (the index IS the lock)", async () => {
		const rows: Array<{ id: string; seq: number; status: string }> = [];
		const { mirror } = stub(rows);
		const prisma = {
			liveChannelRun: {
				findFirst: vi
					.fn()
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce({ id: "winner", seq: 1, status: "CREATED" }),
				create: vi.fn(async () => {
					throw Object.assign(new Error("unique"), { code: "P2002" });
				}),
				update: vi.fn(),
			},
		} as unknown as AppPrismaClient;
		const racedMirror = createRunMirror(prisma);
		expect(await racedMirror.ensureCurrentRun("ch")).toBe("winner");
		void mirror;
	});

	it("a TERMINAL winner frees the index — the loser's second attempt creates seq+1 (review-242 A2)", async () => {
		// Attempt 1: latest is null → create → P2002 (a racer won). By the
		// re-read the winner has already gone terminal — the index is free,
		// so attempt 2 recomputes seq from the WINNER's row and succeeds.
		const findFirst = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: "winner", seq: 3, status: "STOPPED" })
			.mockResolvedValueOnce({ id: "winner", seq: 3, status: "STOPPED" });
		const create = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("unique"), { code: "P2002" }),
			)
			.mockResolvedValueOnce({ id: "run-4" });
		const prisma = {
			liveChannelRun: {
				findFirst,
				create,
				update: vi.fn(),
				updateMany: vi.fn(),
			},
		} as unknown as AppPrismaClient;
		const m = createRunMirror(prisma);
		expect(await m.ensureCurrentRun("ch")).toBe("run-4");
		expect(create.mock.calls[1]?.[0]?.data).toMatchObject({ seq: 4 });
	});

	it("recordHeartbeat matches the run by ENCODING id — a stop racing the poll cannot stamp the new run (review-242 A3)", async () => {
		const updateMany = vi.fn(async () => ({ count: 1 }));
		const prisma = {
			liveChannelRun: {
				findFirst: vi.fn(),
				create: vi.fn(),
				update: vi.fn(),
				updateMany,
			},
		} as unknown as AppPrismaClient;
		// The door is its OWN factory (round 7): a RunMirror physically lacks
		// recordHeartbeat, so destructure/alias/bracket on the mirror are all
		// TYPE errors — tsc holds the capability, not a regex.
		const door = createHeartbeatDoor(prisma);
		const at = new Date("2026-08-17T05:00:00.000Z");
		await door.recordHeartbeat("ch", "enc-old", at, { raw: 1 });
		expect(updateMany).toHaveBeenCalledWith({
			where: { liveChannelId: "ch", bitmovinEncodingId: "enc-old" },
			data: { lastHeartbeat: { raw: 1 }, lastHeartbeatAt: at },
		});
	});

	it("a fenced heartbeat commits run, channel fallback and history as one token-owned transaction", async () => {
		const calls: string[] = [];
		const tx = {
			$queryRaw: vi.fn(async () => [{ id: "ch" }]),
			liveChannelRun: {
				findFirst: vi.fn(async () => ({ id: "run-1" })),
				updateMany: vi.fn(async () => {
					calls.push("run");
					return { count: 1 };
				}),
			},
			liveChannel: {
				updateMany: vi.fn(async () => {
					calls.push("channel");
					return { count: 1 };
				}),
			},
			liveHeartbeat: {
				create: vi.fn(async () => {
					calls.push("history");
					return {};
				}),
			},
		};
		const transaction = vi.fn(
			async (fn: (client: typeof tx) => Promise<void>) => fn(tx),
		);
		const door = createHeartbeatDoor({
			$transaction: transaction,
		} as unknown as AppPrismaClient);
		const at = new Date("2026-08-17T05:00:00.000Z");
		await expect(
			door.recordHeartbeat(
				"ch",
				"enc-1",
				at,
				{ at: at.toISOString(), raw: { status: "CONNECTED" } },
				{ runId: "run-1", encodingId: "enc-1", epoch: 4 },
				{ raw: { status: "CONNECTED" }, deltas: { packets: 2 } },
			),
		).resolves.toBe(true);
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["run", "channel", "history"]);
		expect(tx.liveChannelRun.updateMany).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				liveChannelId: "ch",
				bitmovinEncodingId: "enc-1",
				heartbeatPollEpoch: 4,
			},
			data: {
				lastHeartbeat: {
					at: at.toISOString(),
					raw: { status: "CONNECTED" },
				},
				lastHeartbeatAt: at,
			},
		});
		expect(tx.liveHeartbeat.create).toHaveBeenCalledWith({
			data: {
				liveChannelId: "ch",
				liveChannelRunId: "run-1",
				at,
				raw: { status: "CONNECTED" },
				deltas: { packets: 2 },
			},
		});
	});

	it("a channel identity loss after the run write rolls the whole fenced heartbeat back", async () => {
		const state: {
			runSample: unknown;
			channelSample: unknown;
			history: unknown[];
		} = { runSample: null, channelSample: null, history: [] };
		const tx = {
			$queryRaw: vi.fn(async () => [{ id: "ch" }]),
			liveChannelRun: {
				findFirst: vi.fn(async () => ({ id: "run-old" })),
				updateMany: vi.fn(
					async ({ data }: { data: { lastHeartbeat: unknown } }) => {
						state.runSample = data.lastHeartbeat;
						return { count: 1 };
					},
				),
			},
			liveChannel: {
				updateMany: vi.fn(async () => ({ count: 0 })),
			},
			liveHeartbeat: {
				create: vi.fn(async ({ data }: { data: unknown }) => {
					state.history.push(data);
					return {};
				}),
			},
		};
		const transaction = async (fn: (client: typeof tx) => Promise<void>) => {
			const before = structuredClone(state);
			try {
				await fn(tx);
			} catch (err) {
				state.runSample = before.runSample;
				state.channelSample = before.channelSample;
				state.history = before.history;
				throw err;
			}
		};
		const door = createHeartbeatDoor({
			$transaction: transaction,
		} as unknown as AppPrismaClient);
		await expect(
			door.recordHeartbeat(
				"ch",
				"enc-old",
				new Date("2026-08-17T05:00:00.000Z"),
				{ raw: { stale: true } },
				{ runId: "run-old", encodingId: "enc-old", epoch: 3 },
				{ raw: { stale: true }, deltas: {} },
			),
		).resolves.toBe(false);
		expect(state).toEqual({
			runSample: null,
			channelSample: null,
			history: [],
		});
		expect(tx.liveHeartbeat.create).not.toHaveBeenCalled();
	});

	it("mirror is a NO-OP for a channel with no runs, and stamps endedAt only on terminal", async () => {
		const rows: Array<{ id: string; seq: number; status: string }> = [];
		const { mirror, update } = stub(rows);
		await mirror.mirror("ch", { status: "RUNNING" });
		expect(update).not.toHaveBeenCalled();

		rows.push({ id: "run-1", seq: 1, status: "RUNNING" });
		await mirror.mirror("ch", { status: "RUNNING" });
		expect(update.mock.calls[0]?.[0]).toMatchObject({
			where: { id: "run-1" },
		});
		expect(update.mock.calls[0]?.[0]?.data).not.toHaveProperty("endedAt");

		await mirror.mirror("ch", { status: "STOPPED" });
		expect((rows[0] as MirrorRow).endedAt).toBeInstanceOf(Date);
	});

	it.each([
		"ERROR",
		"STOPPED",
	])("keeps the first end clock when cleaning up %s again", async (status) => {
		const first = new Date("2026-09-08T00:12:00Z");
		const rows = [{ id: "run-1", seq: 1, status, endedAt: first }];
		const { mirror } = stub(rows);
		await mirror.mirror("ch", { status: "STOPPING" });
		await mirror.mirror("ch", { status: "STOPPED", error: null });
		expect(rows[0]?.endedAt).toEqual(first);
		expect(rows[0]?.status).toBe("STOPPED");
	});

	it("does not overwrite a clock committed after the mirror read", async () => {
		const first = new Date("2026-09-08T00:12:00Z");
		const rows: MirrorRow[] = [
			{ id: "run-1", seq: 1, status: "RUNNING", endedAt: null },
		];
		const { mirror, update } = stub(rows);
		const write = update.getMockImplementation();
		const row = rows[0];
		if (!write || !row) throw new Error("missing mirror fixture");
		update.mockImplementationOnce(async (args) => {
			row.endedAt = first;
			return write(args);
		});
		await mirror.mirror("ch", { status: "STOPPED" });
		expect(rows[0]?.endedAt).toEqual(first);
	});

	it("stamps a new run independently and refuses an end stamp if its status became active", async () => {
		const first = new Date("2026-09-08T00:12:00Z");
		const rows: MirrorRow[] = [
			{ id: "run-1", seq: 1, status: "STOPPED", endedAt: first },
		];
		const { mirror, updateMany } = stub(rows);
		const next = await mirror.ensureCurrentRun("ch");
		await mirror.mirror("ch", { status: "RUNNING" });
		expect(updateMany).not.toHaveBeenCalled();
		await mirror.mirror("ch", { status: "STOPPED" });
		expect(rows.find((row) => row.id === next)?.endedAt).toBeInstanceOf(Date);
		expect(rows[0]?.endedAt).toEqual(first);
		const write = updateMany.getMockImplementation();
		const row = rows.at(-1);
		if (!write || !row) throw new Error("missing mirror fixture");
		row.endedAt = null;
		updateMany.mockImplementationOnce(async (args) => {
			row.status = "RUNNING";
			return write(args);
		});
		await mirror.mirror("ch", { status: "ERROR" });
		expect(rows.at(-1)?.endedAt).toBeNull();
	});

	it("latest serves the newest run's coordinates (the sweep's #155 reads)", async () => {
		const rows = [{ id: "run-2", seq: 2, status: "STOPPED" }];
		const { mirror } = stub(rows);
		expect(await mirror.latest("ch")).toMatchObject({ id: "run-2", seq: 2 });
		expect(
			await createRunMirror({
				liveChannelRun: { findFirst: vi.fn(async () => null) },
			} as unknown as AppPrismaClient).latest("ch"),
		).toBeNull();
	});
});
