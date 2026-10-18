import {
	existsSync,
	mkdtempSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	createBoundedObjectProbe,
	createStorageInspectProcessor,
	INSPECT_HEAD_BYTES,
	INSPECT_TAIL_BYTES,
} from "./processor";

/**
 * The inspect processor is tested against a FAKE storage browser and a fake
 * ProcessRunner (CI has no ffprobe and no bucket) but REAL fs, so the
 * scratch-file discipline is genuinely exercised.
 */

const getObject = vi.fn();
// Only the browser factory is faked — `describeStorageError` / `storageErrorText`
// stay REAL, because the C20 classification is exactly what is under test.
vi.mock("@bitovp/storage", async (importActual) => ({
	...(await importActual<typeof import("@bitovp/storage")>()),
	createBrowserForCredential: () => ({
		getObject: (input: unknown) => getObject(input),
		dispose: () => {},
	}),
}));

const INSPECTION_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const CREDENTIAL_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

const PROBE_JSON = JSON.stringify({
	streams: [{ codec_type: "video", codec_name: "h264" }],
	format: { duration: "12.5", format_name: "mov,mp4,m4a" },
});

function setup(
	opts: {
		status?: string;
		claimCount?: number;
		runResults?: { code: number | null; stdout: string; stderr: string }[];
		objectSize?: bigint | null;
	} = {},
) {
	const row = {
		id: INSPECTION_ID,
		credentialId: CREDENTIAL_ID,
		bucket: "customer-bucket",
		objectKey: "masters/movie.mp4",
		status: opts.status ?? "PENDING",
		probe: null,
		bytesRead: null,
		error: null,
		objectSize: opts.objectSize ?? null,
	};
	const updates: Record<string, unknown>[] = [];
	const prisma = {
		storageInspection: {
			findUnique: vi.fn(async () => row),
			updateMany: vi.fn(async () => ({
				count: opts.claimCount ?? 1,
			})),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				updates.push(data);
				Object.assign(row, data);
				return row;
			}),
		},
	} as unknown as AppPrismaClient;

	const results = opts.runResults ?? [
		{ code: 0, stdout: PROBE_JSON, stderr: "" },
	];
	let call = 0;
	const runner: ProcessRunner = {
		spawn: vi.fn(),
		run: vi.fn(
			async () =>
				results[Math.min(call++, results.length - 1)] ?? (results[0] as never),
		),
	} as unknown as ProcessRunner;

	const workDir = mkdtempSync(join(tmpdir(), "inspect-test-"));
	return {
		process: createStorageInspectProcessor({
			prisma,
			resolveCredential: vi.fn(async () => ({
				provider: "AWS_S3",
				config: {},
				secret: { accessKeyId: "a", secretAccessKey: "s" },
			})),
			runner,
			ffprobePath: "ffprobe",
			workDir,
			now: () => "2026-08-06T00:00:00.000Z",
		}),
		prisma,
		row,
		updates,
		runner,
		workDir,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// One 1 MB slice per ranged read.
	getObject.mockImplementation(async () =>
		Readable.from([Buffer.alloc(1024 * 1024)]),
	);
});

