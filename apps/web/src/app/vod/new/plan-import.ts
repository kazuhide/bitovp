import {
	compilePlan,
	encodingPlanSchema,
	providersForIoKind,
	validatePlan,
} from "@bitovp/core";
import { isPlaceholderCredentialId } from "@bitovp/core/wizard";
import type { Translator } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import type { PlanEvaluation } from "./plan-preview";

/**
 * Expert-mode plan import — the API-parity pressure valve: any EncodingPlan
 * JSON (e.g. a golden fixture, an exported preset, a hand-written plan)
 * becomes submittable without a form path for every field. The submission
 * payload is the IMPORTED object verbatim (the server re-parses); form
 * state is never round-tripped through it.
 */

export type ImportedPlan = {
	/** Exactly what was pasted (post-JSON.parse) — the submission payload. */
	raw: Record<string, unknown>;
	evaluation: PlanEvaluation;
};

export type ImportResult =
	| {
			ok: false;
			/**
			 * A message KEY — this is a module helper with no translator. Narrowed to
			 * the two it can produce, so the render site's `errorDetail` handling is
			 * checkable by the compiler rather than by inspection.
			 */
			errorKey: "wizardX.importNotValidJson" | "wizardX.importMustBeObject";
			/** Untranslated parser detail, spliced into the key when present. */
			errorDetail?: string | null;
	  }
	| { ok: true; imported: ImportedPlan };

export function parseImportedPlan(
	text: string,
	translate?: Translator,
): ImportResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			ok: false,
			errorKey: "wizardX.importNotValidJson",
			errorDetail: err instanceof Error ? err.message : null,
		};
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, errorKey: "wizardX.importMustBeObject" };
	}
	const parsed = encodingPlanSchema.safeParse(raw);
	if (!parsed.success) {
		// Surface the first few schema issues — one message is too little
		// for hand-edited plans, the full list is noise.
		const issues = parsed.error.issues
			.slice(0, 3)
			.map(
				(issue) =>
					`${issue.path.join(".")}: ${translate ? zodIssueMessage(issue, translate) : issue.message}`,
			)
			.join("; ");
		return {
			ok: true,
			imported: {
				raw: raw as Record<string, unknown>,
				evaluation: { ok: false, zodMessage: issues || "Plan is incomplete" },
			},
		};
	}
	const issues = validatePlan(parsed.data);
	const ops = issues.some((i) => i.level === "error")
		? []
		: compilePlan(parsed.data);
	return {
		ok: true,
		imported: {
			raw: raw as Record<string, unknown>,
			evaluation: {
				ok: true,
				plan: parsed.data,
				issues,
				opCount: ops.length,
				ops,
			},
		},
	};
}

/**
 * The SINGLE documented exception to verbatim submission: the target
 * Bitmovin account is an app-level concern (a vault id), not sample data —
 * golden plans carry none and the server 400s without one. A plan-supplied
 * accountId wins over the wizard selection. Parameter is structurally just
 * `{ raw }` so the live wizard's imports share this logic.
 */
/**
 * Both submission helpers now live in core, so the verification runner can submit through the
 * wizard's own code rather than posting fixture JSON. Re-exported here so this file's callers
 * and its tests are unchanged.
 */
export { buildSubmissionPlan, importedAccountId } from "@bitovp/core/wizard";

/* ------------------------------------------------------------------ *
 * Preset checklist helpers — pure inspections/edits over the RAW plan
 * (presets are golden fixtures: placeholder credential UUIDs, sample
 * buckets and <INSERT_*>/{YOUR *} paths must be swapped before a run).
 * Every edit returns a NEW raw object; callers re-run parseImportedPlan
 * so the evaluation rail stays the single source of truth.
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** A distinct credentialId in the plan + everywhere it is used. */
export type CredentialRef = {
	id: string;
	contexts: string[];
	/** Vault providers that can fill this ref (empty = unrestricted). */
	providers: string[];
};

/** Fixture vault ids are all-zero prefixed — flag them as placeholders. */
/**
 * Re-exported from core, where the wizard's plan-producing code now lives — `plan-to-wizard`
 * needs it and moved, and this file has a type-only dependency on a React component so it
 * could not follow.
 */
export { isPlaceholderCredentialId } from "@bitovp/core/wizard";

