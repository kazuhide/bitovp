import { providersForIoKind } from "../credentials/io-kind-providers";
import type { CredentialProviderId } from "../credentials/schemas";
import {
	type EncodingPlan,
	encodingPlanSchema,
	planInputSchema,
} from "./schema";
import { rebaseDestinations } from "./template-instantiate";

/**
 * Watch-folder plan instantiation  — pure.
 *
 * A rule's FULL_PLAN preset is the job TEMPLATE; this module turns it into
 * a submittable plan for one discovered object:
 *   1. the single input's bucket/credential become the rule's (the watched
 *      bucket IS the input), and every ingest path pointing at that input
 *      becomes the discovered key;
 *   2. every destination path is REBASED under the rendered
 *      outputPrefixTemplate — the preset's internal layout (video/360p …)
 *      survives beneath a per-object prefix, which is the hot-folder idiom;
 *   3. name = the object's basename; labels = rule labels + watch:<rule>.
 *
 * The exactly-one-input rule is checked HERE and at rule save (PR3's
 * validator calls watchTemplateIssues): a multi-input preset has no
 * unambiguous substitution target, and guessing would encode the wrong
 * source (design §4's "exactly one substitutable input").
 */

export type WatchTemplateIssue = {
	code:
		| "NOT_A_PLAN"
		| "INPUT_COUNT"
		| "NO_INGEST"
		| "SELF_INTERSECTION"
		| "INPUT_KIND"
		| "CREDENTIAL_PROVIDER";
	message: string;
};

/**
 * Directory-semantics form of a prefix: no leading slash, exactly one trailing
 * slash, and "" for the whole bucket. Without the trailing slash `"out"` would
 * prefix-match `"outtakes/"`, which is a different folder.
 */
function asDir(prefix: string): string {
	const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed === "" ? "" : `${trimmed}/`;
}

/**
 * The fixed head of a token template — everything before the first `{`.
 *
 * `outputPrefixTemplate` must carry `{basename}` or `{uuid}`, so its tail is
 * unknowable at save time. The head is not: every rendering of the template
 * starts with it, which is enough to decide overlap in both directions.
 */
function literalHead(template: string): string {
	const brace = template.indexOf("{");
	return asDir(brace === -1 ? template : template.slice(0, brace));
}

/**
 * Would this rule's OWN outputs land where it is watching?

 *
 * Nothing rejected a rule whose preset writes back into the watched
 * credential+bucket+prefix. The sweep enumerates that prefix recursively, so
 * the encoder's own outputs are discovered as new source objects, encoded, and
 * their outputs discovered in turn. `outputPrefixTemplate` requires a
 * uniquifying token, so each generation gets a FRESH prefix and nothing
 * overwrites — the loop does not converge, it multiplies, and every generation
 * is billable. `maxConcurrentJobs` bounds the rate, not the total.
 *
 * The check is deliberately conservative in both directions: an output head
 * under the watched prefix is an overlap, and a watched prefix under the output
 * head is one too, because the template's unknown tail can render into it
 * (rule prefix `out/x/`, template `out/{basename}/` → `out/x/…` is reachable).
 * An extension allowlist is NOT accepted as a defence: the common hot-folder
 * setup watches `mp4` and produces `mp4`.
 *
 * Outputs with no bucket/container of their own (SFTP, Akamai NetStorage — the
 * credential IS the location) match on credential alone; in practice a watch
 * rule's credential is an object-storage one, so that arm rarely fires.
 */
export function watchSelfIntersectionIssues(
	presetBody: unknown,
	rule: {
		credentialId: string;
		bucket: string;
		prefix: string;
		outputPrefixTemplate: string;
	},
): WatchTemplateIssue[] {
	const parsed = encodingPlanSchema.safeParse(presetBody);
	if (!parsed.success) {
		// NOT_A_PLAN is watchTemplateIssues' to report; do not double-report.
		return [];
	}
	const head = literalHead(rule.outputPrefixTemplate);
	const watched = asDir(rule.prefix);
	if (!(head.startsWith(watched) || watched.startsWith(head))) {
		return [];
	}
	const issues: WatchTemplateIssue[] = [];
	for (const output of parsed.data.outputs) {
		const bucket = (output as { bucket?: string }).bucket;
		const container = (output as { container?: string }).container;
		/**
		 * A GLOBAL bucket namespace makes the bucket NAME sufficient on its own.
		 *
		 * The first version also required `credentialId` equality, and review-299
		 * showed that leaves the loop wide open: S3, GCS and GenericS3 bucket
		 * names are globally unique, so the same name IS the same bucket whoever
		 * opens it — and two credential rows addressing one bucket is ordinary
		 * practice (a read-only scan credential plus a write credential, a key
		 * rotation, two IAM users). The test that shipped with it pinned the gap
		 * as INTENDED, reasoning "a different account"; there is no different
		 * account, only a different key to the same door.
		 *
		 * Azure `container` names are per-ACCOUNT, so there the credential is
		 * genuinely part of the identity and both must match. Kinds with neither
		 * (SFTP, Akamai NetStorage — the credential IS the location) match on
		 * credential alone.
		 */
		if (bucket !== undefined) {
			if (bucket !== rule.bucket) {
				continue;
			}
		} else if (container !== undefined) {
			if (
				container !== rule.bucket ||
				output.credentialId !== rule.credentialId
			) {
				continue;
			}
		} else if (output.credentialId !== rule.credentialId) {
			continue;
		}
		issues.push({
			code: "SELF_INTERSECTION",
			message: `Output "${output.key}" writes to the same storage this rule watches (${rule.bucket}/${watched || "<whole bucket>"}), so every encode's own output would be discovered as a new source and encoded again — an unbounded, billable loop. Point the preset's output at a different bucket or prefix.`,
		});
	}
	return issues;
}