describe("storage inspect processor", () => {
	it("reads a CAPPED head, probes it, and persists the ffprobe JSON", async () => {
		const t = setup();
		await expect(
			t.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "FINISHED" });
		// The read is bounded — never the whole object.
		expect(getObject).toHaveBeenCalledTimes(1);
		expect(getObject).toHaveBeenCalledWith({
			bucket: "customer-bucket",
			key: "masters/movie.mp4",
			range: { start: 0, end: INSPECT_HEAD_BYTES - 1 },
		});
		const final = t.updates.at(-1);
		expect(final).toMatchObject({ status: "FINISHED", bytesRead: 1024 * 1024 });
		expect((final?.probe as { streams: unknown[] }).streams).toHaveLength(1);
	});

	it("retries with a second slice when the head has no streams (moov at the end)", async () => {
		const t = setup({
			runResults: [
				// First probe: valid JSON, no streams — the classic non-faststart MP4.
				{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
				{ code: 0, stdout: PROBE_JSON, stderr: "" },
			],
		});
		await expect(
			t.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "FINISHED" });
		expect(getObject).toHaveBeenCalledTimes(2);
		expect(getObject).toHaveBeenNthCalledWith(2, {
			bucket: "customer-bucket",
			key: "masters/movie.mp4",
			range: expect.objectContaining({ start: INSPECT_HEAD_BYTES }),
		});
		// Both slices counted.
		expect(t.updates.at(-1)).toMatchObject({ bytesRead: 2 * 1024 * 1024 });
	});

	it("aims the retry at the TRUE tail when the listing's size rode in (ledger #26)", async () => {
		const size = 500n * 1024n * 1024n; // 500 MB — moov far past head+next-slice
		const t = setup({
			objectSize: size,
			runResults: [
				{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
				{ code: 0, stdout: PROBE_JSON, stderr: "" },
			],
		});
		await expect(
			t.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "FINISHED" });
		const expectedStart = Number(size) - INSPECT_TAIL_BYTES;
		expect(getObject).toHaveBeenNthCalledWith(2, {
			bucket: "customer-bucket",
			key: "masters/movie.mp4",
			range: { start: expectedStart, end: Number(size) - 1 },
		});
	});

	it("a small object's size degenerates to the next-slice window — never a negative start", async () => {
		// size < head+tail: the clamp must land exactly on the pre-#26 window.
		const t = setup({
			objectSize: 10n * 1024n * 1024n,
			runResults: [
				{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
				{ code: 0, stdout: PROBE_JSON, stderr: "" },
			],
		});
		await expect(
			t.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "FINISHED" });
		expect(getObject).toHaveBeenNthCalledWith(2, {
			bucket: "customer-bucket",
			key: "masters/movie.mp4",
			range: expect.objectContaining({ start: INSPECT_HEAD_BYTES }),
		});
	});

	it("size <= head: the doomed 416 retry is SKIPPED and the message says whole-object (review I3)", async () => {
		const t = setup({
			objectSize: 2n * 1024n * 1024n, // whole object fits the 8 MB head
			runResults: [
				{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
			],
		});
		await expect(
			t.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "ERROR" });
		expect(getObject).toHaveBeenCalledTimes(1); // no second, guaranteed-416 read
		const final = t.updates.at(-1);
		expect(final?.error).toMatch(/WHOLE object was read/);
		expect(final?.error).not.toMatch(/head \+ true tail|unread middle/);
	});

	it("range-ignoring + size known: no '(head + true tail)' claim rides the skip message (review I3)", async () => {
		const t = setup({
			objectSize: 500n * 1024n * 1024n,
			runResults: [
				{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
			],
		});
		// A source that ignores the range: streams MORE than the head window
		// from offset 0, which flips head.ignoredRange.
		getObject.mockImplementation(async () =>
			Readable.from(
				(function* () {
					let sent = 0;
					const total = INSPECT_HEAD_BYTES + 1024 * 1024;
					while (sent < total) {
						const size = Math.min(1024 * 1024, total - sent);
						sent += size;
						yield Buffer.alloc(size);
					}
				})(),
			),
		);
		await expect(
			t.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "ERROR" });
		const final = t.updates.at(-1);
		expect(final?.error).not.toMatch(/head \+ true tail/);
		expect(final?.error).toMatch(/ignored the byte-range request/);
	});

	it("a tail read that FAILS never claims a tail was probed (review-175 M13)", async () => {
		const t = setup({
			objectSize: 500n * 1024n * 1024n,
			runResults: [
				{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
			],
		});
		getObject
			.mockImplementationOnce(async () =>
				Readable.from([Buffer.alloc(1024 * 1024)]),
			)
			.mockImplementationOnce(async () => {
				throw new Error("boom");
			});
		await t.process({ storageInspectionId: INSPECTION_ID });
		expect(String(t.updates.at(-1)?.error)).not.toContain("head + true tail");
		expect(String(t.updates.at(-1)?.error)).not.toContain("unread middle");
	});

	it("a tail that comes back RANGE-IGNORED is not probed and not claimed (review-175 M13)", async () => {
		// The re-probe of a head + duplicate-of-head splice is the exact
		// "streams that lie about the file" hazard the docblock names.
		const t = setup({
			objectSize: 500n * 1024n * 1024n,
			runResults: [
				{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
				// If a second probe ran anyway, it would "succeed" — the pin is
				// that it must never run.
				{ code: 0, stdout: PROBE_JSON, stderr: "" },
			],
		});
		getObject
			.mockImplementationOnce(async () =>
				Readable.from([Buffer.alloc(1024 * 1024)]),
			)
			.mockImplementationOnce(async () =>
				Readable.from(
					(function* () {
						let sent = 0;
						const total = INSPECT_TAIL_BYTES + 1024 * 1024;
						while (sent < total) {
							const size = Math.min(1024 * 1024, total - sent);
							sent += size;
							yield Buffer.alloc(size);
						}
					})(),
				),
			);
		await t.process({ storageInspectionId: INSPECTION_ID });
		const final = t.updates.at(-1);
		expect(final?.status).toBe("ERROR");
		expect(String(final?.error)).not.toContain("head + true tail");
	});

	it("records an honest ERROR when even head+tail yields no streams", async () => {
		const t = setup({
			runResults: [{ code: 1, stdout: "", stderr: "invalid data" }],
		});
		await expect(
			t.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "ERROR" });
		const final = t.updates.at(-1);
		expect(final?.status).toBe("ERROR");
		expect(final?.error).toMatch(/no streams|non-faststart/i);
	});

	it("skips a row it cannot claim (redelivered job) without downloading", async () => {
		const t = setup({ status: "FINISHED", claimCount: 0 });
		await expect(
			t.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "FINISHED" });
		expect(getObject).not.toHaveBeenCalled();
		expect(t.updates).toHaveLength(0);
	});

	it("removes the scratch slice on success AND on failure", async () => {
		const ok = setup();
		await ok.process({ storageInspectionId: INSPECTION_ID });
		expect(readdirSync(ok.workDir)).toEqual([]);

		const bad = setup();
		getObject.mockRejectedValueOnce(new Error("403 from storage"));
		await expect(
			bad.process({ storageInspectionId: INSPECTION_ID }),
		).resolves.toMatchObject({ status: "ERROR" });
		expect(readdirSync(bad.workDir)).toEqual([]);
	});

	it("starts from a clean slice even if a previous run left one behind", async () => {
		const t = setup();
		const stale = join(t.workDir, `inspect-${INSPECTION_ID}.mp4`);
		writeFileSync(stale, Buffer.alloc(4096));
		expect(existsSync(stale)).toBe(true);
		await t.process({ storageInspectionId: INSPECTION_ID });
		// Exactly one slice was counted — the stale bytes were removed first, not
		// appended to (append mode would otherwise corrupt the probe input).
		expect(t.updates.at(-1)).toMatchObject({ bytesRead: 1024 * 1024 });
	});
});

