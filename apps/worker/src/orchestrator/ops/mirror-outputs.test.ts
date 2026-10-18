import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type CompiledOperation,
	compileLiveChannel,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { ExecutorContext } from "../executor";
import { destinationOf, MissingRefError } from "./exec-shared";
import { outputs } from "./shared";

/**
 *  — the two halves of the mirror fan-out, tested at their seam:
 * `destinationOf` RESOLVES `refs.mirrorOutputIds` (fail-loud on a missing
 * ref, absent key stays absent), and `outputs` EXPANDS one EncodingOutput
 * per mirror at the SAME path and acl. Everything between the two is
 * signature-identical pass-through, which is the design.
 */

function op(refs: CompiledOperation["refs"]): CompiledOperation {
	return {
		step: "muxing:v",
		kind: "CREATE_MUXING_FMP4",
		payload: { outputPath: "out/video/720p", acl: "PUBLIC_READ" },
		refs,
	} as CompiledOperation;
}

function ctx(ids: Record<string, string>): ExecutorContext {
	return { ids: new Map(Object.entries(ids)) } as ExecutorContext;
}

describe("destinationOf mirror resolution (ledger #115)", () => {
	it("resolves mirrorOutputIds beside the primary", () => {
		const destination = destinationOf(
			op({
				outputId: "output:origin",
				mirrorOutputIds: ["output:m1", "output:m2"],
			}),
			ctx({
				"output:origin": "id-origin",
				"output:m1": "id-m1",
				"output:m2": "id-m2",
			}),
		);
		expect(destination).toMatchObject({
			outputId: "id-origin",
			outputPath: "out/video/720p",
			mirrorOutputIds: ["id-m1", "id-m2"],
		});
	});

	it("a plan without mirrors keeps the pre-#115 shape — no mirrors key at all", () => {
		const destination = destinationOf(
			op({ outputId: "output:origin" }),
			ctx({ "output:origin": "id-origin" }),
		);
		expect(destination).toBeDefined();
		expect(destination && "mirrorOutputIds" in destination).toBe(false);
	});

	it("an unresolvable mirror ref fails LOUD, not silently single-output", () => {
		expect(() =>
			destinationOf(
				op({ outputId: "output:origin", mirrorOutputIds: ["output:ghost"] }),
				ctx({ "output:origin": "id-origin" }),
			),
		).toThrow(MissingRefError);
	});
});

describe("outputs() mirror expansion (ledger #115)", () => {
	it.each([
		"origin",
		"mirror-1",
	])("serializes compiled Live root paths without erasing / or the MSL empty path (%s primary)", (primary) => {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					resolve(
						__dirname,
						"../../../../../packages/core/src/live/__fixtures__/live-akamai-msl-storage.plan.json",
					),
					"utf8",
				),
			),
		);
		const mirror = primary === "origin" ? "mirror-1" : "origin";
		plan.deliveryMirrors = [{ outputKey: mirror }];
		for (const manifest of plan.liveManifests)
			manifest.destination = {
				outputKey: primary,
				path: "",
				acl: "PUBLIC_READ",
			};
		const manifests = compileLiveChannel(plan).filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		);
		expect(manifests).toHaveLength(2);
		for (const manifest of manifests) {
			const wire = JSON.parse(
				JSON.stringify(
					outputs(
						destinationOf(
							manifest,
							ctx({
								"output:origin": "id-storage",
								"output:mirror-1": "id-msl",
							}),
						),
					),
				),
			);
			expect(wire).toEqual([
				{
					outputId: primary === "origin" ? "id-storage" : "id-msl",
					outputPath: primary === "origin" ? "/" : "",
					acl: [{ permission: "PUBLIC_READ" }],
				},
				{
					outputId: mirror === "origin" ? "id-storage" : "id-msl",
					outputPath: mirror === "origin" ? "/" : "",
					acl: [{ permission: "PUBLIC_READ" }],
				},
			]);
		}
	});

	it("expands primary + one EncodingOutput per mirror, same path and acl", () => {
		const result = outputs({
			outputId: "id-origin",
			outputPath: "out/video/720p",
			acl: "PUBLIC_READ",
			mirrorOutputIds: ["id-m1", "id-m2"],
		});
		expect(result).toHaveLength(3);
		expect(result?.map((o) => o.outputId)).toEqual([
			"id-origin",
			"id-m1",
			"id-m2",
		]);
		for (const entry of result ?? []) {
			expect(entry.outputPath).toBe("out/video/720p");
			expect(entry.acl?.[0]?.permission).toBe("PUBLIC_READ");
		}
	});

	it("no mirrors → exactly one output (the pre-#115 contract)", () => {
		const result = outputs({
			outputId: "id-origin",
			outputPath: "out/video/720p",
		});
		expect(result).toHaveLength(1);
	});
});

describe("per-mirror output paths (ledger #220 — an MSL mirror's manifest form)", () => {
	function manifestOp(
		payload: Record<string, unknown>,
		refs: CompiledOperation["refs"],
	): CompiledOperation {
		return {
			step: "manifest:hls",
			kind: "CREATE_MANIFEST_HLS",
			payload,
			refs,
		} as CompiledOperation;
	}
	const ids = ctx({
		"output:origin": "id-origin",
		"output:m1": "id-m1",
		"output:m2": "id-m2",
	});
	it("rides the payload aligned with the mirror refs and reaches the facade's EncodingOutput per mirror", () => {
		const destination = destinationOf(
			manifestOp(
				{
					outputPath: "output/x",
					mirrorOutputPaths: ["/output/x/", undefined],
				},
				{
					outputId: "output:origin",
					mirrorOutputIds: ["output:m1", "output:m2"],
				},
			),
			ids,
		);
		expect(destination?.mirrorOutputPaths).toEqual(["/output/x/", "output/x"]);
		const wire = outputs(destination) ?? [];
		expect(wire.map((o) => [o.outputId, o.outputPath])).toEqual([
			["id-origin", "output/x"],
			["id-m1", "/output/x/"],
			["id-m2", "output/x"],
		]);
	});
	it("absent, every mirror shares the primary's path (the #115 shape)", () => {
		const destination = destinationOf(
			manifestOp(
				{ outputPath: "output/x" },
				{ outputId: "output:origin", mirrorOutputIds: ["output:m1"] },
			),
			ids,
		);
		expect(destination).not.toHaveProperty("mirrorOutputPaths");
		expect((outputs(destination) ?? []).map((o) => o.outputPath)).toEqual([
			"output/x",
			"output/x",
		]);
	});
});