/**
 * Can substitution actually TARGET this input kind?
 *
 * `instantiateWatchPlan` rebases the sole input by spreading `bucket` and
 * `credentialId` onto it. Three of the seven input kinds cannot receive that:
 * HTTPS has no credential and a `host`, AZURE keys its location as `container`,
 * and AKAMAI_NETSTORAGE has no bucket at all (the upload account IS the
 * container). The schema is `strictObject`, so those three produce an
 * unparseable plan — but only when an object arrives, AFTER the sweep has
 * claimed it, which is why the operator saw an ERROR with no reason at
 * folder-configuration time (audit AA972-WATCH-001).
 *
 * DERIVED from the schema rather than listed: a new input kind classifies
 * itself, and one whose shape changes reclassifies itself. A hand-written
 * allowlist here would be a second place to forget.
 */
export function isWatchSubstitutableInputKind(kind: string): boolean {
	return planInputSchema.safeParse({
		key: "probe",
		kind,
		credentialId: "00000000-0000-4000-8000-000000000000",
		bucket: "probe-bucket",
		name: "probe",
	}).success;
}

/** What a watch rule brings to the template, for the compatibility checks. */
export type WatchRuleBinding = {
	/**
	 * Provider of the rule's credential; omit when it cannot be resolved.
	 *
	 * Typed as the union rather than `string`: a caller typo ("AWS_s3") would
	 * otherwise be indistinguishable from a genuine mismatch and would
	 * manufacture a refusal.
	 */
	credentialProvider?: CredentialProviderId;
};

/** Structural pre-checks a preset must pass to serve as a watch template. */
export function watchTemplateIssues(
	presetBody: unknown,
	binding: WatchRuleBinding = {},
): WatchTemplateIssue[] {
	const parsed = encodingPlanSchema.safeParse(presetBody);
	if (!parsed.success) {
		return [
			{
				code: "NOT_A_PLAN",
				message: "Preset body is not a valid encoding plan",
			},
		];
	}
	const issues: WatchTemplateIssue[] = [];
	if (parsed.data.inputs.length !== 1) {
		issues.push({
			code: "INPUT_COUNT",
			message: `Watch templates need exactly ONE input (found ${parsed.data.inputs.length}) — substitution has no unambiguous target otherwise`,
		});
	}
	if (parsed.data.ingest.length === 0) {
		issues.push({
			code: "NO_INGEST",
			message: "Watch templates need at least one ingest stream",
		});
	}
	const soleInput =
		parsed.data.inputs.length === 1 ? parsed.data.inputs[0] : undefined;
	if (soleInput) {
		if (!isWatchSubstitutableInputKind(soleInput.kind)) {
			// The list is DERIVED, not written out. This function's own doc
			// argues a hand-written allowlist is a second place to forget, and
			// the first cut then hardcoded one in its error message. Also: "no
			// bucket to replace" was wrong for AZURE, which has a location —
			// keyed `container`, which is not the field substitution writes.
			const usable = planInputSchema.options
				.map((o) => o.shape.kind.value)
				.filter(isWatchSubstitutableInputKind);
			issues.push({
				code: "INPUT_KIND",
				message: `Watch templates cannot use an input of kind ${soleInput.kind} — substitution rewrites the input's \`bucket\` and \`credentialId\` per object, and this kind has no \`bucket\` field to rewrite. Use ${usable.join(", ")}`,
			});
		} else if (binding.credentialProvider !== undefined) {
			// Only when the caller RESOLVED a provider. An unknown capability
			// must not manufacture a refusal — the same rule the deployment
			// profile's provider half follows.
			// NOT `?? []`: core returns undefined for "I do not know this kind",
			// and coercing that to an empty list turns it into "no provider is
			// allowed" — manufacturing exactly the refusal the paragraph above
			// forbids. Unreachable today (all four substitutable kinds are in
			// the table) and it bites the moment a kind is added to the schema
			// but not the table, which is the case the doctrine exists for.
			const allowed = providersForIoKind(soleInput.kind);
			if (
				allowed !== undefined &&
				!allowed.includes(binding.credentialProvider)
			) {
				issues.push({
					code: "CREDENTIAL_PROVIDER",
					message: `A ${binding.credentialProvider} credential cannot back a ${soleInput.kind} input — the object would be claimed and then fail when the worker maps the credential. Expected ${allowed.join(" or ")}`,
				});
			}
		}
	}
	return issues;
}

