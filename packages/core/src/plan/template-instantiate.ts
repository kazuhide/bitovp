import { mapDestinationPaths } from "./destinations";
import { type EncodingPlan, encodingPlanSchema } from "./schema";

/**
 * Template plan instantiation  — pure.
 *
 * The generalization of the watch-folder instantiation (#87): a saved
 * FULL_PLAN preset becomes a submittable plan for one manual launch, with
 * N sources substituted instead of watch's exactly-one. The launch form's
 * ask-list is DERIVED from the plan by `templateSourceSites` — never
 * authored — which is the design's central principle: parameter authoring
 * is where template systems go to die.
 *
 * What a SOURCE SITE is, measured from the schema rather than assumed:
 * every path-bearing stream carries `inputKey` plus one or two path
 * fields —
 *   - `ingest[]`             key + inputPath
 *   - `fileStreams[]`        key + inputPath           (WEBVTT sidecars)
 *   - `dolbyStreams[]` ATMOS/VISION_METADATA: key + inputPath;
 *     VISION: key + videoInputPath (+ optional metadataInputPath, which
 *     forms its own site `${key}:metadata`)
 * Trimming and concatenation streams reference OTHER streams (`sourceKey`)
 * and carry no paths — they are not sites. Across the 66 VOD goldens this
 * derivation yields 1–8 sites per plan (measured 2026-08-17).
 */

export type TemplateSourceSite = {
	/** Stable id for the params map: the stream key, or `${key}:metadata`. */
	siteId: string;
	/** The stream whose path this site substitutes. */
	streamKey: string;
	list: "ingest" | "fileStreams" | "dolbyStreams";
	/** Dolby discriminator when list === "dolbyStreams". */
	dolbyKind?: "ATMOS" | "VISION" | "VISION_METADATA";
	/** Which field on the stream holds this site's path. */
	field: "inputPath" | "videoInputPath" | "metadataInputPath";
	/** The input resource the stream reads from. */
	inputKey: string;
	/** The template's own path — the launch form's prefill. */
	currentPath: string;
	/** Multi-encoding plans (Dolby ladders): absent = the implicit encoding. */
	encodingKey?: string;
};

/** The launch form's ask-list, derived from the plan. Order is plan order. */
export function templateSourceSites(plan: EncodingPlan): TemplateSourceSite[] {
	const sites: TemplateSourceSite[] = [];
	for (const s of plan.ingest) {
		sites.push({
			siteId: s.key,
			streamKey: s.key,
			list: "ingest",
			field: "inputPath",
			inputKey: s.inputKey,
			currentPath: s.inputPath,
			...(s.encodingKey ? { encodingKey: s.encodingKey } : {}),
		});
	}
	for (const s of plan.fileStreams) {
		sites.push({
			siteId: s.key,
			streamKey: s.key,
			list: "fileStreams",
			field: "inputPath",
			inputKey: s.inputKey,
			currentPath: s.inputPath,
			...(s.encodingKey ? { encodingKey: s.encodingKey } : {}),
		});
	}
	for (const s of plan.dolbyStreams) {
		if (s.kind === "VISION") {
			sites.push({
				siteId: s.key,
				streamKey: s.key,
				list: "dolbyStreams",
				dolbyKind: "VISION",
				field: "videoInputPath",
				inputKey: s.inputKey,
				currentPath: s.videoInputPath,
				...(s.encodingKey ? { encodingKey: s.encodingKey } : {}),
			});
			if (s.metadataInputPath !== undefined) {
				sites.push({
					siteId: `${s.key}:metadata`,
					streamKey: s.key,
					list: "dolbyStreams",
					dolbyKind: "VISION",
					field: "metadataInputPath",
					inputKey: s.inputKey,
					currentPath: s.metadataInputPath,
					...(s.encodingKey ? { encodingKey: s.encodingKey } : {}),
				});
			}
		} else {
			sites.push({
				siteId: s.key,
				streamKey: s.key,
				list: "dolbyStreams",
				dolbyKind: s.kind,
				field: "inputPath",
				inputKey: s.inputKey,
				currentPath: s.inputPath,
				...(s.encodingKey ? { encodingKey: s.encodingKey } : {}),
			});
		}
	}
	return sites;
}

/**
 * One launch parameter. `objectKey` replaces the site's path; `bucket` +
 * `credentialId` (both together) move the site's INPUT resource.
 *
 * Input-move semantics, stated because they are the sharp edge: an input may
 * be shared by several sites. Every PROVIDED move for one input must agree
 * (disagreement is a named refusal) — but sites left unprovided do NOT block
 * a move: their paths are then read from the NEW storage, which is exactly
 * the watch-folder precedent (a sidecar file stream keeps its path and is
 * expected to exist in the watched bucket). The launch UI's job is to make
 * that visible; core's job is to make conflicts impossible and everything
 * else deterministic.
 */
