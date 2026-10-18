import { fieldRefs, matchesWhere, projectSelect } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	type EncoderStateReader,
	findActiveWork,
	pointerChannelWhere,
	pointerJobWhere,
	pointerRunWhere,
	reconcileEncoderPointers,
} from "./reset";

/**
 *  / rev425. The reconcile stamps exactly the rows whose encoding the
 * provider reports TERMINAL — with that encoding's id — leaves running,
 * created and unverified rows untouched (the population the refusal
 * protects), asks the provider once per (account, encoding) pair, skips rows
 * in an ACTIVE app status, and refuses to stamp a row that was re-pointed
 * while the provider was read. Through the hoisted predicates (evaluated by
 * the shared double, column against column): a stamp clears a row only while
 * it names the row's CURRENT pointer — the re-air/retry scenario of rev425 C1
 * blocks again.
 */
type Row = Record<string, unknown>;
function fakePrisma(seed: {
	jobs: Row[];
	channels: Row[];
	runs: Row[];
	accounts?: Row[];
	trace?: string[];
}) {
	const table = (
		modelName: string,
		rows: Row[],
		rel?: (row: Row, k: string) => Row | null | undefined,
	) => ({
		fields: fieldRefs(modelName, ["bitmovinEncodingId"]),
		findMany: async (args: { where?: Row; select?: Row; take?: number }) =>
			rows
				.filter((r) => matchesWhere(r, args.where, rel))
				.slice(0, args.take ?? rows.length)
				.map((r) => projectSelect(r, args.select, rel)),
		count: async (args: { where?: Row }) =>
			rows.filter((r) => matchesWhere(r, args.where, rel)).length,
		updateMany: async (args: { where: Row; data: Row }) => {
			seed.trace?.push(`STAMP:${modelName}`);
			let count = 0;
			for (const r of rows) {
				if (matchesWhere(r, args.where, rel)) {
					Object.assign(r, args.data);
					count += 1;
				}
			}
			return { count };
		},
	});
	const channelOf = (row: Row, k: string) =>
		k === "bitmovinAccount"
			? (seed.accounts?.find((a) => a.id === row.bitmovinAccountId) ?? null)
			: k === "liveChannel"
				? (seed.channels.find((c) => c.id === row.liveChannelId) ?? null)
				: undefined;
	const empty = () => ({
		findMany: async () => [],
		count: async () => 0,
	});
	const prisma = {
		encodingJob: table("EncodingJob", seed.jobs, channelOf),
		liveChannel: table("LiveChannel", seed.channels, channelOf),
		liveChannelRun: table("LiveChannelRun", seed.runs, channelOf),
		feederSession: empty(),
		vmafJob: empty(),
		verificationResourceIntent: empty(),
	};
	return {
		...prisma,
		$transaction: async (work: (tx: unknown) => unknown) =>
			work({
				...prisma,
				$queryRaw: async (strings: TemplateStringsArray, id: string) => {
					expect(strings.join("?")).toContain("FOR UPDATE");
					seed.trace?.push(
						strings[0]?.includes("BitmovinAccount")
							? "LOCK:account"
							: "LOCK:parent",
					);
					const rows = strings[0]?.includes("BitmovinAccount")
						? (seed.accounts ?? [])
						: seed.channels;
					return rows.filter((row) => row.id === id).map(({ id }) => ({ id }));
				},
			}),
	} as unknown as AppPrismaClient;
}
const job = (over: Row): Row => ({
	name: "job",
	status: "CANCELED",
	bitmovinAccountId: "acct",
	encoderStoppedConfirmedFor: null,
	...over,
});

