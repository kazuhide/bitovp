import { projectSelected } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import type { StopRemoteDeps } from "./stop-remote-encodings";
import {
	createUnstoppedEncodingReconciler,
	reconcileUnstoppedEncodings,
	stopRemoteEncodingsFor,
} from "./stop-remote-encodings";

/**
 * the encoding a dead job leaves billing.
 *
 * A job can die outside its processor (stalled twice, lock lost). The `failed`
 * listener flips the row to ERROR so it does not wedge, and that write is
 * precisely what makes it unstoppable: the cancel API claims
 * `status in (QUEUED, RUNNING)`, so every later cancel 409s, and the processor
 * that owns the stop is gone. The encoding kept running at Bitmovin, per
 * minute, with no route to stop it from the product.
 *
 * The reset SEES these rows and refuses to proceed — but seeing is not
 * stopping, and the only "fix" it offers is deleting the local record, which is
 * (a forgotten encoder is a bill) reached through a clean-looking
 * screen.
 */

const ACCOUNT = "acc-1";

function stepLog(entries: { resourceId?: string; kind?: string }[]) {
	return entries.map((e, i) => ({
		step: `step-${i}`,
		kind: e.kind ?? "CREATE_ENCODING",
		payload: {},
		refs: {},
		status: "DONE",
		...(e.resourceId ? { resourceId: e.resourceId } : {}),
	}));
}