describe("the bound holds when the storage endpoint IGNORES the range", () => {
	/**
	 * `Range` is optional in HTTP and GenericS3 points at arbitrary vendor
	 * endpoints (C10), so a 200-with-the-whole-object is a real answer. A pipe
	 * that trusts its own request writes the entire object to the worker's disk;
	 * these tests fail if the cap is only *requested* and not *enforced*.
	 */
	/** A source that ignores the range and streams `total` bytes from offset 0. */
	function unboundedSource(total: number, chunk = 1024 * 1024) {
		return () =>
			Readable.from(
				(function* () {
					let sent = 0;
					while (sent < total) {
						const size = Math.min(chunk, total - sent);
						sent += size;
						yield Buffer.alloc(size);
					}
				})(),
			);
	}

	it("writes at most the head window, not the whole object", async () => {
		const t = setup();
		// 5× the head window: a well-behaved server would have sent 8 MB.
		getObject.mockImplementation(async () =>
			unboundedSource(INSPECT_HEAD_BYTES * 5)(),
		);
		await t.process({ storageInspectionId: INSPECTION_ID });
		const finished = t.updates.find((u) => u.status === "FINISHED");
		expect(finished?.bytesRead).toBe(INSPECT_HEAD_BYTES);
	});

	it("SKIPS the tail retry, because an offset read would re-read the start", async () => {
		// Splicing byte 0..4MB onto byte 0..8MB and probing it could make ffprobe
		// report streams that describe a file the customer does not have.
		const t = setup({
			runResults: [
				{ code: 1, stdout: "", stderr: "no streams" },
				{ code: 0, stdout: PROBE_JSON, stderr: "" },
			],
		});
		getObject.mockImplementation(async () =>
			unboundedSource(INSPECT_HEAD_BYTES * 3)(),
		);
		const res = await t.process({ storageInspectionId: INSPECTION_ID });
		expect(res.status).toBe("ERROR");
		// Exactly one read: the tail was never requested.
		expect(getObject).toHaveBeenCalledTimes(1);
		const errored = t.updates.find((u) => u.status === "ERROR");
		expect(errored?.error).toContain("ignored the byte-range request");
	});

	it("a well-behaved source that ends exactly at the window still gets the tail retry", async () => {
		// The boundary case that must NOT be mistaken for a range-ignoring server:
		// ending at exactly `limit` is correct behaviour, not overflow.
		const t = setup({
			runResults: [
				{ code: 1, stdout: "", stderr: "no streams" },
				{ code: 0, stdout: PROBE_JSON, stderr: "" },
			],
		});
		let call = 0;
		getObject.mockImplementation(async () => {
			call += 1;
			return unboundedSource(
				call === 1 ? INSPECT_HEAD_BYTES : INSPECT_TAIL_BYTES,
			)();
		});
		const res = await t.process({ storageInspectionId: INSPECTION_ID });
		expect(res.status).toBe("FINISHED");
		expect(getObject).toHaveBeenCalledTimes(2);
		const finished = t.updates.find((u) => u.status === "FINISHED");
		expect(finished?.bytesRead).toBe(INSPECT_HEAD_BYTES + INSPECT_TAIL_BYTES);
	});

	it("detects a range-ignoring source whose CHUNKS align with the window", async () => {
		// Regression: an earlier cut flagged overflow only when a chunk crossed
		// the boundary, so 1 MB chunks into an 8 MB window looked well-behaved and
		// a 24 MB object passed as "exactly what we asked for". Powers of two make
		// this the LIKELY case, not the exotic one.
		const t = setup({
			runResults: [
				{ code: 1, stdout: "", stderr: "no streams" },
				{ code: 0, stdout: PROBE_JSON, stderr: "" },
			],
		});
		getObject.mockImplementation(async () =>
			unboundedSource(INSPECT_HEAD_BYTES * 3, 1024 * 1024)(),
		);
		const res = await t.process({ storageInspectionId: INSPECTION_ID });
		expect(res.status).toBe("ERROR");
		expect(getObject).toHaveBeenCalledTimes(1);
	});

	it("does not loop forever on a source that only sends EMPTY chunks", async () => {
		// `for await` delivers zero-length buffers, and an empty chunk does not
		// advance `bytes`, so without a stall bound the window never fills and this
		// function's "at most N bytes" contract is false. No current driver emits
		// them — the point is that the bound holds for a reason, not by luck. The
		// test would hang rather than fail if the guard were removed, which is why
		// it carries its own timeout.
		const t = setup();
		getObject.mockImplementation(async () =>
			Readable.from(
				(function* () {
					for (;;) {
						yield Buffer.alloc(0);
					}
				})(),
			),
		);
		const res = await t.process({ storageInspectionId: INSPECTION_ID });
		expect(res.status).toBe("ERROR");
		const errored = t.updates.find((u) => u.status === "ERROR");
		expect(errored?.error).toContain("empty chunks in a row");
	}, 10_000);

	it("leaves no scratch bytes behind after a truncated read", async () => {
		const t = setup();
		getObject.mockImplementation(async () =>
			unboundedSource(INSPECT_HEAD_BYTES * 4)(),
		);
		await t.process({ storageInspectionId: INSPECTION_ID });
		expect(readdirSync(t.workDir)).toEqual([]);
	});

	/**
	 * C20: the persisted `error` is served verbatim by
	 * GET /api/storage-inspections/[id], so a storage-driver message — which
	 * embeds the endpoint the WORKER dialed — must never reach it.
	 */
	describe("driver errors are classified, never echoed (C20)", () => {
		const LEAKY = [
			{
				name: "a refused connection to an internal IP",
				err: Object.assign(new Error("connect ECONNREFUSED 10.0.7.22:9000"), {
					name: "Error",
					code: "ECONNREFUSED",
				}),
				secrets: ["10.0.7.22", "9000", "ECONNREFUSED"],
			},
			{
				name: "a DNS miss naming an internal host",
				err: Object.assign(
					new Error("getaddrinfo ENOTFOUND minio.internal.corp"),
					{ name: "Error", code: "ENOTFOUND" },
				),
				secrets: ["minio.internal.corp", "ENOTFOUND"],
			},
			{
				name: "an AWS SDK error carrying the endpoint",
				err: Object.assign(
					new Error(
						"NoSuchKey: The specified key does not exist. endpoint https://minio.internal.corp:9000/customer-bucket",
					),
					{
						name: "NoSuchKeyError",
						Code: "NoSuchKey",
						$metadata: { httpStatusCode: 404 },
					},
				),
				secrets: ["minio.internal.corp", "9000", "does not exist"],
			},
		];

		for (const { name, err, secrets } of LEAKY) {
			it(`does not persist ${name}`, async () => {
				const t = setup();
				getObject.mockRejectedValue(err);
				const res = await t.process({ storageInspectionId: INSPECTION_ID });
				expect(res.status).toBe("ERROR");
				const stored = String(t.updates.at(-1)?.error ?? "");
				// The oracle the finding is about: nothing that distinguishes one
				// upstream failure mode / host / port from another.
				for (const secret of secrets) {
					expect(stored).not.toContain(secret);
				}
				// Still classified enough to be actionable for an operator.
				expect(stored).toMatch(/^Storage request failed: /);
			});
		}

		it("collapses distinct network failures to indistinguishable text", async () => {
			// The whole point: ECONNREFUSED (host up, port closed) vs ENOTFOUND
			// (no such host) must not be tellable apart by a caller.
			const stored: string[] = [];
			for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]) {
				const t = setup();
				getObject.mockRejectedValue(
					Object.assign(new Error(`connect ${code} 10.0.7.22:9000`), {
						name: "Error",
						code,
					}),
				);
				await t.process({ storageInspectionId: INSPECTION_ID });
				stored.push(String(t.updates.at(-1)?.error ?? ""));
			}
			expect(new Set(stored).size).toBe(1);
		});

		it("still persists OUR OWN honest messages verbatim", async () => {
			// These are authored here, name only the object and the bound we hit,
			// and must survive the classification.
			const t = setup({
				runResults: [{ code: 1, stdout: "", stderr: "" }],
			});
			const res = await t.process({ storageInspectionId: INSPECTION_ID });
			expect(res.status).toBe("ERROR");
			expect(String(t.updates.at(-1)?.error)).toMatch(
				/ffprobe found no streams in the .* probed from/,
			);
		});
	});

	it("persists no probe field naming the worker's scratch path", async () => {
		// ffprobe -show_format always emits format.filename = our scratch file.
		// It matches nothing in redactSecrets and the probe blob is served to
		// callers, so it must be stripped.
		const t = setup({
			runResults: [
				{
					code: 0,
					stdout: JSON.stringify({
						streams: [{ codec_type: "video", codec_name: "h264" }],
						format: {
							filename: "/tmp/bitovp-vmaf/inspect-9d8c7b6a.mp4",
							duration: "12.5",
							format_name: "mov,mp4,m4a",
						},
					}),
					stderr: "",
				},
			],
		});
		await t.process({ storageInspectionId: INSPECTION_ID });
		const probe = t.updates.at(-1)?.probe as {
			format: Record<string, unknown>;
		};
		expect(probe.format).not.toHaveProperty("filename");
		expect(JSON.stringify(probe)).not.toContain("bitovp-vmaf");
		// The useful metadata survives.
		expect(probe.format).toMatchObject({
			duration: "12.5",
			format_name: "mov,mp4,m4a",
		});
	});

	it("creates the scratch slice 0600, not world-readable", async () => {
		// Shared workdir (os.tmpdir): the default 0644 would let any local
		// account read customer media bytes for the lifetime of the probe.
		let observed: number | undefined;
		const t = setup({
			runResults: [{ code: 0, stdout: PROBE_JSON, stderr: "" }],
		});
		// ffprobe runs while the slice still exists (it is rm'd in `finally`), so
		// this is the one place the mode can be observed.
		const runner = t.runner as unknown as { run: ReturnType<typeof vi.fn> };
		runner.run.mockImplementation(async (_bin: string, argv: string[]) => {
			const path = argv.at(-1) as string;
			if (existsSync(path)) {
				observed = statSync(path).mode & 0o777;
			}
			return { code: 0, stdout: PROBE_JSON, stderr: "" };
		});
		await t.process({ storageInspectionId: INSPECTION_ID });
		expect(observed).toBe(0o600);
	});
});

