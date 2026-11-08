import { describe, expect, it, vi } from "vitest";
import { MediaOperationError } from "./process";
import {
	logRenderFailureDiagnostic,
	type RenderFailureContext,
	renderFailureDiagnostic,
} from "./render-failure-diagnostics";

const context: RenderFailureContext = {
	runId: "00000000-0000-4000-8000-000000000001",
	organizationId: "00000000-0000-4000-8000-000000000002",
	projectId: "00000000-0000-4000-8000-000000000003",
	revisionId: "00000000-0000-4000-8000-000000000004",
	stage: "RENDERING",
	operation: "COMPOSITION_RENDER",
	schemaVersion: 2,
	previousAttempts: 1,
	elapsedMs: 158_321.9,
};
describe("private render failure diagnostics", () => {
	it("emits only the fixed projection and never serializes raw error data", () => {
		const secret = "raw-caption-token-and-object-locator";
		const error = new MediaOperationError(
			"PROCESS_FAILED",
			secret,
			`No such filter: '${secret}'`,
		);
		const toJSON = vi.fn(() => secret);
		Object.assign(error, { secret, toJSON });
		const emit = vi.fn();
		logRenderFailureDiagnostic(context, error, emit);
		expect(emit).toHaveBeenCalledOnce();
		expect(JSON.parse(emit.mock.calls[0]?.[0])).toEqual({
			event: "library_render_failed",
			version: 1,
			entryPoint: "LIBRARY_EDITING_SWEEP",
			...context,
			elapsedMs: 158_321,
			errorClass: "MediaOperationError",
			errorCode: "PROCESS_FAILED",
			httpStatus: null,
			processSignature: "FILTER_GRAPH",
		});
		expect(String(emit.mock.calls[0]?.[0])).not.toContain(secret);
		expect(toJSON).not.toHaveBeenCalled();
	});
	it.each([
		["Cannot allocate memory", "OUT_OF_MEMORY"],
		["No space left on device", "DISK_FULL"],
		[
			"pthread_create failed: Resource temporarily unavailable",
			"RESOURCE_LIMIT",
		],
		["Failed to configure output pad on Parsed_scale_1", "FILTER_GRAPH"],
		["Error while opening encoder", "ENCODER"],
		["No such file or directory", "MISSING_FILE"],
		["Permission denied", "ACCESS_DENIED"],
		["moov atom not found", "INVALID_MEDIA"],
		["av_interleaved_write_frame: Broken pipe", "OUTPUT_IO"],
		["Invalid argument", "INVALID_ARGUMENT"],
		["private text with no known signature", "UNKNOWN"],
	])("classifies bounded stderr %s without returning it", (diagnostic, signature) => {
		expect(
			renderFailureDiagnostic(
				context,
				new MediaOperationError("PROCESS_FAILED", "unused", diagnostic),
			).processSignature,
		).toBe(signature);
	});
	it("never treats raw message text or unrelated error diagnostics as FFmpeg stderr", () => {
		expect(
			renderFailureDiagnostic(
				context,
				new MediaOperationError("PROCESS_FAILED", "No space left on device"),
			).processSignature,
		).toBe("UNKNOWN");
		expect(
			renderFailureDiagnostic(context, {
				name: "Error",
				diagnostic: "No space left on device",
			}).processSignature,
		).toBe("UNKNOWN");
	});
	it.each([
		{ code: "ECONNRESET", statusCode: 503 },
		{ code: "ECONNRESET", status: 503 },
		{ code: "ECONNRESET", $metadata: { httpStatusCode: 503 } },
	])("reads only known codes and bounded HTTP status through data descriptors", (error) => {
		expect(renderFailureDiagnostic(context, error)).toMatchObject({
			errorClass: "UNKNOWN",
			errorCode: "ECONNRESET",
			httpStatus: 503,
		});
	});
	it("does not execute accessors or coercion hooks on an unknown error", () => {
		const getter = vi.fn(() => {
			throw new Error("secret getter");
		});
		const error = Object.create(null);
		for (const key of [
			"name",
			"code",
			"diagnostic",
			"message",
			"stack",
			"status",
			"statusCode",
			"$metadata",
			"toJSON",
		])
			Object.defineProperty(error, key, { get: getter });
		expect(renderFailureDiagnostic(context, error)).toMatchObject({
			errorClass: "UNKNOWN",
			errorCode: "UNKNOWN",
			httpStatus: null,
			processSignature: "UNKNOWN",
		});
		expect(getter).not.toHaveBeenCalled();
	});
	it("contains revoked and throwing proxies and rejects unsafe context fields", () => {
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		const throwing = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw new Error("private trap");
				},
				getPrototypeOf() {
					throw new Error("private prototype");
				},
			},
		);
		for (const error of [revoked.proxy, throwing]) {
			expect(() =>
				logRenderFailureDiagnostic(context, error, () => {}),
			).not.toThrow();
			expect(renderFailureDiagnostic(context, error).errorCode).toBe("UNKNOWN");
		}
		const unsafe = {
			...context,
			runId: "secret",
			stage: "secret",
			operation: "secret",
			elapsedMs: Infinity,
		};
		const result = renderFailureDiagnostic(unsafe as RenderFailureContext, {
			code: "secret",
			statusCode: 600,
		});
		expect(result).toMatchObject({
			runId: null,
			stage: "UNKNOWN",
			operation: "UNKNOWN",
			elapsedMs: null,
			errorCode: "UNKNOWN",
			httpStatus: null,
		});
		expect(JSON.stringify(result)).not.toContain("secret");
	});
	it("contains an unavailable log sink and recognizes native errors without reading message", () => {
		expect(() =>
			logRenderFailureDiagnostic(context, new TypeError("private"), () => {
				throw new Error("sink");
			}),
		).not.toThrow();
		expect(
			renderFailureDiagnostic(context, new TypeError("private")).errorClass,
		).toBe("TypeError");
	});
});