export type TemplateSourceParam = {
	objectKey: string;
	bucket?: string;
	credentialId?: string;
};

export type TemplateInstantiateIssue = {
	code:
		| "NOT_A_PLAN"
		| "UNKNOWN_SITE"
		| "SHARED_INPUT_CONFLICT"
		/** bucket XOR credentialId — the two move an input TOGETHER (review-109pr1 I2: previously misfiled under SHARED_INPUT_CONFLICT). */
		| "INCOMPLETE_INPUT_MOVE"
		/** The site's input kind carries no bucket+credentialId pair (HTTPS, AZURE's container, …) — a move cannot apply (review-109pr1 I1: previously refused only by incidental strict-zod re-parse). */
		| "INPUT_KIND_NOT_MOVABLE"
		| "EMPTY_OUTPUT_PREFIX"
		| "REPARSE_FAILED";
	message: string;
};

const TEMPLATE_LAUNCH_TOKEN = /\{(basename|ext|date|uuid|template)\}/g;

/**
 * Render a launch output-prefix template. Tokens: {basename} {ext} (from the
 * first substituted source, or the first site's template path when nothing
 * was substituted), {date}, {uuid}, {template} (the template's name).
 * Unknown tokens are LEFT, matching the watch renderer's contract — the two
 * renderers deliberately share shape but not token sets ({rule} is watch's,
 * {template} is this one's; a watch rule using "{template}" keeps it
 * verbatim today and must go on doing so).
 */