export function collectCredentialRefs(
	raw: Record<string, unknown>,
): CredentialRef[] {
	const refs = new Map<
		string,
		{ contexts: string[]; providers: Set<string> }
	>();
	const record = (entry: unknown, context: string, providers: string[]) => {
		if (!isRecord(entry) || typeof entry.credentialId !== "string") {
			return;
		}
		const id = entry.credentialId;
		const ref = refs.get(id) ?? { contexts: [], providers: new Set() };
		ref.contexts.push(context);
		for (const provider of providers) {
			ref.providers.add(provider);
		}
		refs.set(id, ref);
	};
	// Was: AZURE → AZURE_BLOB, SFTP → SFTP, EVERYTHING ELSE → AWS_S3. That sent
	// a GenericS3, GCS, NetStorage or MSL plan to an AWS picker (audit
	// AA972-IMPORT-001). The table lives in core so the picker and the
	// executor's own guards cannot drift apart.
	//
	// `?? []` deliberately FLATTENS core's undefined ("I don't know this kind")
	// into the picker's own empty-list meaning, which is "no filter — offer
	// everything". That is the right answer for an unknown kind here: a wrong
	// pick still fails closed at the executor's named provider guard before any
	// vendor call, whereas the old AWS_S3 default greyed out every credential
	// that could actually have worked. The distinction core preserves matters
	// to callers that must DECIDE something; this one only has to avoid
	// steering. (Reachable only via raw JSON before schema validation, since
	// `encodingPlanSchema` is a strict discriminated union.)
	const storageProviders = (kind: unknown): string[] => [
		...(providersForIoKind(kind) ?? []),
	];
	asArray(raw.inputs).forEach((entry, index) => {
		const kind = isRecord(entry) ? entry.kind : undefined;
		record(
			entry,
			`inputs[${index}] ${String(kind ?? "")}`,
			storageProviders(kind),
		);
	});
	asArray(raw.outputs).forEach((entry, index) => {
		const kind = isRecord(entry) ? entry.kind : undefined;
		record(
			entry,
			`outputs[${index}] ${String(kind ?? "")}`,
			storageProviders(kind),
		);
	});
	asArray(raw.drm).forEach((entry, index) => {
		const kind = isRecord(entry) ? entry.kind : undefined;
		// Match the executor: SPEKE resolves a key-provider credential, while
		// CENC and FairPlay both resolve a DRM_CENC content-key credential.
		record(entry, `drm[${index}] ${String(kind ?? "")}`, [
			kind === "SPEKE" ? "DRM_SPEKE" : "DRM_CENC",
		]);
	});
	asArray(raw.renditions).forEach((entry, index) => {
		if (isRecord(entry)) {
			record(entry.nexguard, `renditions[${index}] nexguard`, ["NEXGUARD"]);
		}
	});
	// Top-level, and so invisible to a collector that only walked the arrays —
	// a Kantar plan's placeholder credential passed the Start gate unnoticed
	// (audit AA972-IMPORT-001).
	record(raw.kantar, "kantar", ["KANTAR"]);
	return [...refs.entries()].map(([id, ref]) => ({
		id,
		contexts: ref.contexts,
		providers: [...ref.providers],
	}));
}

/** Replaces one credentialId everywhere it occurs (deep, immutable). */
export function replaceCredentialId(
	raw: Record<string, unknown>,
	from: string,
	to: string,
): Record<string, unknown> {
	const visit = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			return value.map(visit);
		}
		if (isRecord(value)) {
			const out: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(value)) {
				out[key] = key === "credentialId" && entry === from ? to : visit(entry);
			}
			return out;
		}
		return value;
	};
	return visit(raw) as Record<string, unknown>;
}

/**
 * Placeholder tokens the goldens carry instead of real object paths:
 * <INSERT…> (dolby mezzanines `<INSERT_*>`, deinterlace's
 * `<INSERT YOUR INPUT PATH>`), <REDACTED*> (test_-script clones) and
 * {YOUR *} (per-title samples). C4 path placeholders ({height}/{bitrate}/
 * {uuid}) are deliberately NOT matched — those must stay in the plan.
 */
const PLACEHOLDER_PATTERN = /<INSERT[^>]*>|<REDACTED[^>]*>|\{YOUR[^}]*\}/g;

export type PlaceholderRef = { token: string; paths: string[] };

export function collectPlaceholders(
	raw: Record<string, unknown>,
): PlaceholderRef[] {
	const found = new Map<string, string[]>();
	const visit = (value: unknown, path: string) => {
		if (typeof value === "string") {
			for (const token of value.match(PLACEHOLDER_PATTERN) ?? []) {
				const paths = found.get(token) ?? [];
				paths.push(path);
				found.set(token, paths);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const [index, entry] of value.entries()) {
				visit(entry, `${path}[${index}]`);
			}
			return;
		}
		if (isRecord(value)) {
			for (const [key, entry] of Object.entries(value)) {
				visit(entry, path === "" ? key : `${path}.${key}`);
			}
		}
	};
	visit(raw, "");
	return [...found.entries()].map(([token, paths]) => ({ token, paths }));
}

