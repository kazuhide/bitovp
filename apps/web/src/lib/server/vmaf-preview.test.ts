import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import {
	encodingPlanSchema,
	enumerateQcTargets,
	perTitleRungsFromSnapshot,
} from "@bitovp/core";
import {
	ObjectVersionMismatchError,
	VersionExpectationUnsupportedError,
} from "@bitovp/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const browser = vi.fn();
vi.mock("./storage", () => ({
	browserForCredentialId: (...args: unknown[]) => browser(...args),
}));

import {
	previewDescriptor,
	resolveVmafPreview,
	serveVmafPreview,
} from "./vmaf-preview";

const reportId = "00000000-0000-4000-8000-000000000001";
const resultId = "00000000-0000-4000-8000-000000000002";
function fixture() {
	const plan = encodingPlanSchema.parse({
		...JSON.parse(
			readFileSync(
				resolve(
					process.cwd(),
					"../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
				),
				"utf8",
			),
		),
		qc: { vmaf: true },
	});
	const key = enumerateQcTargets(plan)[0]?.distorted.path;
	if (!key) throw new Error("Missing fixture target");
	return {
		mode: "VOD",
		params: { reference: { fps: 24 } },
		encodingJob: { plan },
		result: {
			id: resultId,
			renditionRef: { renditionKey: "v360" },
			provenance: {
				distorted: {
					bucket: "sample-output-bucket",
					key,
					identity: { etag: '"sealed"', size: 10 },
					pinned: true,
					bytes: 10,
				},
			},
		},
	};
}
const ctx = {} as Parameters<typeof serveVmafPreview>[0];
beforeEach(() => vi.clearAllMocks());
describe("VMAF preview resolution (small, no I/O)", () => {
	it("projects only a report-scoped URL, never storage identity", () => {
		const f = fixture();
		expect(
			previewDescriptor(
				reportId,
				f,
				f.result,
				"00000000-0000-4000-8000-000000000001",
			),
		).toEqual({
			url: `/api/vmaf-jobs/${reportId}/preview?resultId=${resultId}&expectedOrganizationId=00000000-0000-4000-8000-000000000001`,
		});
		expect(resolveVmafPreview(f, f.result)).toMatchObject({
			credentialId: f.encodingJob.plan.outputs[0]?.credentialId,
			key: f.result.provenance.distorted.key,
			expect: { etag: '"sealed"' },
			size: 10,
		});
	});
	it.each([
		0,
		-1,
		Number.NaN,
		undefined,
	])("refuses missing/invalid FPS %s", (fps) => {
		const f = fixture();
		expect(
			resolveVmafPreview({ ...f, params: { reference: { fps } } }, f.result),
		).toEqual({ unavailableReason: "MISSING_FPS" });
	});
	it("never substitutes a live stream for discarded captures", () => {
		const f = fixture();
		expect(resolveVmafPreview({ ...f, mode: "LIVE" }, f.result)).toEqual({
			unavailableReason: "LIVE_CAPTURE_NOT_RETAINED",
		});
	});
	it.each([
		null,
		{ distorted: { pinned: false } },
		{
			distorted: {
				...fixture().result.provenance.distorted,
				identity: { size: 10 },
			},
		},
		{ distorted: { ...fixture().result.provenance.distorted, bytes: 9 } },
	])("refuses unpinned/incomplete provenance", (provenance) => {
		const f = fixture();
		expect(resolveVmafPreview(f, { ...f.result, provenance })).toEqual({
			unavailableReason: "MISSING_PROVENANCE",
		});
	});
	it("binds the exact target output and path, not any accessible output", () => {
		const f = fixture();
		f.encodingJob.plan.outputs.push({
			kind: "S3",
			credentialId: resultId,
			name: "Other output",
			key: "other",
			bucket: "other-bucket",
		});
		f.result.provenance.distorted.bucket = "other-bucket";
		expect(resolveVmafPreview(f, f.result)).toEqual({
			unavailableReason: "UNSUPPORTED_SOURCE",
		});
		f.result.provenance.distorted.bucket = "sample-output-bucket";
		f.result.provenance.distorted.key = "private/unrelated.mp4";
		expect(resolveVmafPreview(f, f.result)).toEqual({
			unavailableReason: "UNSUPPORTED_SOURCE",
		});
	});
	it("accepts captured and legacy-listing variants for multi-segment per-title paths", () => {
		const f = fixture();
		const destination = f.encodingJob.plan.muxings[0]?.destination;
		if (!destination) throw new Error("Missing fixture destination");
		destination.path = "runs/run-1/{height}/{bitrate}_{uuid}";
		const target = enumerateQcTargets(f.encodingJob.plan)[0];
		if (!target) throw new Error("Missing fixture target");
		const [captured] = perTitleRungsFromSnapshot(
			{
				capturedAt: "2026-09-16T00:00:00Z",
				streams: [
					{
						streamId: "rung-720",
						mode: "PER_TITLE_RESULT",
						templateRendition: "v360",
						params: {},
						muxings: [
							{
								muxingId: "qc-mirror",
								muxingType: "MP4",
								outputs: [
									{
										outputId: "origin",
										outputPath: "runs/run-1/720/1000_abcd/qc/",
									},
								],
								drm: [],
							},
						],
					},
				],
				scan: {
					streamsListed: 1,
					templatesListed: 1,
					templatesDeclared: 1,
					resultsCaptured: 1,
					muxingsListed: 1,
					complete: true,
					codecConfigErrors: 0,
					unattributed: 0,
				},
			},
			{ ...target, providerOutputId: "origin" },
		);
		if (!captured || "missing" in captured)
			throw new Error("Missing captured rung");
		expect(captured.variant).toBe("720");
		f.result.provenance.distorted.key = captured.key;
		for (const perTitleVariant of [captured.variant, "720/1000_abcd"]) {
			const result = {
				...f.result,
				renditionRef: { renditionKey: "v360", perTitleVariant },
			};
			expect(resolveVmafPreview(f, result)).toHaveProperty("key", captured.key);
			expect(
				resolveVmafPreview(f, {
					...result,
					provenance: {
						distorted: {
							...result.provenance.distorted,
							bucket: "other-bucket",
						},
					},
				}),
			).toEqual({ unavailableReason: "UNSUPPORTED_SOURCE" });
			expect(
				resolveVmafPreview(f, {
					...result,
					provenance: {
						distorted: {
							...result.provenance.distorted,
							key: captured.key.replace("run-1", "run-2"),
						},
					},
				}),
			).toEqual({ unavailableReason: "UNSUPPORTED_SOURCE" });
		}
		for (const perTitleVariant of [
			undefined,
			"1000_abcd",
			"720/other",
			"other/1000_abcd",
		]) {
			expect(
				resolveVmafPreview(f, {
					...f.result,
					renditionRef: { renditionKey: "v360", perTitleVariant },
				}),
			).toEqual({ unavailableReason: "UNSUPPORTED_SOURCE" });
		}
	});
	it("matches each per-title template segment and the recorded variant", () => {
		const f = fixture();
		const destination = f.encodingJob.plan.muxings[0]?.destination;
		if (!destination) throw new Error("Missing fixture destination");
		destination.path = "runs/run-1/{height}_{bitrate}_{uuid}";
		f.result.provenance.distorted.key = "runs/run-1/720_1000_abcd/qc/v360.mp4";
		const r = {
			...f.result,
			renditionRef: { renditionKey: "v360", perTitleVariant: "720_1000_abcd" },
		};
		expect(resolveVmafPreview(f, r)).toHaveProperty(
			"key",
			r.provenance.distorted.key,
		);
		expect(
			resolveVmafPreview(f, {
				...r,
				renditionRef: { ...r.renditionRef, perTitleVariant: "other" },
			}),
		).toEqual({ unavailableReason: "UNSUPPORTED_SOURCE" });
		r.provenance.distorted.key = "runs/run-2/720_1000_abcd/qc/v360.mp4";
		expect(resolveVmafPreview(f, r)).toEqual({
			unavailableReason: "UNSUPPORTED_SOURCE",
		});
	});
});
describe("VMAF preview transfer (small, fake storage streams)", () => {
	function setup(size = 10) {
		const f = fixture();
		f.result.provenance.distorted.bytes = size;
		f.result.provenance.distorted.identity.size = size;
		const target = resolveVmafPreview(f, f.result);
		if ("unavailableReason" in target) throw Error("fixture unavailable");
		const getObject = vi
			.fn()
			.mockResolvedValue(Readable.from([Buffer.from("0123456789")]));
		const dispose = vi.fn();
		browser.mockResolvedValue({ getObject, dispose });
		return { target, getObject, dispose };
	}
	it("serves full small media with no-store and exact pinned identity", async () => {
		const { target, getObject, dispose } = setup();
		const response = await serveVmafPreview(
			ctx,
			new Request("http://test"),
			target,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("0123456789");
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(response.headers.get("Content-Type")).toBe("video/mp4");
		expect(getObject).toHaveBeenCalledWith({
			bucket: target.bucket,
			key: target.key,
			expect: target.expect,
			range: { start: 0, end: 9 },
		});
		expect(dispose).toHaveBeenCalledOnce();
	});
	it.each([
		"bytes=3-5",
		"bytes=-3",
		"bytes=7-",
	])("serves one bounded range %s", async (range) => {
		const { target, getObject } = setup();
		getObject.mockResolvedValue(Readable.from([Buffer.from("abc")]));
		const response = await serveVmafPreview(
			ctx,
			new Request("http://test", { headers: { range } }),
			target,
		);
		expect(response.status).toBe(206);
		expect(await response.text()).toBe("abc");
		expect(response.headers.get("Content-Range")).toBe(
			`bytes ${range === "bytes=3-5" ? "3-5" : "7-9"}/10`,
		);
	});
	it.each([
		"bytes=99-",
		"bytes=4-1",
		"bytes=0-1,4-5",
		"bytes=-0",
		"not-a-range",
	])("rejects malformed/unsatisfiable %s before credential access", async (range) => {
		const { target } = setup();
		const response = await serveVmafPreview(
			ctx,
			new Request("http://test", { headers: { range } }),
			target,
		);
		expect(response.status).toBe(416);
		expect(response.headers.get("Content-Range")).toBe("bytes */10");
		expect(browser).not.toHaveBeenCalled();
	});
	it("caps an open range to 4 MiB and refuses unbounded large no-Range reads", async () => {
		const { target, getObject } = setup(9_000_000);
		expect(
			(await serveVmafPreview(ctx, new Request("http://test"), target)).status,
		).toBe(416);
		getObject.mockResolvedValue(Readable.from([Buffer.alloc(4 * 1024 * 1024)]));
		const res = await serveVmafPreview(
			ctx,
			new Request("http://test", { headers: { range: "bytes=0-" } }),
			target,
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Length")).toBe("4194304");
	});
	it("rejects changed objects without leaking provider paths or retrying unpinned", async () => {
		const { target, getObject, dispose } = setup();
		getObject.mockRejectedValue(
			new ObjectVersionMismatchError("secret-bucket", "secret-key", {
				etag: "private",
			}),
		);
		const res = await serveVmafPreview(ctx, new Request("http://test"), target);
		expect(res.status).toBe(409);
		expect(await res.text()).not.toMatch(/secret|private/);
		expect(getObject).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
	});
	it.each([
		"request",
		"stream",
	])("reports a missing object during %s without leaking storage locators", async (phase) => {
		const { target, getObject, dispose } = setup();
		const error = Object.assign(new Error("secret-bucket/secret-key"), {
			name: "NoSuchKey",
			$metadata: { httpStatusCode: 404 },
		});
		if (phase === "request") getObject.mockRejectedValue(error);
		else
			getObject.mockResolvedValue(
				Readable.from(
					(async function* () {
						yield Buffer.from("0");
						throw error;
					})(),
				),
			);
		const response = await serveVmafPreview(
			ctx,
			new Request("http://test"),
			target,
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "Media file not found",
			details: { code: "MEDIA_FILE_NOT_FOUND" },
		});
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(dispose).toHaveBeenCalledOnce();
	});
	it.each([
		401, 403,
	])("keeps authorization failure distinct from a missing object (%s)", async (status) => {
		const { target, getObject } = setup();
		getObject.mockRejectedValue({
			name: "AccessDenied",
			$metadata: { httpStatusCode: status },
			message: "private-bucket private-key secret",
		});
		const response = await serveVmafPreview(
			ctx,
			new Request("http://test"),
			target,
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Media storage access denied",
			details: { code: "MEDIA_STORAGE_ACCESS_DENIED" },
		});
	});
	it.each(["short", "overlong"])("rejects %s transfers", async (kind) => {
		const { target, getObject, dispose } = setup();
		getObject.mockResolvedValue(
			Readable.from([Buffer.alloc(kind === "short" ? 9 : 11)]),
		);
		expect(
			(await serveVmafPreview(ctx, new Request("http://test"), target)).status,
		).toBe(502);
		expect(dispose).toHaveBeenCalledOnce();
	});
	it("aborts stalled reads and disposes their stream", async () => {
		const { target, getObject, dispose } = setup();
		const source = new Readable({ read() {} });
		getObject.mockResolvedValue(source);
		const controller = new AbortController();
		const pending = serveVmafPreview(
			ctx,
			new Request("http://test", { signal: controller.signal }),
			target,
		);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		expect((await pending).status).toBe(408);
		expect(source.destroyed).toBe(true);
		expect(dispose).toHaveBeenCalledOnce();
	});
	it("times out stalled reads at 15 seconds", async () => {
		vi.useFakeTimers();
		try {
			const { target, getObject, dispose } = setup();
			const source = new Readable({ read() {} });
			getObject.mockResolvedValue(source);
			const pending = serveVmafPreview(ctx, new Request("http://test"), target);
			await vi.advanceTimersByTimeAsync(15_000);
			expect((await pending).status).toBe(408);
			expect(source.destroyed).toBe(true);
			expect(dispose).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
	it("disposes a credential browser that arrives after cancellation without reading media", async () => {
		const { target, getObject, dispose } = setup();
		let arrive:
			| ((value: {
					getObject: typeof getObject;
					dispose: typeof dispose;
			  }) => void)
			| undefined;
		browser.mockReturnValue(
			new Promise((resolve) => {
				arrive = resolve;
			}),
		);
		const controller = new AbortController();
		const pending = serveVmafPreview(
			ctx,
			new Request("http://test", { signal: controller.signal }),
			target,
		);
		controller.abort();
		expect((await pending).status).toBe(408);
		arrive?.({ getObject, dispose });
		await new Promise((resolve) => setImmediate(resolve));
		expect(dispose).toHaveBeenCalledOnce();
		expect(getObject).not.toHaveBeenCalled();
	});
	it("never retries an unsupported pin as a current-object read", async () => {
		const { target, getObject, dispose } = setup();
		getObject.mockRejectedValue(
			new VersionExpectationUnsupportedError(
				"private",
				"secret",
				target.expect,
				"internal",
			),
		);
		const res = await serveVmafPreview(ctx, new Request("http://test"), target);
		expect(res.status).toBe(502);
		expect(await res.text()).not.toMatch(/private|secret|internal/);
		expect(getObject).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