export function renderTemplateOutputPrefix(
	template: string,
	ctx: {
		objectKey: string;
		templateName: string;
		now: Date;
		uuid: string;
	},
): string {
	const file = ctx.objectKey.split("/").pop() ?? ctx.objectKey;
	const dot = file.lastIndexOf(".");
	const basename = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
	const values: Record<string, string> = {
		basename,
		ext,
		date: ctx.now.toISOString().slice(0, 10),
		uuid: ctx.uuid,
		template: ctx.templateName,
	};
	return template
		.replace(TEMPLATE_LAUNCH_TOKEN, (_, token: string) => values[token] ?? "")
		.replace(/\/{2,}/g, "/")
		.replace(/^\//, "")
		.replace(/\/$/, "");
}

/**
 * Rebase every destination path in the plan under `prefix` — expressed over
 * the shared structural walk (`mapDestinationPaths`); see destinations.ts
 * for why there is exactly one walk in the tree.
 */
export function rebaseDestinations(node: unknown, prefix: string): unknown {
	return mapDestinationPaths(
		node,
		(path) => `${prefix}/${path.replace(/^\//, "")}`,
	);
}

export type InstantiateTemplatePlanInput = {
	presetBody: unknown;
	/** Site substitutions, keyed by `TemplateSourceSite.siteId`. Absent site ⇒ the template's own path (zero-edit re-run). */
	sources?: Record<string, TemplateSourceParam>;
	/** Token template for where THIS launch writes (see renderTemplateOutputPrefix). */
	outputPrefixTemplate: string;
	/** The launched job's name. */
	name: string;
	templateName: string;
	now: Date;
	uuid: string;
};

export type InstantiateTemplatePlanResult =
	| { ok: true; plan: EncodingPlan; outputPrefix: string }
	| { ok: false; issues: TemplateInstantiateIssue[] };

export function instantiateTemplatePlan(
	input: InstantiateTemplatePlanInput,
): InstantiateTemplatePlanResult {
	const parsed = encodingPlanSchema.safeParse(input.presetBody);
	if (!parsed.success) {
		return {
			ok: false,
			issues: [
				{
					code: "NOT_A_PLAN",
					message: "Template body is not a valid encoding plan",
				},
			],
		};
	}
	const template = parsed.data;
	const sites = templateSourceSites(template);
	const byId = new Map(sites.map((s) => [s.siteId, s]));
	const sources = input.sources ?? {};

	const issues: TemplateInstantiateIssue[] = [];
	for (const siteId of Object.keys(sources)) {
		if (!byId.has(siteId)) {
			issues.push({
				code: "UNKNOWN_SITE",
				message: `No source site "${siteId}" in this template — the ask-list is derived from the plan and this id is not on it`,
			});
		}
	}

	/**
	 * Input moves: collect the (bucket, credentialId) each PROVIDED source
	 * wants for its input; all providers of one input must agree.
	 */
	const inputMoves = new Map<
		string,
		{ bucket: string; credentialId: string; bySite: string }
	>();
	for (const [siteId, param] of Object.entries(sources)) {
		const site = byId.get(siteId);
		if (!site) {
			continue;
		}
		const hasBucket = param.bucket !== undefined;
		const hasCred = param.credentialId !== undefined;
		if (!hasBucket && !hasCred) {
			continue;
		}
		if (!hasBucket || !hasCred) {
			issues.push({
				code: "INCOMPLETE_INPUT_MOVE",
				message: `Site "${siteId}": bucket and credentialId move an input TOGETHER — provide both or neither`,
			});
			continue;
		}
		// I1: a move only applies to an input that CARRIES the pair being
		// moved — structural, so a future bucket-bearing kind is movable
		// without touching this list, and HTTPS/AZURE refuse by NAME instead
		// of by an incidental strict-zod re-parse failure.
		const targetInput = template.inputs.find((i) => i.key === site.inputKey);
		if (
			targetInput &&
			!("bucket" in targetInput && "credentialId" in targetInput)
		) {
			issues.push({
				code: "INPUT_KIND_NOT_MOVABLE",
				message: `Site "${siteId}": input "${site.inputKey}" (kind ${targetInput.kind}) has no bucket+credentialId pair — this input kind cannot be moved by a launch (edit the template instead)`,
			});
			continue;
		}
		const want = {
			bucket: param.bucket as string,
			credentialId: param.credentialId as string,
			bySite: siteId,
		};
		const existing = inputMoves.get(site.inputKey);
		if (
			existing &&
			(existing.bucket !== want.bucket ||
				existing.credentialId !== want.credentialId)
		) {
			issues.push({
				code: "SHARED_INPUT_CONFLICT",
				message: `Input "${site.inputKey}" is shared: site "${siteId}" wants ${want.bucket} while site "${existing.bySite}" wants ${existing.bucket} — sites sharing an input must agree on its storage`,
			});
			continue;
		}
		inputMoves.set(site.inputKey, existing ?? want);
	}
	if (issues.length > 0) {
		return { ok: false, issues };
	}

	/** The prefix tokens read the FIRST site's effective path. */
	const firstSite = sites[0];
	const firstEffective = firstSite
		? (sources[firstSite.siteId]?.objectKey ?? firstSite.currentPath)
		: "";
	const outputPrefix = renderTemplateOutputPrefix(input.outputPrefixTemplate, {
		objectKey: firstEffective,
		templateName: input.templateName,
		now: input.now,
		uuid: input.uuid,
	});
	if (outputPrefix === "") {
		return {
			ok: false,
			issues: [
				{
					code: "EMPTY_OUTPUT_PREFIX",
					message:
						"The output prefix rendered EMPTY — a launch writing at the template's own paths would overwrite the previous launch (the #87 rule); give the template a non-empty output prefix",
				},
			],
		};
	}

	const substitutePath = (
		streamKey: string,
		field: TemplateSourceSite["field"],
		current: string,
	): string => {
		const siteId =
			field === "metadataInputPath" ? `${streamKey}:metadata` : streamKey;
		return sources[siteId]?.objectKey ?? current;
	};

	const rebased = rebaseDestinations(
		template,
		outputPrefix,
	) as unknown as EncodingPlan;
	const candidate = {
		...rebased,
		name: input.name,
		inputs: rebased.inputs.map((inp) => {
			const move = inputMoves.get(inp.key);
			return move
				? { ...inp, bucket: move.bucket, credentialId: move.credentialId }
				: inp;
		}),
		ingest: rebased.ingest.map((s) => ({
			...s,
			inputPath: substitutePath(s.key, "inputPath", s.inputPath),
		})),
		fileStreams: rebased.fileStreams.map((s) => ({
			...s,
			inputPath: substitutePath(s.key, "inputPath", s.inputPath),
		})),
		dolbyStreams: rebased.dolbyStreams.map((s) =>
			s.kind === "VISION"
				? {
						...s,
						videoInputPath: substitutePath(
							s.key,
							"videoInputPath",
							s.videoInputPath,
						),
						...(s.metadataInputPath !== undefined
							? {
									metadataInputPath: substitutePath(
										s.key,
										"metadataInputPath",
										s.metadataInputPath,
									),
								}
							: {}),
					}
				: {
						...s,
						inputPath: substitutePath(s.key, "inputPath", s.inputPath),
					},
		),
	};

	// Re-parse: the instantiated plan must satisfy the SAME schema any
	// wizard-authored plan does — substitution cannot mint an unparseable
	// plan without failing loudly here (the watch precedent).
	const reparsed = encodingPlanSchema.safeParse(candidate);
	if (!reparsed.success) {
		return {
			ok: false,
			issues: [
				{
					code: "REPARSE_FAILED",
					message: `Instantiated plan failed to parse: ${reparsed.error.issues[0]?.message ?? "unknown"}`,
				},
			],
		};
	}
	return { ok: true, plan: reparsed.data, outputPrefix };
}