function setup(
	job: {
		id?: string;
		stepLog?: unknown;
		bitmovinAccountId?: string | null;
		bitmovinEncodingId?: string | null;
		encoderStoppedConfirmedFor?: string | null;
		createdBy?: string | null;
		status?: string;
	} | null,
	statuses: Record<string, string> = {},
) {
	const stopEncoding = vi.fn(async () => undefined);
	const getEncodingStatus = vi.fn(async (id: string) => ({
		status: statuses[id] ?? "RUNNING",
	}));
	const findUnique = vi.fn(
		async (args?: { select?: Record<string, unknown> }) =>
			job === null
				? null
				: projectSelected(
						{
							id: job.id ?? "job-1",
							status: job.status ?? "ERROR",
							remoteStopRequestedAt: null,
							updatedAt: new Date("2026-08-01T00:00:00Z"),
							stepLog: job.stepLog ?? stepLog([{ resourceId: "enc-1" }]),
							bitmovinAccountId:
								job.bitmovinAccountId === undefined
									? ACCOUNT
									: job.bitmovinAccountId,
							bitmovinEncodingId: job.bitmovinEncodingId ?? null,
							encoderStoppedConfirmedFor:
								job.encoderStoppedConfirmedFor ?? null,
							createdBy:
								job.createdBy === undefined
									? "worker:watch-sweep"
									: job.createdBy,
						},
						args?.select,
					),
	);
	const findMany = vi.fn(async (args?: unknown) => {
		if (job === null) return [];
		const filter = (args as { where: { id?: { gt?: string; gte?: string } } })
			?.where?.id;
		const id = job.id ?? "job-1";
		if ((filter?.gt && id <= filter.gt) || (filter?.gte && id < filter.gte))
			return [];
		return [{ id }];
	});
	let cursor: unknown = { afterId: null, encodingAfter: null, complete: true };
	const advanceCursor = vi.fn(
		async ({ data }: { data: { value: unknown } }) => {
			cursor = data.value;
			return { count: 1 };
		},
	);
	const deps = {
		prisma: {
			encodingJob: {
				findUnique,
				findMany,
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			appSetting: {
				upsert: vi.fn(async () => ({ value: cursor })),
				updateMany: advanceCursor,
			},
		},
		revealBitmovinAccount: vi.fn(async () => ({
			apiKey: "k",
			tenantOrgId: null,
		})),
		makeSdk: vi.fn(() => ({ getEncodingStatus, stopEncoding })),
	} as unknown as StopRemoteDeps;
	return { deps, stopEncoding, getEncodingStatus, findMany, advanceCursor };
}

describe("stopRemoteEncodingsFor", () => {
	it("uses exact current confirmation without credentials, SDK I/O or a fabricated STOP", async () => {
		const { deps, getEncodingStatus, stopEncoding } = setup({
			bitmovinEncodingId: "enc-1",
			encoderStoppedConfirmedFor: "enc-1",
		});
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out).toEqual({ found: ["enc-1"], stopped: [] });
		expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
		expect(deps.makeSdk).not.toHaveBeenCalled();
		expect(getEncodingStatus).not.toHaveBeenCalled();
		expect(stopEncoding).not.toHaveBeenCalled();
		expect(deps.prisma.encodingJob.updateMany).not.toHaveBeenCalled();
	});
	it.each([
		{ bitmovinEncodingId: "enc-1", encoderStoppedConfirmedFor: null },
		{ bitmovinEncodingId: "enc-1", encoderStoppedConfirmedFor: "other" },
		{ bitmovinEncodingId: "other", encoderStoppedConfirmedFor: "enc-1" },
		{ bitmovinEncodingId: null, encoderStoppedConfirmedFor: "enc-1" },
		{ bitmovinEncodingId: "other", encoderStoppedConfirmedFor: "other" },
	])("keeps unconfirmed resource cleanup for $bitmovinEncodingId / $encoderStoppedConfirmedFor", async (job) => {
		const { deps, getEncodingStatus, stopEncoding } = setup(job);
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(getEncodingStatus).toHaveBeenCalledWith("enc-1");
		expect(stopEncoding).toHaveBeenCalledWith("enc-1");
		expect(out.stopped).toEqual(["enc-1"]);
		expect(deps.prisma.encodingJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { remoteStopRequestedAt: expect.any(Date) },
			}),
		);
	});
	it("confirmation exempts only its current resource in a multi-encoding job", async () => {
		const { deps, getEncodingStatus } = setup({
			bitmovinEncodingId: "enc-b",
			encoderStoppedConfirmedFor: "enc-b",
			stepLog: stepLog([
				{ resourceId: "enc-c" },
				{ resourceId: "enc-b" },
				{ resourceId: "enc-a" },
			]),
		});
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.found).toEqual(["enc-c", "enc-b", "enc-a"]);
		expect(out.stopped).toEqual(["enc-a", "enc-c"]);
		expect(getEncodingStatus.mock.calls.map(([id]) => id)).toEqual([
			"enc-a",
			"enc-c",
		]);
		expect(deps.revealBitmovinAccount).toHaveBeenCalledTimes(1);
	});
	it.each([
		"confirmation",
		"pointer",
	])("rechecks %s after the awaited resource callback", async (changed) => {
		const job = {
			bitmovinEncodingId: "enc-1",
			encoderStoppedConfirmedFor: "enc-1" as string | null,
		};
		const { deps, getEncodingStatus } = setup(job);
		const out = await stopRemoteEncodingsFor(deps, "job-1", {
			beforeEncoding: async () => {
				if (changed === "confirmation") job.encoderStoppedConfirmedFor = null;
				else job.bitmovinEncodingId = "other";
				return true;
			},
		});
		expect(getEncodingStatus).toHaveBeenCalledWith("enc-1");
		expect(out.stopped).toEqual(["enc-1"]);
	});
	it("honors confirmation added during the awaited callback before revealing credentials", async () => {
		const job = {
			bitmovinEncodingId: "enc-1",
			encoderStoppedConfirmedFor: null as string | null,
		};
		const { deps, getEncodingStatus } = setup(job);
		await stopRemoteEncodingsFor(deps, "job-1", {
			beforeEncoding: async () => {
				job.encoderStoppedConfirmedFor = "enc-1";
				return true;
			},
		});
		expect(getEncodingStatus).not.toHaveBeenCalled();
		expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
	});
	it("does not reuse confirmation across an earlier resource's awaited provider read", async () => {
		const job = {
			bitmovinEncodingId: "enc-b",
			encoderStoppedConfirmedFor: "enc-b" as string | null,
			stepLog: stepLog([{ resourceId: "enc-a" }, { resourceId: "enc-b" }]),
		};
		const { deps, getEncodingStatus } = setup(job);
		getEncodingStatus.mockImplementationOnce(async () => {
			job.encoderStoppedConfirmedFor = null;
			return { status: "FINISHED" };
		});
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(getEncodingStatus.mock.calls.map(([id]) => id)).toEqual([
			"enc-a",
			"enc-b",
		]);
		expect(out.stopped).toEqual(["enc-b"]);
	});
	it("does not claim STOP when exact confirmation arrives during the status read", async () => {
		const job = {
			bitmovinEncodingId: "enc-1",
			encoderStoppedConfirmedFor: null as string | null,
		};
		const { deps, getEncodingStatus, stopEncoding } = setup(job);
		getEncodingStatus.mockImplementationOnce(async () => {
			job.encoderStoppedConfirmedFor = "enc-1";
			return { status: "RUNNING" };
		});
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.stopped).toEqual([]);
		expect(stopEncoding).not.toHaveBeenCalled();
		expect(deps.prisma.encodingJob.updateMany).not.toHaveBeenCalled();
	});
	it("confirmation arriving at the intent CAS prevents STOP without changing lifecycle", async () => {
		const { deps, stopEncoding } = setup({ bitmovinEncodingId: "enc-1" });
		Object.assign(deps.prisma.encodingJob, {
			updateMany: vi.fn(
				async ({ where }: { where?: Record<string, unknown> }) => {
					// An unguarded update still matches; a real confirmation predicate loses.
					return {
						count:
							where?.encoderStoppedConfirmedFor === undefined ||
							where.encoderStoppedConfirmedFor === "enc-1"
								? 1
								: 0,
					};
				},
			),
		});
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.stopped).toEqual([]);
		expect(stopEncoding).not.toHaveBeenCalled();
	});
	it("an unproved 404 remains unknown and never mints confirmation", async () => {
		const { deps, getEncodingStatus, stopEncoding } = setup({
			bitmovinEncodingId: "enc-1",
		});
		getEncodingStatus.mockRejectedValueOnce(
			Object.assign(new Error("not found"), {
				httpStatusCode: 404,
				errorCode: 1001,
			}),
		);
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.stopped).toEqual([]);
		expect(stopEncoding).not.toHaveBeenCalled();
		expect(deps.prisma.encodingJob.updateMany).not.toHaveBeenCalled();
	});
	it("keeps callback refusal and after-resource cursors ahead of confirmation checks", async () => {
		const { deps, getEncodingStatus } = setup({
			bitmovinEncodingId: "enc-1",
			encoderStoppedConfirmedFor: "enc-1",
		});
		const beforeEncoding = vi.fn(async () => false);
		await expect(
			stopRemoteEncodingsFor(deps, "job-1", { beforeEncoding }),
		).resolves.toMatchObject({ deferred: true });
		expect(beforeEncoding).toHaveBeenCalledWith("enc-1");
		beforeEncoding.mockClear();
		await stopRemoteEncodingsFor(deps, "job-1", {
			afterEncodingId: "enc-1",
			beforeEncoding,
		});
		expect(beforeEncoding).not.toHaveBeenCalled();
		expect(getEncodingStatus).not.toHaveBeenCalled();
		expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
	});
	it("a fresh attended ERROR remains inside the two-hour grace at dispatch", async () => {
		const { deps, getEncodingStatus, stopEncoding } = setup({
			createdBy: "session",
		});
		const lookup = vi.mocked(deps.prisma.encodingJob.findUnique);
		const original = await lookup({ where: { id: "job-1" } });
		getEncodingStatus.mockImplementationOnce(async () => {
			lookup.mockResolvedValueOnce({
				...original,
				updatedAt: new Date("2026-09-09T10:00:00Z"),
			} as NonNullable<typeof original>);
			return { status: "RUNNING" };
		});
		await stopRemoteEncodingsFor(deps, "job-1", {
			eligibleBefore: new Date("2026-09-09T09:00:00Z"),
		});
		expect(stopEncoding).not.toHaveBeenCalled();
	});
	it.each([
		"QUEUED",
		"RUNNING",
	])("does not stop a job now %s", async (status) => {
		const { deps, getEncodingStatus, stopEncoding } = setup({ status });
		await stopRemoteEncodingsFor(deps, "job-1");
		expect(getEncodingStatus).not.toHaveBeenCalled();
		expect(stopEncoding).not.toHaveBeenCalled();
	});

	it("Retry wins during provider status read: failed intent CAS prevents STOP", async () => {
		const { deps, stopEncoding } = setup({});
		Object.assign(deps.prisma.encodingJob, {
			updateMany: vi.fn(async () => ({ count: 0 })),
		});
		await stopRemoteEncodingsFor(deps, "job-1");
		expect(stopEncoding).not.toHaveBeenCalled();
	});
	it.each([
		"status",
		"account",
		"stepLog",
	])("changed %s after GET cannot dispatch STOP", async (change) => {
		const { deps, getEncodingStatus, stopEncoding } = setup({});
		const lookup = vi.mocked(deps.prisma.encodingJob.findUnique);
		const original = await lookup({ where: { id: "job-1" } });
		getEncodingStatus.mockImplementationOnce(async () => {
			lookup.mockResolvedValueOnce({
				...original,
				...(change === "status"
					? { status: "QUEUED" }
					: change === "account"
						? { bitmovinAccountId: "other" }
						: { stepLog: stepLog([{ resourceId: "different" }]) }),
			} as NonNullable<typeof original>);
			return { status: "RUNNING" };
		});
		await stopRemoteEncodingsFor(deps, "job-1");
		expect(stopEncoding).not.toHaveBeenCalled();
	});
	it("a rejected STOP retains intent, never reports a successful stop", async () => {
		const { deps, stopEncoding } = setup({});
		stopEncoding.mockRejectedValueOnce(new Error("response lost"));
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.stopped).toEqual([]);
		expect(deps.prisma.encodingJob.updateMany).toHaveBeenCalledTimes(1);
		expect(deps.prisma.encodingJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: "ERROR",
					bitmovinAccountId: ACCOUNT,
					remoteStopRequestedAt: null,
					stepLog: { equals: stepLog([{ resourceId: "enc-1" }]) },
				}),
				data: { remoteStopRequestedAt: expect.any(Date) },
			}),
		);
	});
	it("stops an encoding the dead job left RUNNING", async () => {
		const { deps, stopEncoding } = setup({});
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(stopEncoding).toHaveBeenCalledWith("enc-1");
		expect(out.stopped).toEqual(["enc-1"]);
	});

	it("leaves a terminal encoding alone — one GET, no stop", async () => {
		// The reason this is safe to run on a boot sweep at all: a job whose
		// encoding already finished costs a status read and nothing else.
		const { deps, stopEncoding, getEncodingStatus } = setup(
			{},
			{
				"enc-1": "FINISHED",
			},
		);
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(getEncodingStatus).toHaveBeenCalledWith("enc-1");
		expect(stopEncoding).not.toHaveBeenCalled();
		expect(out.stopped).toEqual([]);
	});

	it("stops EVERY encoding of a multi-encoding job, not just the first", async () => {
		// Dolby multi-format compiles several CREATE_ENCODINGs into one job;
		// stopping one and walking away would leave the rest billing.
		const { deps, stopEncoding } = setup({
			stepLog: stepLog([
				{ resourceId: "enc-1" },
				{ resourceId: "enc-2" },
				{ resourceId: "enc-3" },
			]),
		});
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.stopped).toEqual(["enc-1", "enc-2", "enc-3"]);
		expect(stopEncoding).toHaveBeenCalledTimes(3);
	});

	it("keeps going when ONE encoding refuses to stop", async () => {
		// A failure handler that dies on the first unreachable encoding would
		// abandon the others — the exact shape that leaves a bill behind.
		const { deps, stopEncoding } = setup({
			stepLog: stepLog([{ resourceId: "enc-1" }, { resourceId: "enc-2" }]),
		});
		(stopEncoding as ReturnType<typeof vi.fn>).mockImplementationOnce(
			async () => {
				throw new Error("502 from stop");
			},
		);
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.stopped).toEqual(["enc-2"]);
	});

	it("ignores steps that never created an encoding", async () => {
		const { deps, stopEncoding } = setup({
			stepLog: stepLog([
				{ kind: "CREATE_OUTPUT_S3", resourceId: "out-1" },
				{ kind: "CREATE_ENCODING" }, // no resourceId — never created
			]),
		});
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.found).toEqual([]);
		expect(stopEncoding).not.toHaveBeenCalled();
	});

	it("does nothing when no account was ever resolved", async () => {
		// The run died before it could authenticate; there is nothing on the
		// provider and no way to talk to it.
		const { deps, stopEncoding } = setup({ bitmovinAccountId: null });
		const out = await stopRemoteEncodingsFor(deps, "job-1");
		expect(out.found).toEqual([]);
		expect(stopEncoding).not.toHaveBeenCalled();
	});

	it("stops an UNATTENDED job at failure time — nobody will press Retry", async () => {
		const { deps, stopEncoding } = setup({ createdBy: "worker:watch-sweep" });
		const out = await stopRemoteEncodingsFor(deps, "job-1", {
			unattendedOnly: true,
		});
		expect(out.stopped).toEqual(["enc-1"]);
		expect(stopEncoding).toHaveBeenCalledWith("enc-1");
	});

	it("does NOT stop an ATTENDED job at failure time — that would kill Retry", async () => {
		/**
		 * The critical one (review-299 C1). This module's first version claimed
		 * "`retry` starts a NEW run rather than adopting the old encoding" and
		 * stopped unconditionally. The claim was FALSE — retry/route.ts says DONE
		 * steps keep their resource ids and the orchestrator RESUMES — so the
		 * stop landed exactly on the stall case  measured as
		 * recoverable in seventy seconds, and replaced it with a full re-encode.
		 */
		for (const createdBy of ["user:abc", "token:tok-1", "session", null]) {
			const { deps, stopEncoding } = setup({ createdBy });
			const out = await stopRemoteEncodingsFor(deps, "job-1", {
				unattendedOnly: true,
			});
			expect(out.stopped).toEqual([]);
			expect(stopEncoding).not.toHaveBeenCalled();
		}
	});

	it("survives an unparseable step log", async () => {
		const { deps, stopEncoding } = setup({ stepLog: { not: "a log" } });
		await expect(stopRemoteEncodingsFor(deps, "job-1")).resolves.toMatchObject({
			stopped: [],
		});
		expect(stopEncoding).not.toHaveBeenCalled();
	});
});