/** Replaces a placeholder token inside every string value (substring-safe). */
export function replacePlaceholder(
	raw: Record<string, unknown>,
	token: string,
	replacement: string,
): Record<string, unknown> {
	const visit = (value: unknown): unknown => {
		if (typeof value === "string") {
			return value.includes(token)
				? value.split(token).join(replacement)
				: value;
		}
		if (Array.isArray(value)) {
			return value.map(visit);
		}
		if (isRecord(value)) {
			const out: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(value)) {
				out[key] = visit(entry);
			}
			return out;
		}
		return value;
	};
	return visit(raw) as Record<string, unknown>;
}

/**
 * How many placeholder values an imported plan still carries: placeholder
 * credential ids (the all-zero fixture UUIDs) plus unresolved path tokens
 * (PLACEHOLDER_PATTERN — C4 run-time placeholders like {uuid}/{bitrate}
 * never count). The checklist badge and the wizard's Start gate both
 * derive from this single count so they can never disagree.
 */
export function countPendingPlaceholders(raw: Record<string, unknown>): number {
	const pendingCredentials = collectCredentialRefs(raw).filter((ref) =>
		isPlaceholderCredentialId(ref.id),
	);
	return pendingCredentials.length + collectPlaceholders(raw).length;
}

/** One storage resource row (inputs/outputs) for the checklist. */
export type StorageRef = {
	section: "inputs" | "outputs";
	index: number;
	key: string;
	kind: string;
	/** bucket / container / host — null for SFTP (host lives in the vault). */
	location: string | null;
};

export function listStorageRefs(raw: Record<string, unknown>): StorageRef[] {
	const rows: StorageRef[] = [];
	for (const section of ["inputs", "outputs"] as const) {
		asArray(raw[section]).forEach((entry, index) => {
			if (!isRecord(entry)) {
				return;
			}
			const kind = typeof entry.kind === "string" ? entry.kind : "";
			const location =
				kind === "AZURE"
					? entry.container
					: kind === "HTTPS"
						? entry.host
						: kind === "SFTP"
							? null
							: entry.bucket;
			rows.push({
				section,
				index,
				key: typeof entry.key === "string" ? entry.key : `#${index}`,
				kind,
				location: typeof location === "string" ? location : null,
			});
		});
	}
	return rows;
}

/** Sets the bucket/container/host of one inputs/outputs entry. */
export function withStorageLocation(
	raw: Record<string, unknown>,
	section: "inputs" | "outputs",
	index: number,
	location: string,
): Record<string, unknown> {
	const list = raw[section];
	if (!Array.isArray(list)) {
		return raw;
	}
	const next = list.map((entry, i) => {
		if (i !== index || !isRecord(entry)) {
			return entry;
		}
		const field =
			entry.kind === "AZURE"
				? "container"
				: entry.kind === "HTTPS"
					? "host"
					: entry.kind === "SFTP"
						? null
						: "bucket";
		return field === null ? entry : { ...entry, [field]: location };
	});
	return { ...raw, [section]: next };
}

/** Section counts for the read-only summary of an imported plan. */
export type PlanSectionSummary = { label: string; count: number; json: string };

export function summarizePlanSections(
	raw: Record<string, unknown>,
): PlanSectionSummary[] {
	const sections: [string, unknown][] = [
		["inputs", raw.inputs],
		["outputs", raw.outputs],
		["encodings", raw.encodings],
		["ingest", raw.ingest],
		["fileStreams", raw.fileStreams],
		["dolbyStreams", raw.dolbyStreams],
		["filters", raw.filters],
		["renditions", raw.renditions],
		["muxings", raw.muxings],
		["drm", raw.drm],
		["thumbnails", raw.thumbnails],
		["sprites", raw.sprites],
		["keyframes", raw.keyframes],
		["manifests", raw.manifests],
		["perTitle", raw.perTitle],
		["aiSceneAnalysis", raw.aiSceneAnalysis],
		["generation", raw.generation],
	];
	return sections.flatMap(([label, value]) => {
		if (value === undefined || value === null) {
			return [];
		}
		const count = Array.isArray(value) ? value.length : 1;
		if (count === 0) {
			return [];
		}
		return [{ label, count, json: JSON.stringify(value, null, 2) }];
	});
}