describe("createBoundedObjectProbe (ledger #239)", () => {
	function probeSetup(
		runResults: { code: number | null; stdout: string; stderr: string }[],
	) {
		let call = 0;
		const runner: ProcessRunner = {
			spawn: vi.fn(),
			run: vi.fn(
				async () =>
					runResults[Math.min(call++, runResults.length - 1)] ??
					(runResults[0] as never),
			),
		} as unknown as ProcessRunner;
		const workDir = mkdtempSync(join(tmpdir(), "probe-test-"));
		return {
			workDir,
			runner,
			probe: createBoundedObjectProbe({
				resolveCredential: vi.fn(async () => ({
					provider: "AWS_S3",
					config: {},
					secret: { accessKeyId: "a", secretAccessKey: "s" },
				})),
				runner,
				ffprobePath: "ffprobe",
				workDir,
			}),
		};
	}

	const args = {
		label: "slate-1",
		credentialId: CREDENTIAL_ID,
		bucket: "customer-bucket",
		key: "slates/clip.mp4",
	};

	it("reads a CAPPED head and returns the parsed probe", async () => {
		const t = probeSetup([{ code: 0, stdout: PROBE_JSON, stderr: "" }]);
		await expect(t.probe(args)).resolves.toMatchObject({
			streams: [{ codec_name: "h264" }],
		});
		expect(getObject).toHaveBeenCalledTimes(1);
		expect(getObject).toHaveBeenCalledWith({
			bucket: "customer-bucket",
			key: "slates/clip.mp4",
			range: { start: 0, end: INSPECT_HEAD_BYTES - 1 },
		});
		// Never keep customer bytes: the slice is gone whatever happened.
		expect(readdirSync(t.workDir)).toEqual([]);
	});

	it("retries with a second slice when the head carries no streams", async () => {
		const t = probeSetup([
			{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
			{ code: 0, stdout: PROBE_JSON, stderr: "" },
		]);
		await expect(t.probe(args)).resolves.toMatchObject({
			streams: [{ codec_name: "h264" }],
		});
		expect(getObject).toHaveBeenCalledTimes(2);
		expect(getObject).toHaveBeenLastCalledWith({
			bucket: "customer-bucket",
			key: "slates/clip.mp4",
			range: {
				start: INSPECT_HEAD_BYTES,
				end: INSPECT_HEAD_BYTES + INSPECT_TAIL_BYTES - 1,
			},
		});
		expect(readdirSync(t.workDir)).toEqual([]);
	});

	it("answers null — never throws — when the object cannot be read", async () => {
		// The caller is a preflight: "not measured" must not become a failure.
		getObject.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.7.22:9000"));
		const t = probeSetup([{ code: 0, stdout: PROBE_JSON, stderr: "" }]);
		await expect(t.probe(args)).resolves.toBeNull();
		expect(readdirSync(t.workDir)).toEqual([]);
	});

	it("answers null when ffprobe finds no streams in the bounded window", async () => {
		const t = probeSetup([
			{ code: 0, stdout: JSON.stringify({ format: {} }), stderr: "" },
		]);
		await expect(t.probe(args)).resolves.toBeNull();
	});

	it("answers null when ffprobe itself fails", async () => {
		const t = probeSetup([{ code: 1, stdout: "", stderr: "not found" }]);
		await expect(t.probe(args)).resolves.toBeNull();
	});
});