/**
 * Lowercased extension of an object key ("" when none) — THE allowlist
 * comparison, shared by the sweep's scan and the re-arm route so the two
 * can never drift (review-87b C-2: a re-arm that recomputed extensions
 * differently laundered SKIPPED sidecar files into paid encodings).
 */
export function watchObjectExtension(key: string): string {
	const file = key.split("/").pop() ?? key;
	const dot = file.lastIndexOf(".");
	return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
}

const TEMPLATE_TOKEN = /\{(basename|ext|date|uuid|rule)\}/g;

/** Render {basename} {ext} {date} {uuid} {rule}; unknown tokens are LEFT. */
export function renderWatchOutputPrefix(
	template: string,
	ctx: {
		objectKey: string;
		ruleName: string;
		now: Date;
		uuid: string;
	},
): string {
	const file = ctx.objectKey.split("/").pop() ?? ctx.objectKey;
	const dot = file.lastIndexOf(".");
	const basename = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
	const date = ctx.now.toISOString().slice(0, 10);
	const values: Record<string, string> = {
		basename,
		ext,
		date,
		uuid: ctx.uuid,
		rule: ctx.ruleName,
	};
	return template
		.replace(TEMPLATE_TOKEN, (_, token: string) => values[token] ?? "")
		.replace(/\/{2,}/g, "/")
		.replace(/^\//, "")
		.replace(/\/$/, "");
}

export type InstantiateWatchPlanInput = {
	presetBody: unknown;
	objectKey: string;
	rule: {
		name: string;
		bucket: string;
		credentialId: string;
		outputPrefixTemplate: string;
		labels: string[];
		/**
		 * Provider of the rule's credential, when the caller can resolve it.
		 *
		 * The save routes always can, so this is the worker's BACKSTOP: without
		 * it the sweep re-checks the template but not the credential, and the
		 * save-time guard is then load-bearing on its own. It is safe today only
		 * because provider happens to be immutable in the credential routes —
		 * a property of a different module, which is the kind of coupling that
		 * quietly stops holding .
		 */
		credentialProvider?: CredentialProviderId;
	};
	now: Date;
	uuid: string;
};

export type InstantiateWatchPlanResult =
	| { ok: true; plan: EncodingPlan; outputPrefix: string }
	| { ok: false; issues: WatchTemplateIssue[] };

export function instantiateWatchPlan(
	input: InstantiateWatchPlanInput,
): InstantiateWatchPlanResult {
	const issues = watchTemplateIssues(input.presetBody, {
		credentialProvider: input.rule.credentialProvider,
	});
	if (issues.length > 0) {
		return { ok: false, issues };
	}
	const template = encodingPlanSchema.parse(input.presetBody);
	const soleInput = template.inputs[0];
	if (!soleInput) {
		// watchTemplateIssues guarantees one input; belt for the type.
		return {
			ok: false,
			issues: [{ code: "INPUT_COUNT", message: "No input" }],
		};
	}
	const outputPrefix = renderWatchOutputPrefix(
		input.rule.outputPrefixTemplate,
		{
			objectKey: input.objectKey,
			ruleName: input.rule.name,
			now: input.now,
			uuid: input.uuid,
		},
	);
	const file = input.objectKey.split("/").pop() ?? input.objectKey;
	const rebased = rebaseDestinations(
		template,
		outputPrefix,
	) as unknown as EncodingPlan;
	const candidate = {
		...rebased,
		name: file,
		bitmovin: {
			...rebased.bitmovin,
			// Encoding.labels (statistics grouping) AND — via the submit
			// pipeline's row copy — the jobs list's ?label= filter: the
			// design's "watch:<name> gives per-rule job views for free".
			labels: [
				...new Set([
					...(template.bitmovin.labels ?? []),
					...(input.rule.labels ?? []),
					`watch:${input.rule.name}`,
				]),
			],
		},
		inputs: [
			{
				...soleInput,
				bucket: input.rule.bucket,
				credentialId: input.rule.credentialId,
			},
		],
		ingest: template.ingest.map((stream) =>
			stream.inputKey === soleInput.key
				? { ...stream, inputPath: input.objectKey }
				: stream,
		),
	};
	// Re-parse: the instantiated plan must satisfy the SAME schema any
	// wizard-authored plan does — substitution cannot mint an unparseable
	// plan without failing loudly here.
	const parsed = encodingPlanSchema.safeParse(candidate);
	if (!parsed.success) {
		return {
			ok: false,
			issues: [
				{
					code: "NOT_A_PLAN",
					message: `Instantiated plan failed to parse: ${parsed.error.issues[0]?.message ?? "unknown"}`,
				},
			],
		};
	}
	return { ok: true, plan: parsed.data, outputPrefix };
}