describe("reconcileUnstoppedEncodings", () => {
	it("confirmed resources consume the cursor budget without counting as provider STOPs", async () => {
		const { deps, getEncodingStatus } = setup({
			bitmovinEncodingId: "enc-a",
			encoderStoppedConfirmedFor: "enc-a",
			stepLog: stepLog([{ resourceId: "enc-a" }, { resourceId: "enc-b" }]),
		});
		await expect(
			reconcileUnstoppedEncodings(deps, 200, { maxEncodings: 1 }),
		).resolves.toBe(0);
		expect(getEncodingStatus).not.toHaveBeenCalled();
		expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
		await expect(
			reconcileUnstoppedEncodings(deps, 200, { maxEncodings: 1 }),
		).resolves.toBe(1);
		expect(getEncodingStatus.mock.calls.map(([id]) => id)).toEqual(["enc-b"]);
	});
	it.each([
		"throw",
		"CAS loss",
	])("an unverified cursor restoration (%s) ends without marking the row complete", async (failure) => {
		let time = 0;
		const { deps, getEncodingStatus, advanceCursor } = setup({});
		const persist = advanceCursor.getMockImplementation();
		advanceCursor
			.mockImplementationOnce(async (args) => {
				time = 31_000;
				return (await persist?.(args)) ?? { count: 0 };
			})
			.mockImplementationOnce(async () => {
				if (failure === "throw") throw new Error("restore unknown");
				return { count: 0 };
			});
		await reconcileUnstoppedEncodings(deps, 200, { clock: () => time });
		expect(getEncodingStatus).not.toHaveBeenCalled();
		expect(advanceCursor).toHaveBeenCalledTimes(2);
		expect(advanceCursor.mock.calls[1]?.[0].data.value).toEqual({
			afterId: null,
			encodingAfter: null,
			complete: true,
		});
	});
	it("resumes an undispatched resource even when its checkpoint repeatedly crosses the deadline", async () => {
		let time = 0;
		const { deps, getEncodingStatus, advanceCursor } = setup({
			stepLog: stepLog([{ resourceId: "enc-a" }, { resourceId: "enc-b" }]),
		});
		const persist = advanceCursor.getMockImplementation();
		advanceCursor.mockImplementation(async (args) => {
			if (
				(args.data.value as { encodingAfter: string }).encodingAfter === "enc-b"
			)
				time += 2_000;
			return (await persist?.(args)) ?? { count: 0 };
		});
		getEncodingStatus.mockImplementation(async (id) => {
			if (id === "enc-a") time += 29_000;
			return { status: "FINISHED" };
		});
		for (let pass = 0; pass < 9; pass += 1)
			await reconcileUnstoppedEncodings(deps, 200, { clock: () => time });
		expect(
			getEncodingStatus.mock.calls.filter(([id]) => id === "enc-b").length,
		).toBeGreaterThanOrEqual(3);
	});
	it("a lost cursor write never starts its resource and remains retryable after restart", async () => {
		const { deps, getEncodingStatus } = setup({});
		vi.mocked(deps.prisma.appSetting.updateMany).mockRejectedValueOnce(
			new Error("cursor write lost"),
		);
		await reconcileUnstoppedEncodings(deps);
		expect(getEncodingStatus).not.toHaveBeenCalled();
		// Empty tail wraps the persisted cursor; then the failed resource returns.
		await reconcileUnstoppedEncodings(deps);
		await reconcileUnstoppedEncodings(deps);
		expect(getEncodingStatus).toHaveBeenCalledWith("enc-1");
	});
	it("a deadline crossed during cursor persistence cannot start new SDK I/O", async () => {
		let time = 0;
		const { deps, getEncodingStatus, advanceCursor } = setup({});
		advanceCursor.mockImplementationOnce(async () => {
			time = 31_000;
			return { count: 1 };
		});
		await reconcileUnstoppedEncodings(deps, 200, { clock: () => time });
		expect(getEncodingStatus).not.toHaveBeenCalled();
	});
	it("resumes within a multi-encoding job after its resource budget", async () => {
		const { deps, getEncodingStatus } = setup({
			stepLog: stepLog([
				{ resourceId: "enc-c" },
				{ resourceId: "enc-a" },
				{ resourceId: "enc-b" },
			]),
		});
		await reconcileUnstoppedEncodings(deps, 200, { maxEncodings: 1 });
		await reconcileUnstoppedEncodings(deps, 200, { maxEncodings: 1 });
		await reconcileUnstoppedEncodings(deps, 200, { maxEncodings: 1 });
		expect(getEncodingStatus.mock.calls.map(([id]) => id)).toEqual([
			"enc-a",
			"enc-b",
			"enc-c",
		]);
	});
	it("cursor CAS loss never dispatches or overwrites newer progress", async () => {
		const { deps, getEncodingStatus } = setup({});
		vi.mocked(deps.prisma.appSetting.updateMany).mockResolvedValueOnce({
			count: 0,
		});
		await reconcileUnstoppedEncodings(deps);
		expect(getEncodingStatus).not.toHaveBeenCalled();
		expect(deps.prisma.appSetting.updateMany).toHaveBeenCalledTimes(1);
	});
	it("checkpoint precedes a failing resource and restart continues to its sibling", async () => {
		const { deps, getEncodingStatus } = setup({
			stepLog: stepLog([{ resourceId: "enc-a" }, { resourceId: "enc-b" }]),
		});
		getEncodingStatus.mockRejectedValueOnce(new Error("provider unavailable"));
		await reconcileUnstoppedEncodings(deps, 200, { maxEncodings: 1 });
		await reconcileUnstoppedEncodings(deps, 200, { maxEncodings: 1 });
		expect(getEncodingStatus.mock.calls.map(([id]) => id)).toEqual([
			"enc-a",
			"enc-b",
		]);
	});
	it("the time budget blocks new resource dispatch without abandoning in-flight calls", async () => {
		let time = 0;
		const { deps, getEncodingStatus } = setup({
			stepLog: stepLog([{ resourceId: "enc-a" }, { resourceId: "enc-b" }]),
		});
		getEncodingStatus.mockImplementationOnce(async () => {
			time = 31_000;
			return { status: "FINISHED" };
		});
		await reconcileUnstoppedEncodings(deps, 200, { clock: () => time });
		expect(getEncodingStatus.mock.calls.map(([id]) => id)).toEqual(["enc-a"]);
		time = 0;
		await reconcileUnstoppedEncodings(deps, 200, { clock: () => time });
		expect(getEncodingStatus.mock.calls.map(([id]) => id)).toEqual([
			"enc-a",
			"enc-b",
		]);
	});
	it("periodic ticks do not overlap a pending sweep", async () => {
		const { deps, findMany } = setup(null);
		let resolve: ((rows: { id: string }[]) => void) | undefined;
		findMany.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const sweep = createUnstoppedEncodingReconciler(deps);
		const first = sweep();
		await Promise.resolve();
		await expect(sweep()).resolves.toBe(0);
		resolve?.([]);
		await first;
		expect(findMany).toHaveBeenCalledTimes(1);
	});
	it("persists an ascending cursor so a restarted sweep reaches rows beyond 200", async () => {
		const { deps, findMany } = setup(null);
		const ids = Array.from(
			{ length: 205 },
			(_, i) => `job-${String(i).padStart(3, "0")}`,
		);
		findMany.mockImplementation(async (args?: unknown) => {
			const q = args as {
				where: { id?: { gt?: string; gte?: string } };
				take: number;
			};
			return ids
				.filter((id) =>
					q.where.id?.gt
						? id > q.where.id.gt
						: q.where.id?.gte
							? id >= q.where.id.gte
							: true,
				)
				.slice(0, q.take)
				.map((id) => ({ id }));
		});
		await reconcileUnstoppedEncodings(deps);
		await reconcileUnstoppedEncodings(deps);
		expect(findMany.mock.calls[1]?.[0]).toMatchObject({
			where: { id: { gt: "job-199" } },
			orderBy: { id: "asc" },
		});
		await reconcileUnstoppedEncodings(deps);
		await reconcileUnstoppedEncodings(deps);
		expect(findMany.mock.calls[3]?.[0]).not.toHaveProperty("where.id");
	});
	it("sweeps ERROR rows past the grace window — and does NOT filter on the denormalised encoding id", async () => {
		const { deps, findMany, stopEncoding } = setup({});
		const stopped = await reconcileUnstoppedEncodings(deps);
		expect(stopped).toBe(1);
		expect(stopEncoding).toHaveBeenCalledWith("enc-1");
		const where = (findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
			?.where;
		// RUNNING/QUEUED belong to a live worker; stopping one out from under
		// its processor is the opposite of this module's job.
		expect(where.status).toBe("ERROR");
		expect(where.OR[0].updatedAt.lt).toBeInstanceOf(Date);
		expect(where.OR[1]).toEqual({ remoteStopRequestedAt: { not: null } });
		/**
		 * The finding (review-299 I1): the first version filtered
		 * `bitmovinEncodingId: { not: null }`, and that column is written ONLY
		 * for a job with exactly one CREATE_ENCODING step — `soleEncodingStepId`
		 * returns null for a ladder. So the sweep was blind to every Dolby
		 * multi-encoding job, which is the MOST expensive population there is,
		 * and the test that shipped with it asserted the blind clause as
		 * intended. A denormalised column must not narrow a sweep whose work
		 * walks the step log.
		 */
		expect(where.bitmovinEncodingId).toBeUndefined();
	});

	it("reaches a LADDER job, whose bitmovinEncodingId column is null", async () => {
		// Dolby profiles compile to two and three CREATE_ENCODINGs; the column
		// stays null for all of them, and every one of them bills.
		const { deps, stopEncoding } = setup({
			bitmovinAccountId: ACCOUNT,
			stepLog: stepLog([
				{ resourceId: "enc-a" },
				{ resourceId: "enc-b" },
				{ resourceId: "enc-c" },
			]),
		});
		const stopped = await reconcileUnstoppedEncodings(deps);
		expect(stopped).toBe(3);
		expect(stopEncoding).toHaveBeenCalledTimes(3);
	});

	it("leaves a job inside the grace window alone — Retry must still resume", async () => {
		/**
		 * , measured: a real encoding SIGKILLed twice landed ERROR at
		 * step 15/34 while it kept running and billing, and POST /retry drove the
		 * same row to FINISHED 34/34 in seventy seconds, untouched. /retry
		 * RESUMES — DONE steps keep their resource ids — so stopping the encoding
		 * makes that resume throw on a CANCELED encoding and the only exit left
		 * is a full re-encode. The grace window is what keeps the recovery.
		 */
		const { deps, findMany } = setup({});
		const NOW = new Date("2026-08-25T12:00:00Z");
		await reconcileUnstoppedEncodings(deps, 200, { now: () => NOW });
		const where = (findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
			?.where;
		expect(where.OR[0].updatedAt.lt.toISOString()).toBe(
			"2026-08-25T10:00:00.000Z",
		);
	});

	it("keeps sweeping when ONE row's lookup throws", async () => {
		/**
		 * The module doc promises errors are "logged, never thrown". The loop did
		 * not honour it: findUnique sits outside the inner try blocks, so one
		 * row's DB error abandoned every LATER row — each of which may name an
		 * encoding that is still billing (review-299 F4).
		 */
		const { deps, stopEncoding } = setup({});
		const findUnique = (
			deps.prisma as unknown as {
				encodingJob: { findUnique: ReturnType<typeof vi.fn> };
			}
		).encodingJob.findUnique;
		const findMany = (
			deps.prisma as unknown as {
				encodingJob: { findMany: ReturnType<typeof vi.fn> };
			}
		).encodingJob.findMany;
		findMany.mockResolvedValueOnce([{ id: "job-bad" }, { id: "job-good" }]);
		findUnique.mockRejectedValueOnce(new Error("connection reset"));
		const stopped = await reconcileUnstoppedEncodings(deps);
		// The good row was still reached.
		expect(stopped).toBe(1);
		expect(stopEncoding).toHaveBeenCalledWith("enc-1");
	});

	it("reports a full page as a cap, not completion of the retained population", async () => {
		// ERROR rows do not drain; durable rotation, tested above, replaces the
		// former newest-first starvation. A full page is still a bounded visit.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { deps } = setup({});
			// findMany returns 1 row; limit 1 is a full page, not proof of a tail.
			await reconcileUnstoppedEncodings(deps, 1);
			expect(
				warn.mock.calls.some((args) => String(args[0]).includes("cap")),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("does NOT cry cap when the page came back short", async () => {
		// The arm that makes the pin above mean something: a partial page is
		// full coverage, and warning there would train the operator to ignore it.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { deps } = setup({});
			await reconcileUnstoppedEncodings(deps, 500);
			expect(
				warn.mock.calls.some((args) => String(args[0]).includes("cap")),
			).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});
});
