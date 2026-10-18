import { describe, expect, it } from "vitest";
import { buildResourceTree, RESOURCE_GROUP_ORDER } from "./resource-tree";
import type { StepLogEntry } from "./steplog";

/**
 * The resource-tree parser groups stepLog entries by resource type and
 * cross-links each step's resolved refs back to the step that created that
 * Bitmovin id. These tests pin the grouping, the cross-linking, and the
 * "response unavailable" classification for a step that ran but crashed
 * before recording a response.
 */

function step(
	over: Partial<StepLogEntry> & Pick<StepLogEntry, "kind" | "step">,
): StepLogEntry {
	return {
		step: over.step,
		kind: over.kind,
		status: over.status ?? "DONE",
		payload: over.payload ?? {},
		refs: over.refs ?? {},
		resourceId: over.resourceId,
		request: over.request,
		response: over.response,
		error: over.error,
	};
}

const log: StepLogEntry[] = [
	step({ step: "input:main", kind: "CREATE_INPUT_S3", resourceId: "in-1" }),
	step({
		step: "output:origin",
		kind: "CREATE_OUTPUT_S3",
		resourceId: "out-1",
	}),
	step({
		step: "encoding",
		kind: "CREATE_ENCODING",
		resourceId: "enc-1",
		response: { id: "enc-1" },
	}),
	step({ step: "codec:v360", kind: "CREATE_CODEC_H264", resourceId: "cfg-1" }),
	step({
		step: "ingest:main",
		kind: "CREATE_INGEST_INPUT_STREAM",
		resourceId: "is-1",
		refs: { encodingId: "enc-1", inputId: "in-1" },
	}),
	step({
		step: "stream:v360",
		kind: "CREATE_STREAM",
		resourceId: "st-1",
		// Cross-links: codec + ingest input stream, both resolvable here.
		refs: {
			encodingId: "enc-1",
			codecConfigId: "cfg-1",
			inputStreamId: "is-1",
		},
	}),
	step({
		step: "muxing:v360",
		kind: "CREATE_MUXING_FMP4",
		resourceId: "mux-1",
		refs: { encodingId: "enc-1", streamId: "st-1", outputId: "out-1" },
	}),
	step({
		step: "await:encoding",
		kind: "AWAIT_ENCODING",
		refs: { encodingId: "enc-1" },
		response: { status: "FINISHED", progress: 100 },
	}),
];

describe("buildResourceTree — grouping", () => {
	it("groups steps by resource type in the canonical order", () => {
		const tree = buildResourceTree(log);
		const ids = tree.map((g) => g.id);
		// Canonical order is preserved and only non-empty groups appear.
		expect(ids).toEqual([
			"inputs",
			"outputs",
			"encoding",
			"codecs",
			"inputStreams",
			"streams",
			"muxings",
		]);
		// Order matches the declared canonical order (subset, in order).
		const order = RESOURCE_GROUP_ORDER.filter((id) => ids.includes(id));
		expect(ids).toEqual(order);
	});

	it("places the encoding lifecycle steps (CREATE + AWAIT) in the encoding group", () => {
		const tree = buildResourceTree(log);
		const encoding = tree.find((g) => g.id === "encoding");
		expect(encoding?.nodes.map((n) => n.kind)).toEqual([
			"CREATE_ENCODING",
			"AWAIT_ENCODING",
		]);
	});

	it("exposes the copyable resourceId on create nodes", () => {
		const tree = buildResourceTree(log);
		const inputs = tree.find((g) => g.id === "inputs");
		expect(inputs?.nodes[0]?.resourceId).toBe("in-1");
	});
});

describe("buildResourceTree — cross-linking", () => {
	it("resolves a stream's refs back to the steps that created them", () => {
		const tree = buildResourceTree(log);
		const streamNode = tree
			.find((g) => g.id === "streams")
			?.nodes.find((n) => n.step === "stream:v360");
		expect(streamNode).toBeDefined();
		const byKey = Object.fromEntries(
			(streamNode?.links ?? []).map((l) => [l.key, l]),
		);
		// codecConfigId → the H264 codec step
		expect(byKey.codecConfigId).toMatchObject({
			resourceId: "cfg-1",
			step: "codec:v360",
			kind: "CREATE_CODEC_H264",
		});
		// inputStreamId → the ingest step
		expect(byKey.inputStreamId).toMatchObject({
			resourceId: "is-1",
			step: "ingest:main",
			kind: "CREATE_INGEST_INPUT_STREAM",
		});
		// encodingId → the encoding step
		expect(byKey.encodingId).toMatchObject({
			resourceId: "enc-1",
			step: "encoding",
		});
	});

	it("leaves step/kind undefined for a ref whose producer is not in the log", () => {
		const tree = buildResourceTree([
			step({
				step: "stream:x",
				kind: "CREATE_STREAM",
				refs: { codecConfigId: "cfg-unknown" },
			}),
		]);
		const link = tree
			.find((g) => g.id === "streams")
			?.nodes[0]?.links.find((l) => l.key === "codecConfigId");
		expect(link).toMatchObject({ resourceId: "cfg-unknown" });
		expect(link?.step).toBeUndefined();
		expect(link?.kind).toBeUndefined();
	});

	it("expands array refs (e.g. vodHlsManifestIds) into one link per id", () => {
		const tree = buildResourceTree([
			step({
				step: "manifest:hls",
				kind: "CREATE_MANIFEST_HLS",
				resourceId: "m-1",
			}),
			step({
				step: "start",
				kind: "START_ENCODING",
				refs: { encodingId: "enc-1", vodHlsManifestIds: ["m-1", "m-2"] },
			}),
		]);
		const startLinks = tree
			.flatMap((g) => g.nodes)
			.find((n) => n.step === "start")?.links;
		const manifestLinks = (startLinks ?? []).filter(
			(l) => l.key === "vodHlsManifestIds",
		);
		expect(manifestLinks.map((l) => l.resourceId)).toEqual(["m-1", "m-2"]);
		// The resolvable one cross-links; the unknown one does not.
		expect(manifestLinks.find((l) => l.resourceId === "m-1")?.step).toBe(
			"manifest:hls",
		);
		expect(
			manifestLinks.find((l) => l.resourceId === "m-2")?.step,
		).toBeUndefined();
	});
});

describe("buildResourceTree — response availability", () => {
	it("flags a step that RAN but recorded no response as responseUnavailable", () => {
		const tree = buildResourceTree([
			step({
				step: "muxing:crashed",
				kind: "CREATE_MUXING_FMP4",
				status: "RUNNING",
				refs: { encodingId: "enc-1", streamId: "st-1" },
				response: undefined,
			}),
		]);
		const node = tree.find((g) => g.id === "muxings")?.nodes[0];
		expect(node?.responseUnavailable).toBe(true);
	});

	it("does NOT flag a PENDING (never-ran) step as responseUnavailable", () => {
		const tree = buildResourceTree([
			step({
				step: "muxing:pending",
				kind: "CREATE_MUXING_FMP4",
				status: "PENDING",
				response: undefined,
			}),
		]);
		const node = tree.find((g) => g.id === "muxings")?.nodes[0];
		expect(node?.responseUnavailable).toBe(false);
	});

	it("summarizes a status-bearing AWAIT response", () => {
		const tree = buildResourceTree(log);
		const awaitNode = tree
			.find((g) => g.id === "encoding")
			?.nodes.find((n) => n.kind === "AWAIT_ENCODING");
		expect(awaitNode?.responseSummary).toMatchObject({
			status: "FINISHED",
			progress: 100,
		});
		expect(awaitNode?.responseUnavailable).toBe(false);
	});
});
