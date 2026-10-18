import { describe, expect, it } from "vitest";
import { type CompiledOperation, compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { planHasErrors, validatePlan } from "./validate";

/**
 * Mixed-codec DASH: the CHILDREN of a representation, not just the
 * representation.
 *
 * The compiler splits the implicit video adaptation set per codec, covered
 * by the `mixed-codec-dash-hls` golden — a plan with neither DRM nor
 * per-title. Two references were left pointing at the base `aset-video` step
 * that no longer exists for a mixed plan: the DASH
 * ContentProtection child and the run-time per-title expansion. Both compile
 * into a well-formed-looking op list whose `adaptationSetId` names a step
 * nothing creates, so the failure surfaces at RUN time as a dangling reference
 * rather than at compile time.
 *
 * The negative arm each test carries is the same fact stated the other way:
 * for a mixed-codec plan `manifest:dash:aset-video` IS NOT IN THE OP LIST. That
 * is what makes the old shape wrong rather than merely different, and it is why
 * these assertions cannot be satisfied by pointing everything at one set.
 */

const VIDEO_SET = /:aset-video/;

function setSteps(ops: CompiledOperation[]): string[] {
	return ops
		.filter(
			(o) =>
				o.kind === "CREATE_DASH_ADAPTATION_SET_VIDEO" ||
				o.kind === "CREATE_DASH_ADAPTATION_SET_AUDIO",
		)
		.map((o) => o.step);
}

/**
 * Every `adaptationSetId` any op cites resolves to an adaptation-set step in
 * the SAME op list.
 *
 * The golden suite's "only-backward references" check does this for the corpus;
 * this repeats it for the hand-built plans below, which have no fixture. Both
 * are needed: the corpus has no mixed-codec DRM or per-title plan to catch it
 * (censused — every per-title and every DRM fixture in
 * `packages/core/src/plan/__fixtures__` is single-codec), which is precisely why
 * the defect survived #204's own review.
 */
function assertAdaptationSetRefsResolve(ops: CompiledOperation[]): void {
	const created = new Set(setSteps(ops));
	for (const op of ops) {
		const target = op.refs.adaptationSetId;
		if (target === undefined) {
			continue;
		}
		// `refs` values are `string | string[]` (mirrorOutputIds is a list).
		// Flatten rather than cast, so every element has to resolve.
		for (const one of Array.isArray(target) ? target : [target]) {
			expect(
				created.has(one),
				`${op.step} (${op.kind}) references adaptation set ${one}, which no op creates — created: ${[...created].join(", ")}`,
			).toBe(true);
		}
	}
}

describe("mixed-codec DASH — ContentProtection children", () => {
	/**
	 * `mixed-codec-dash-hls` (#204's golden) plus CENC on every muxing, which
	 * is case 15's topology with the DRM the paid run did not exercise. CBC ⇒
	 * `IV_16_BYTES` (C9).
	 */
	function drmPlan() {
		const plan = loadPlan("mixed-codec-dash-hls");
		const drm = plan.muxings.map((m) => ({
			key: `${m.key}-cenc`,
			kind: "CENC" as const,
			muxingKey: m.key,
			credentialId: "00000000-0000-4000-8000-000000000005",
			kid: "43214321432143214321432143214321",
			encryptionMode: "CBC" as const,
			ivSize: "IV_16_BYTES" as const,
			widevine: {
				pssh: "CAESEAABAgMEBQYHCAkKCwwNDg8aCmludGVydHJ1c3QiASo=",
			},
			destination: {
				outputKey: "origin",
				path: `${m.destination?.path ?? ""}cenc/`,
				acl: "PUBLIC_READ" as const,
			},
			name: `${m.key} CENC`,
		}));
		return encodingPlanSchema.parse({
			...plan,
			drm,
			manifests: plan.manifests.map((m) =>
				m.kind === "DASH" ? { ...m, drmKind: "CENC" } : m,
			),
		});
	}

	it("puts each ContentProtection child under ITS OWN representation's codec set", () => {
		const ops = compilePlan(drmPlan());
		const cp = new Map(
			ops
				.filter((o) => o.kind === "CREATE_DASH_CONTENT_PROTECTION")
				.map((o) => [o.step, o.refs.adaptationSetId]),
		);
		// Five representations, five children — an empty map would satisfy
		// every per-entry assertion below.
		expect(cp.size).toBe(5);
		expect(cp.get("manifest:dash:rep:v1080-h265:cp")).toBe(
			"manifest:dash:aset-video-h265",
		);
		expect(cp.get("manifest:dash:rep:v720-h265:cp")).toBe(
			"manifest:dash:aset-video-h265",
		);
		expect(cp.get("manifest:dash:rep:v540:cp")).toBe(
			"manifest:dash:aset-video-h264",
		);
		expect(cp.get("manifest:dash:rep:v360:cp")).toBe(
			"manifest:dash:aset-video-h264",
		);
		expect(cp.get("manifest:dash:rep:a128:cp")).toBe(
			"manifest:dash:aset-audio",
		);
	});

	it("binds each child to the set its own representation joined — the relation, not two right answers", () => {
		// Presence is not association: both sets exist and both are cited, so
		// per-step equality alone would still pass if the two codecs' children
		// were SWAPPED. This asserts the join instead.
		const ops = compilePlan(drmPlan());
		const repSet = new Map(
			ops
				.filter((o) => o.kind.startsWith("CREATE_DASH_REPRESENTATION"))
				.map((o) => [o.step, o.refs.adaptationSetId]),
		);
		const children = ops.filter(
			(o) => o.kind === "CREATE_DASH_CONTENT_PROTECTION",
		);
		expect(children.length).toBeGreaterThan(0);
		for (const child of children) {
			const rep = child.refs.representationId;
			// Narrowed, not cast: a `refs` value is `string | string[]`, and a
			// child whose representationId arrived as a list would look up
			// `undefined` and then compare undefined-to-undefined — a green
			// assertion over nothing.
			expect(typeof rep, `${child.step} representationId`).toBe("string");
			const parentSet = typeof rep === "string" ? repSet.get(rep) : undefined;
			expect(parentSet, `${rep} has no representation op`).toBeDefined();
			expect(
				child.refs.adaptationSetId,
				`${child.step} sits in a different set from ${rep}`,
			).toBe(parentSet);
		}
	});

	it("creates ONLY the per-codec sets — the base `aset-video` is not in the op list", () => {
		// The negative arm. Referencing `manifest:dash:aset-video` was not a
		// stylistic choice that #204 left behind; the step does not exist.
		const ops = compilePlan(drmPlan());
		expect(setSteps(ops).filter((s) => VIDEO_SET.test(s))).toEqual([
			"manifest:dash:aset-video-h265",
			"manifest:dash:aset-video-h264",
		]);
		expect(ops.some((o) => o.step === "manifest:dash:aset-video")).toBe(false);
		assertAdaptationSetRefsResolve(ops);
	});

	it("a single-codec DRM plan is untouched — one `aset-video`, no suffix", () => {
		// The control. Every DRM golden in the corpus is single-codec, so this
		// is what the goldens already pin; asserted here so the pair is visible
		// together and a fix that suffixed unconditionally would be caught by
		// something that names the reason.
		const ops = compilePlan(loadPlan("cenc-cbc-drm-on-aws"));
		expect(setSteps(ops).filter((s) => VIDEO_SET.test(s))).toEqual([
			"manifest:dash:aset-video",
		]);
		assertAdaptationSetRefsResolve(ops);
	});
});

describe("mixed-codec DASH — per-title expansion", () => {
	/**
	 * Static H264 ladder + a PER-TITLE H265 template.
	 *
	 * This is the isolating shape, and it is why the fix had to widen the codec
	 * POPULATION rather than only repoint the reference: per-title renditions
	 * never enter `dashMuxings`, so a population derived from the static
	 * muxings alone reads "H264 only", declares the plan single-codec, and puts
	 * the per-title H265 results into the same `aset-video` as the static H264
	 * representations — the exact mixed set the provider refuses.
	 */
	function perTitlePlan() {
		const base = loadPlan("mixed-codec-dash-hls");
		const h265 = loadPlan("hdr10-pertitle");
		const template = h265.renditions.find((r) => r.key === "v-main10");
		const templateMuxing = h265.muxings.find((m) => m.key === "v-main10");
		if (!template || !templateMuxing) {
			throw new Error("hdr10-pertitle no longer carries v-main10");
		}
		return encodingPlanSchema.parse({
			...base,
			// PLAN_PER_TITLE_CONFIG_MISSING: the start request must carry the
			// template codec's per-title configuration.
			perTitle: h265.perTitle,
			renditions: [
				...base.renditions.filter((r) => !r.key.endsWith("-h265")),
				// The replacement template shares the fixture's explicit codec mode.
				{ ...template, encodingMode: "TWO_PASS" },
			],
			muxings: [
				...base.muxings.filter((m) => !m.key.endsWith("-h265")),
				{
					...templateMuxing,
					destination: {
						outputKey: "origin",
						// Under the manifest base path, and with the placeholders
						// C4 requires of a per-title path.
						path: "output/mixed-codec-dash-hls/video/{height}p_{bitrate}/",
						acl: "PUBLIC_READ",
					},
				},
			],
		});
	}

	it("the plan the app would accept — mixed static + per-title validates clean", () => {
		// A compiler assertion over a plan the validator rejects proves nothing
		// about anything shippable.
		expect(planHasErrors(validatePlan(perTitlePlan()))).toBe(false);
	});

	it("expands per-title results into the PER-TITLE codec's set, not the static one", () => {
		const ops = compilePlan(perTitlePlan());
		const expansion = ops.find(
			(o) => o.kind === "CREATE_DASH_PER_TITLE_REPRESENTATIONS",
		);
		expect(expansion).toBeDefined();
		expect(expansion?.refs.adaptationSetId).toBe(
			"manifest:dash:aset-video-h265",
		);
		// And the static H264 legs went the other way — otherwise "the right
		// set" could be satisfied by putting everything in one of them.
		const staticSets = new Set(
			ops
				.filter((o) => o.kind.startsWith("CREATE_DASH_REPRESENTATION"))
				.map((o) => o.refs.adaptationSetId),
		);
		expect(staticSets).toEqual(
			new Set(["manifest:dash:aset-video-h264", "manifest:dash:aset-audio"]),
		);
	});

	it("creates the per-title codec's set even though no static muxing carries it", () => {
		// The population widening, asserted directly: H265 has no static
		// representation in this plan, so the set exists ONLY because the
		// per-title template asked for it.
		const ops = compilePlan(perTitlePlan());
		expect(setSteps(ops).filter((s) => VIDEO_SET.test(s))).toEqual([
			"manifest:dash:aset-video-h264",
			"manifest:dash:aset-video-h265",
		]);
		expect(ops.some((o) => o.step === "manifest:dash:aset-video")).toBe(false);
		assertAdaptationSetRefsResolve(ops);
	});

	it("a single-codec per-title plan is untouched — one `aset-video`, no suffix", () => {
		// The control, and the reason every per-title golden stayed
		// byte-identical: one codec, one set, historical step id.
		const ops = compilePlan(loadPlan("hdr10-pertitle"));
		expect(setSteps(ops).filter((s) => VIDEO_SET.test(s))).toEqual([
			"manifest:dash:aset-video",
		]);
		expect(
			ops.find((o) => o.kind === "CREATE_DASH_PER_TITLE_REPRESENTATIONS")?.refs
				.adaptationSetId,
		).toBe("manifest:dash:aset-video");
		assertAdaptationSetRefsResolve(ops);
	});
});

describe("per-title video across two codecs has no compiled shape", () => {
	/**
	 * The expansion is ONE op naming ONE adaptation set and ONE encoding, and
	 * its server-side filters are muxing kind and stream mode — there is no
	 * codec filter. So this is not a reference the compiler can repoint: the
	 * validator refuses the plan instead.
	 */
	function twoPerTitleCodecs() {
		const h264 = loadPlan("pertitle-h264-openapi");
		const h265 = loadPlan("hdr10-pertitle");
		const template = h265.renditions.find((r) => r.key === "v-main10");
		const templateMuxing = h265.muxings.find((m) => m.key === "v-main10");
		if (!template || !templateMuxing) {
			throw new Error("hdr10-pertitle no longer carries v-main10");
		}
		return encodingPlanSchema.parse({
			...h264,
			generation: { ...h264.generation, encodingMode: "TWO_PASS" },
			renditions: [...h264.renditions, { ...template, key: "pt-h265" }],
			muxings: [
				...h264.muxings,
				{
					...templateMuxing,
					key: "pt-h265",
					streamKey: "pt-h265",
					destination: {
						outputKey: h264.muxings[0]?.destination?.outputKey ?? "origin",
						path: "output/two-per-title/{height}p_{bitrate}/",
						acl: "PUBLIC_READ",
					},
				},
			],
		});
	}

	it("is refused", () => {
		const codes = validatePlan(twoPerTitleCodecs()).map((i) => i.code);
		expect(codes).toContain("PLAN_DASH_PER_TITLE_MIXED_CODECS");
	});

	it("names both codecs, so the author knows which two collided", () => {
		const issue = validatePlan(twoPerTitleCodecs()).find(
			(i) => i.code === "PLAN_DASH_PER_TITLE_MIXED_CODECS",
		);
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("H264 + H265");
	});

	it("one per-title codec beside a STATIC second codec is allowed — that shape compiles", () => {
		// The boundary. The refusal is about the expansion op's single set, not
		// about mixed codecs, which #204 made expressible.
		const plan = loadPlan("mixed-codec-dash-hls");
		expect(validatePlan(plan).map((i) => i.code)).not.toContain(
			"PLAN_DASH_PER_TITLE_MIXED_CODECS",
		);
		expect(
			validatePlan(loadPlan("pertitle-h264-openapi")).map((i) => i.code),
		).not.toContain("PLAN_DASH_PER_TITLE_MIXED_CODECS");
	});
});