describe("reconcileEncoderPointers (row #313)", () => {
	it("keeps a failed missing-stamp transaction unverified without exposing its query arguments", async () => {
		const account = {
			id: "acct",
			updatedAt: new Date("2026-08-01"),
			tenantOrgId: null,
			encryptedApiKey: "private-cipher",
		};
		const row = job({
			id: "job",
			bitmovinEncodingId: "missing",
			createdAt: new Date("2026-08-02"),
		});
		const prisma = fakePrisma({
			jobs: [row],
			channels: [],
			runs: [],
			accounts: [account],
		});
		prisma.$transaction = vi
			.fn()
			.mockRejectedValue(new Error("query private-cipher"));
		const report = await reconcileEncoderPointers(prisma, async () => ({
			kind: "missing",
			account,
		}));
		expect(report.confirmed).toEqual([]);
		expect(report.unverified).toHaveLength(1);
		expect(JSON.stringify(report)).not.toContain("private-cipher");
		expect(row.encoderStoppedConfirmedFor).toBeNull();
	});

	it("does not use a backfilled run creation date to bypass an older parent account boundary", async () => {
		const account = {
			id: "acct",
			updatedAt: new Date("2026-08-10"),
			encryptedApiKey: "cipher",
			tenantOrgId: null,
		};
		const channel = job({
			id: "ch",
			status: "STOPPED",
			error: null,
			createdAt: new Date("2026-08-09"),
			bitmovinEncodingId: "missing",
		});
		const run: Row = {
			...channel,
			id: "run",
			status: "ERROR",
			liveChannelId: "ch",
			createdAt: new Date("2026-08-11"),
			error: "retained",
		};
		const report = await reconcileEncoderPointers(
			fakePrisma({
				jobs: [],
				channels: [channel],
				runs: [run],
				accounts: [account],
			}),
			async () => ({ kind: "missing", account }),
		);
		expect(report.confirmed).toEqual([]);
		expect(report.unverified.map((p) => p.id)).toEqual(["run"]);
		expect(run.encoderStoppedConfirmedFor).toBeNull();
	});

	it("checks missing eligibility per row even when the same provider response is cached; preserves status and error", async () => {
		const trace: string[] = [];
		const account = {
			id: "acct",
			updatedAt: new Date("2026-08-10"),
			encryptedApiKey: "cipher",
			tenantOrgId: null,
		};
		const early = job({
			id: "early",
			createdAt: new Date("2026-08-09"),
			bitmovinEncodingId: "missing",
			error: "retained",
		});
		const late = job({
			id: "late",
			createdAt: new Date("2026-08-11"),
			bitmovinEncodingId: "missing",
			error: "retained",
		});
		const read = vi.fn<EncoderStateReader>(async () => ({
			kind: "missing",
			account,
		}));
		const report = await reconcileEncoderPointers(
			fakePrisma({
				jobs: [early, late],
				channels: [],
				runs: [],
				accounts: [account],
				trace,
			}),
			read,
		);
		expect(report.confirmed.map((p) => p.id)).toEqual(["late"]);
		expect(report.unverified.map((p) => p.id)).toEqual(["early"]);
		expect(read).toHaveBeenCalledTimes(1);
		expect(trace).toEqual(["LOCK:account", "STAMP:EncodingJob"]);
		expect(late).toMatchObject({
			status: "CANCELED",
			error: "retained",
			encoderStoppedConfirmedFor: "missing",
		});
		expect(JSON.stringify(report)).not.toContain("cipher");
	});

	it.each([
		"key",
		"org",
		"version",
		"account",
		"pointer",
		"state",
		"createdAt",
		"parent",
	])("atomically refuses missing stamps after %s changes", async (change) => {
		const account = {
			id: "acct",
			updatedAt: new Date("2026-08-10"),
			encryptedApiKey: "cipher",
			tenantOrgId: null as string | null,
		};
		const channel = {
			id: "ch",
			name: "channel",
			status: "ERROR",
			error: "retained",
			bitmovinAccountId: "acct",
			bitmovinEncodingId: "missing",
			createdAt: new Date("2026-08-11"),
			encoderStoppedConfirmedFor: null,
		};
		const run = { ...channel, id: "run", liveChannelId: "ch" };
		const prisma = fakePrisma({
			jobs: [],
			channels: [channel],
			runs: [run],
			accounts: [account],
		});
		const read: EncoderStateReader = async () => {
			const snapshot = { ...account };
			if (change === "key") account.encryptedApiKey = "new-cipher";
			if (change === "org") account.tenantOrgId = "other-org";
			if (change === "version") account.updatedAt = new Date("2026-08-12");
			if (change === "account") channel.bitmovinAccountId = "other";
			if (change === "pointer")
				channel.bitmovinEncodingId = run.bitmovinEncodingId = "other";
			if (change === "state") channel.status = run.status = "RUNNING";
			if (change === "createdAt")
				channel.createdAt = run.createdAt = new Date("2026-08-12");
			if (change === "parent") run.liveChannelId = "other";
			return { kind: "missing", account: snapshot };
		};
		const report = await reconcileEncoderPointers(prisma, read);
		expect(report.confirmed.map((p) => p.id)).toEqual(
			change === "parent" ? ["ch"] : [],
		);
		expect(run.encoderStoppedConfirmedFor).toBeNull();
	});

	it("stamps TERMINAL rows with the encoding id, leaves running/created/unverified ones, skips ACTIVE rows, and reads each (account, encoding) once", async () => {
		const prisma = fakePrisma({
			jobs: [
				job({ id: "j-canceled", bitmovinEncodingId: "enc-a" }),
				job({ id: "j-running", status: "ERROR", bitmovinEncodingId: "enc-b" }),
				job({ id: "j-created", status: "ERROR", bitmovinEncodingId: "enc-c" }),
				job({
					id: "j-finished",
					status: "FINISHED",
					bitmovinEncodingId: "enc-f",
				}),
				job({
					id: "j-noacct",
					bitmovinEncodingId: "enc-d",
					bitmovinAccountId: null,
				}),
				// ACTIVE app status: blocks on its status, never reconciled
				job({
					id: "j-active",
					status: "RUNNING",
					bitmovinEncodingId: "enc-active",
				}),
			],
			channels: [
				{
					id: "ch-unconfirmed",
					name: "Ch",
					status: "STOPPED",
					error: "stop did not confirm — still CREATED",
					bitmovinEncodingId: "enc-ch",
					bitmovinAccountId: "acct",
					encoderStoppedConfirmedFor: null,
				},
				{
					id: "ch-clean",
					name: "Clean",
					status: "STOPPED",
					error: null,
					bitmovinEncodingId: "enc-clean",
					bitmovinAccountId: "acct",
					encoderStoppedConfirmedFor: null,
				},
				{
					id: "ch-active",
					name: "Live",
					status: "RUNNING",
					error: null,
					bitmovinEncodingId: "enc-live",
					bitmovinAccountId: "acct",
					encoderStoppedConfirmedFor: null,
				},
			],
			runs: [
				{
					id: "run-1",
					status: "STOPPED",
					error: "stop did not confirm",
					bitmovinEncodingId: "enc-ch",
					liveChannelId: "ch-unconfirmed",
					encoderStoppedConfirmedFor: null,
				},
				{
					id: "run-404",
					status: "ERROR",
					error: "x",
					bitmovinEncodingId: "enc-404",
					liveChannelId: "ch-unconfirmed",
					encoderStoppedConfirmedFor: null,
				},
			],
		});
		const read = vi.fn<EncoderStateReader>(async (_acct, enc) => {
			if (enc === "enc-a")
				return { kind: "stopped", providerStatus: "CANCELED" };
			if (enc === "enc-b")
				return { kind: "running", providerStatus: "RUNNING" };
			// rev431: the route answers CREATED as stopped (never started)
			if (enc === "enc-c")
				return { kind: "stopped", providerStatus: "CREATED" };
			if (enc === "enc-ch")
				return { kind: "stopped", providerStatus: "FINISHED" };
			if (enc === "enc-404")
				return { kind: "unverified", message: "not found on this account" };
			return { kind: "unverified", message: "Bitmovin API unreachable" };
		});
		const report = await reconcileEncoderPointers(prisma, read);
		expect(report.confirmed.map((p) => p.id).sort()).toEqual([
			"ch-unconfirmed",
			"j-canceled",
			"j-created",
			"run-1",
		]);
		expect(report.running.map((p) => [p.id, p.providerStatus])).toEqual([
			["j-running", "RUNNING"],
		]);
		expect(report.unverified.map((p) => [p.id, p.message])).toEqual([
			["j-noacct", "no Bitmovin account is recorded for this row"],
			["run-404", "not found on this account"],
		]);
		// enc-ch is named by the channel AND its run: one provider read; the
		// ACTIVE rows and the FINISHED/clean ones were never read
		expect(read.mock.calls.map((c) => c[1]).sort()).toEqual([
			"enc-404",
			"enc-a",
			"enc-b",
			"enc-c",
			"enc-ch",
		]);
		// the stamp is the encoding id …
		const [stamped] = await prisma.encodingJob.findMany({
			where: { id: "j-canceled" },
		});
		expect(stamped?.encoderStoppedConfirmedFor).toBe("enc-a");
		// … and stamped rows no longer match the unstopped-encoder predicates
		const jobs = await prisma.encodingJob.findMany({
			where: pointerJobWhere(prisma),
		});
		// rev431: j-created is stamped now (CREATED = never started)
		expect(jobs.map((j) => j.id).sort()).toEqual([
			"j-active",
			"j-noacct",
			"j-running",
		]);
		const channels = await prisma.liveChannel.findMany({
			where: pointerChannelWhere(prisma),
		});
		expect(channels.map((c) => c.id)).toEqual(["ch-active"]);
		const runs = await prisma.liveChannelRun.findMany({
			where: pointerRunWhere(prisma),
		});
		expect(runs.map((r) => r.id)).toEqual(["run-404"]);
	});

	it("rev425 C1: a stamp for an OLDER encoding does not clear a re-pointed row — it blocks again through the real predicates and findActiveWork", async () => {
		const prisma = fakePrisma({
			jobs: [
				// reconciled with enc-A, then retried: pointer enc-B, ERROR again
				job({
					id: "j-retried",
					status: "ERROR",
					bitmovinEncodingId: "enc-B",
					encoderStoppedConfirmedFor: "enc-A",
				}),
				// control: stamp names the current pointer
				job({
					id: "j-confirmed",
					bitmovinEncodingId: "enc-K",
					encoderStoppedConfirmedFor: "enc-K",
				}),
			],
			channels: [
				{
					id: "ch-reaired",
					name: "Ch",
					status: "STOPPED",
					error: "stop did not confirm",
					bitmovinEncodingId: "enc-B2",
					bitmovinAccountId: "acct",
					encoderStoppedConfirmedFor: "enc-A2",
				},
			],
			runs: [
				{
					id: "run-revived",
					status: "ERROR",
					error: "x",
					bitmovinEncodingId: "enc-B3",
					liveChannelId: "ch-reaired",
					encoderStoppedConfirmedFor: "enc-A3",
				},
				{
					id: "run-ok",
					status: "STOPPED",
					error: "stop did not confirm",
					bitmovinEncodingId: "enc-K3",
					liveChannelId: "ch-reaired",
					encoderStoppedConfirmedFor: "enc-K3",
				},
			],
		});
		expect(
			(
				await prisma.encodingJob.findMany({ where: pointerJobWhere(prisma) })
			).map((j) => j.id),
		).toEqual(["j-retried"]);
		expect(
			(
				await prisma.liveChannel.findMany({
					where: pointerChannelWhere(prisma),
				})
			).map((c) => c.id),
		).toEqual(["ch-reaired"]);
		expect(
			(
				await prisma.liveChannelRun.findMany({ where: pointerRunWhere(prisma) })
			).map((r) => r.id),
		).toEqual(["run-revived"]);
		const active = await findActiveWork(prisma);
		expect(active.unstoppedEncoders.map((p) => p.id).sort()).toEqual([
			"ch-reaired",
			"j-retried",
			"run-revived",
		]);
		// and the reconcile re-reads exactly those, stamping the NEW id
		const read = vi.fn<EncoderStateReader>(async () => ({
			kind: "stopped",
			providerStatus: "ERROR",
		}));
		const report = await reconcileEncoderPointers(prisma, read);
		expect(report.confirmed.map((p) => p.id).sort()).toEqual([
			"ch-reaired",
			"j-retried",
			"run-revived",
		]);
		const [row] = await prisma.encodingJob.findMany({
			where: { id: "j-retried" },
		});
		expect(row?.encoderStoppedConfirmedFor).toBe("enc-B");
		expect(await findActiveWork(prisma)).toMatchObject({
			unstoppedEncoders: [],
		});
	});

	it("does not stamp a row that was pointed at another encoding while the provider was read", async () => {
		const rows = [job({ id: "j", bitmovinEncodingId: "enc-old" })];
		const prisma = fakePrisma({ jobs: rows, channels: [], runs: [] });
		const read = vi.fn<EncoderStateReader>(async () => {
			// a retry lands between the list and the stamp
			(rows[0] as Row).bitmovinEncodingId = "enc-new";
			return { kind: "stopped", providerStatus: "FINISHED" };
		});
		const report = await reconcileEncoderPointers(prisma, read);
		expect(report.confirmed).toEqual([]);
		expect(report.unverified.map((p) => p.message)).toEqual([
			"the row was pointed at another encoding or changed state while Bitmovin was being read; check again",
		]);
		expect(rows[0]?.encoderStoppedConfirmedFor).toBeNull();
	});

	it("rev431: does not stamp a row whose STATUS changed while the provider was read — a retry resumes the same encoding without re-pointing", async () => {
		const rows = [
			job({ id: "j", status: "ERROR", bitmovinEncodingId: "enc-same" }),
		];
		const prisma = fakePrisma({ jobs: rows, channels: [], runs: [] });
		const read = vi.fn<EncoderStateReader>(async () => {
			// the retry route flips ERROR → QUEUED (and clears the stamp) between
			// the list and the stamp; the pointer is unchanged
			(rows[0] as Row).status = "QUEUED";
			return { kind: "stopped", providerStatus: "CREATED" };
		});
		const report = await reconcileEncoderPointers(prisma, read);
		expect(report.confirmed).toEqual([]);
		expect(report.unverified.map((p) => p.message)).toEqual([
			"the row was pointed at another encoding or changed state while Bitmovin was being read; check again",
		]);
		expect(rows[0]?.encoderStoppedConfirmedFor).toBeNull();
	});

	it("a second run is idempotent: nothing left to read, nothing re-stamped", async () => {
		const prisma = fakePrisma({
			jobs: [job({ id: "j", bitmovinEncodingId: "enc" })],
			channels: [],
			runs: [],
		});
		const read = vi.fn<EncoderStateReader>(async () => ({
			kind: "stopped",
			providerStatus: "FINISHED",
		}));
		await reconcileEncoderPointers(prisma, read);
		const again = await reconcileEncoderPointers(prisma, read);
		expect(again).toEqual({ confirmed: [], running: [], unverified: [] });
		expect(read).toHaveBeenCalledTimes(1);
		const [row] = await prisma.encodingJob.findMany({ where: { id: "j" } });
		expect(row?.encoderStoppedConfirmedFor).toBe("enc");
	});
});
