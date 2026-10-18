import { describe, expect, it } from "vitest";
import { lastKnownBitmovinStatus } from "./bitmovin-encoding-status";

/** Step-log entry shaped like the orchestrator persists it. */
function entry(over: Record<string, unknown> = {}) {
	return {
		step: "await:encoding",
		kind: "AWAIT_ENCODING",
		payload: {},
		refs: { encodingId: "encoding" },
		status: "DONE",
		...over,
	};
}

describe("lastKnownBitmovinStatus", () => {
	it("returns null for a non-array / empty / status-free step log", () => {
		expect(lastKnownBitmovinStatus(null)).toBeNull();
		expect(lastKnownBitmovinStatus(undefined)).toBeNull();
		expect(lastKnownBitmovinStatus("[]")).toBeNull();
		expect(lastKnownBitmovinStatus([])).toBeNull();
		expect(
			lastKnownBitmovinStatus([
				{ step: "input:main", kind: "CREATE_INPUT_S3", status: "DONE" },
			]),
		).toBeNull();
	});

	it("reads the awaited task status off a DONE AWAIT_ENCODING response", () => {
		expect(
			lastKnownBitmovinStatus([
				entry({ response: { status: "FINISHED", progress: 100 } }),
			]),
		).toBe("FINISHED");
	});

	it("parses TRANSFER_ERROR out of the FAILED step's executor message", () => {
		// awaitTask throws `${op.step} ended ${task.status}${detail}`.
		const log = [
			entry({
				status: "FAILED",
				error: "await:encoding ended TRANSFER_ERROR: could not upload segment",
			}),
		];
		expect(lastKnownBitmovinStatus(log)).toBe("TRANSFER_ERROR");
	});

	it("parses the timeout message's last-seen status", () => {
		expect(
			lastKnownBitmovinStatus([
				entry({
					status: "FAILED",
					error: "await:encoding timed out after 7200s (last status RUNNING)",
				}),
			]),
		).toBe("RUNNING");
	});

	it("prefers the FAILED error over the stop-siblings response (which has no status)", () => {
		// The stop-siblings contract writes a `response` onto the FAILED entry;
		// reading the response first would lose the real answer.
		expect(
			lastKnownBitmovinStatus([
				entry({
					status: "FAILED",
					error: "await:encoding ended TRANSFER_ERROR",
					response: { stoppedSiblings: ["enc-2"] },
				}),
			]),
		).toBe("TRANSFER_ERROR");
	});

	it("takes the NEWEST observation (a retry that later finished wins)", () => {
		expect(
			lastKnownBitmovinStatus([
				entry({ status: "FAILED", error: "await:encoding ended ERROR" }),
				entry({ response: { status: "FINISHED" } }),
			]),
		).toBe("FINISHED");
	});

	it("reads START_ENCODING's crash-window resume probe", () => {
		expect(
			lastKnownBitmovinStatus([
				{
					step: "start",
					kind: "START_ENCODING",
					refs: { encodingId: "encoding" },
					status: "DONE",
					response: { started: true, resumed: true, status: "RUNNING" },
				},
			]),
		).toBe("RUNNING");
	});

	it("ignores manifest awaits (they observe a MANIFEST's status, not the encoding's)", () => {
		expect(
			lastKnownBitmovinStatus([
				{
					step: "manifest-await:hls",
					kind: "AWAIT_MANIFEST_HLS",
					refs: { manifestId: "manifest:hls" },
					status: "FAILED",
					error: "manifest-await:hls ended ERROR",
				},
			]),
		).toBeNull();
	});

	it("ignores a SIBLING encoding's await in a real LADDER", () => {
		// A Dolby ladder's sibling TRANSFER_ERROR must not enable a retry against
		// the row's own bitmovinEncodingId (which such plans do not even set).
		//
		// The fixture used to hold ONE `encoding:dv` entry and pass because the
		// scope was the literal id `"encoding"` — so it never tested a ladder at
		// all, and the same rule silently excluded ordinary single-encoding plans
		// that name their encoding explicitly (review catch). A ladder needs
		// siblings to BE a ladder.
		const log = [
			entry({
				step: "await:dv",
				refs: { encodingId: "encoding:dv" },
				status: "FAILED",
				error: "await:dv ended TRANSFER_ERROR",
			}),
			entry({
				step: "await:sdr",
				refs: { encodingId: "encoding:sdr" },
				response: { status: "FINISHED" },
			}),
		];
		expect(lastKnownBitmovinStatus(log)).toBeNull();
	});

	it("DOES speak for a single encoding that the plan named explicitly", () => {
		// `plan.encodings` has no `.min(2)`, so one explicit encoding compiles to
		// `encoding:<key>`. The old literal-id scope skipped it, which left
		// `bitmovinEncodingId` null and 409'd reprioritize and reschedule on an
		// ordinary job with an unambiguous encoding id.
		const log = [
			entry({
				step: "await:main",
				refs: { encodingId: "encoding:main" },
				status: "FAILED",
				error: "await:main ended TRANSFER_ERROR",
			}),
		];
		expect(lastKnownBitmovinStatus(log)).toBe("TRANSFER_ERROR");
	});

	it("returns UNKNOWN when the newest observation failed to parse", () => {
		// A poll that THROWS (Bitmovin 5xx/429, a network errno) writes error text
		// with no `ended X`. Walking further back returned START_ENCODING's resume
		// probe — constrained to QUEUED/RUNNING/FINISHED — so an encoding really in
		// TRANSFER_ERROR reported FINISHED and the UI told the operator so (review
		// catch). Stale-as-current is worse than "unknown".
		const log = [
			entry({
				step: "encoding",
				kind: "START_ENCODING",
				refs: { encodingId: "encoding" },
				response: { status: "FINISHED" },
			}),
			entry({
				step: "await:encoding",
				refs: { encodingId: "encoding" },
				status: "FAILED",
				error: "Bitmovin API error (502): upstream failure",
			}),
		];
		expect(lastKnownBitmovinStatus(log)).toBeNull();
	});

	it("ignores an unknown status token in the message", () => {
		expect(
			lastKnownBitmovinStatus([
				entry({ status: "FAILED", error: "await:encoding ended WAT_IS_THIS" }),
			]),
		).toBeNull();
	});

	it("survives entries a strict schema parse would reject", () => {
		// A single malformed sibling entry must not hide a TRANSFER_ERROR.
		expect(
			lastKnownBitmovinStatus([
				null,
				42,
				{ kind: "CREATE_STREAM", unexpectedExtraField: true },
				entry({
					status: "FAILED",
					error: "await:encoding ended TRANSFER_ERROR",
				}),
			]),
		).toBe("TRANSFER_ERROR");
	});
});
