import type { Messages } from "@/lib/i18n";

/**
 *  — the customer-surface copy gate's ONE pattern registry (audit
 * 5c3d97ca §8.7 release gate + §14.6 UX-02e, HIGH-9).
 *
 * Two arms read it, and both must use THIS list rather than a copy:
 *
 *   - the catalogue arm scans every customer-facing value of BOTH catalogues
 *     (`customer-copy-gate.test.tsx`), with the explicit per-key allowlist
 *     below and nothing wider;
 *   - the render arm scans the DOM of the customer screens in JA and EN
 *     across their loading / empty / error / pending / unsupported / deleted
 *     states, because a literal that never entered the catalogue is invisible
 *     to the first arm (the class `untranslated-jsx-text.test.ts` documents).
 *
 * Not a `*.test.ts` file, so vitest does not collect it as a suite; it lives
 * beside the tests because nothing in production should import it.
 */
export type ForbiddenTerm = {
	readonly id: string;
	readonly pattern: RegExp;
	/** What the term is and why a customer must not meet it. */
	readonly why: string;
};

export const FORBIDDEN_CUSTOMER_TERMS: readonly ForbiddenTerm[] = [
	{
		id: "status-number",
		pattern: /STATUS #/,
		why: "internal work-log pointer",
	},
	{ id: "task-number", pattern: /\btask #/i, why: "task registry pointer" },
	{ id: "task-number-ja", pattern: /タスク #/, why: "task registry pointer" },
	{ id: "ledger", pattern: /\bledger\b/i, why: "internal work-log pointer" },
	{ id: "ledger-ja", pattern: /台帳/, why: "internal work-log pointer" },
	{ id: "readme", pattern: /\bREADME\b/, why: "repo document" },
	{
		id: "bitovp",
		pattern: /bitovp(?!-preset\.json)/i,
		why: "the repo's own name",
	},
	{ id: "live-channel", pattern: /live-channel/i, why: "worker / queue name" },
	{ id: "orchestrator", pattern: /orchestrator/i, why: "worker / queue name" },
	{ id: "orchestrator-ja", pattern: /オーケストレータ/, why: "worker name" },
	{ id: "worker", pattern: /\bworkers?\b/i, why: "process architecture" },
	{ id: "worker-ja", pattern: /ワーカー/, why: "process architecture" },
	{ id: "redis", pattern: /\bredis\b/i, why: "infrastructure dependency" },
	{ id: "broker", pattern: /\bbrokers?\b/i, why: "infrastructure dependency" },
	{ id: "sdk", pattern: /\bSDK\b/, why: "vendor client library" },
	{
		id: "sdk-object",
		pattern:
			/\b(?:EncodingPlan|StartEncodingRequest(?:\.[A-Za-z]+)?|PerTitle(?: blocks?| ブロック))\b/,
		why: "vendor request / plan object name",
	},
	{
		id: "openapi",
		// Case-sensitive on purpose: the prose spelling is the leak; the
		// kebab-case preset id `pertitle-h264-openapi` is a stable identifier
		//  that the gallery renders as-is.
		pattern: /OpenAPI/,
		why: "vendor API spec artefact",
	},
	{
		id: "raw-encoding-mode",
		pattern: /\b(?:SINGLE_PASS|TWO_PASS|THREE_PASS)\b/,
		why: "raw encoding-mode enum",
	},
	{ id: "ffmpeg", pattern: /ffmpeg/i, why: "tool the feeder / VMAF runs" },
	{ id: "pid", pattern: /\bPIDs?\b/, why: "process id" },
	{ id: "sigterm", pattern: /SIGTERM/, why: "process signal" },
	{ id: "sigkill", pattern: /SIGKILL/, why: "process signal" },
	{ id: "auth-mode", pattern: /AUTH_MODE/, why: "environment variable" },
	{ id: "stream-loop", pattern: /-stream_loop/, why: "ffmpeg CLI flag" },
	{ id: "seed-vmaf", pattern: /seed-vmaf/, why: "dev seed script" },
	{
		id: "python-sample",
		pattern: /encoding examples/,
		why: "reference project",
	},
	{
		id: "golden",
		pattern: /\bgolden\b|ゴールデン/i,
		why: "golden-test vocabulary",
	},
	{
		id: "fixture",
		pattern: /\bfixtures?\b|フィクスチャ/i,
		why: "test-fixture vocabulary",
	},
	{ id: "roadmap-ja", pattern: /今後対応/, why: "roadmap promise" },
	{
		id: "admin-diagnostics",
		pattern: /Administrator diagnostics|管理者向け診断/i,
		why: "developer-facing diagnostics label",
	},
	{
		id: "internal-implementation",
		pattern: /Internal implementation|内部の実装状況/i,
		why: "internal implementation status",
	},
	{
		id: "release-evidence",
		pattern: /release evidence|リリース前に実行した.*(?:証跡|検証)/i,
		why: "release-process vocabulary",
	},
	{
		id: "endpoint-implementation",
		pattern:
			/implementation state per endpoint|エンドポイント\/パラメータ単位の実装状況/i,
		why: "implementation census vocabulary",
	},
	{
		id: "phase-badge",
		pattern: /\bP(?:[0-9]|1[0-2])\b/,
		why: "P0–P12 roadmap phase badges. Percentiles (P50/P90) do not match; the Dolby Vision profile titles (DV P5 / DV P8.1) are codec profile names and are allowlisted BY KEY below",
	},
	{
		id: "constraint-code",
		// C36 joined the register with the slate preflight (rev406 R3 caught the
		// pattern still stopping at C35 while this line already said C36).
		// C37 (WP-G G-3, the account-level heartbeat webhook) extends the span.
		pattern: /\bC(?:[1-9]|[12][0-9]|3[0-7])\b/,
		why: "COVERAGE §0 constraint codes C1–C37 — say the constraint in words",
	},
	{
		id: "issue-number",
		pattern: /\(#\d+\)|#\d{2,3}\b/,
		why: "issue / ledger-row numbers",
	},
];

export type AllowlistEntry = {
	/** Dotted catalogue key — explicit, never a prefix or a pattern. */
	readonly key: string;
	/** The ONLY term ids this key may hit; any other term still fails it. */
	readonly terms: readonly string[];
	/** The engineering-only catalogue or codec profile that earns it. */
	readonly surface: string;
};

const DOLBY_VISION_PROFILE_TITLES = [
	"presetGallery.dolby-dv-3ladder-profile5-dash-ondemand.title",
	"presetGallery.dolby-dv-hdr10-sdr-2ladder-profile81.title",
	"presetGallery.dolby-dv-hdr10-sdr-2ladder-profile81-test.title",
	"presetGallery.dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs.title",
	"presetGallery.dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs-test.title",
	"presetGallery.dolby-dv-hdr10-sdr-3ladder-profile5-single-input.title",
	"presetGallery.dolby-dv-hdr10-sdr-3ladder-profile5-single-input-test.title",
] as const;

/* Allow specific profile-name keys only; internal evidence copy must not appear on operator-facing surfaces. */
export const CATALOGUE_ALLOWLIST: readonly AllowlistEntry[] = [
	...DOLBY_VISION_PROFILE_TITLES.map((key) => ({
		key,
		terms: ["phase-badge"],
		surface:
			"Dolby Vision Profile 5 / Profile 8.1 — the codec profile the preset encodes, not a roadmap phase",
	})),
	// Settings explicitly exposes the Encoding-API census as a diagnostic.
	// SDK is the measurement's subject, not incidental implementation jargon.
	{
		key: "apiCoverage.staleWarning",
		terms: ["sdk"],
		surface: "Settings API coverage — measured SDK provenance",
	},
	{
		key: "apiCoverage.sdkVersion",
		terms: ["sdk"],
		surface: "Settings API coverage — measured SDK provenance",
	},
	{
		key: "apiCoverage.searchPlaceholder",
		terms: ["sdk"],
		surface: "Settings API coverage — searchable SDK methods",
	},
	...[
		"apiCoverage.currentNotice",
		"apiCoverage.currentProvenance",
		"apiCoverage.sdkMatches",
		"apiCoverage.sdkMethod",
		"apiCoverage.parameterProvenance",
		"apiCoverage.surveyedAgainst",
	].map((key) => ({
		key,
		terms: ["sdk"],
		surface:
			"Settings API coverage — measured SDK provenance and method identity",
	})),
	{
		key: "settingsBuild.scope",
		terms: ["worker"],
		surface:
			"Settings build identity — explicitly excludes the worker and other Web instances",
	},
];

export type Hit = { readonly id: string; readonly match: string };

/** Every forbidden term `text` contains, minus the ids in `allowed`. */
export function findForbiddenTerms(
	text: string,
	allowed: ReadonlySet<string> = new Set(),
): Hit[] {
	const hits: Hit[] = [];
	for (const term of FORBIDDEN_CUSTOMER_TERMS) {
		if (allowed.has(term.id)) {
			continue;
		}
		const match = term.pattern.exec(text);
		if (match) {
			hits.push({ id: term.id, match: match[0] });
		}
	}
	return hits;
}

/** Dotted key → string value, for every leaf of a catalogue. */
export function catalogueLeaves(
	node: unknown,
	prefix = "",
): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "string") {
			out.set(path, value);
		} else {
			for (const [k, v] of catalogueLeaves(value, path)) {
				out.set(k, v);
			}
		}
	}
	return out;
}

export type CatalogueHit = Hit & {
	readonly key: string;
	readonly value: string;
};

/** The catalogue arm: every leaf value, allowlist applied BY KEY. */
export function scanCatalogue(messages: Messages): CatalogueHit[] {
	const allowByKey = new Map(
		CATALOGUE_ALLOWLIST.map((entry) => [entry.key, new Set(entry.terms)]),
	);
	const hits: CatalogueHit[] = [];
	for (const [key, value] of catalogueLeaves(messages)) {
		for (const hit of findForbiddenTerms(value, allowByKey.get(key))) {
			hits.push({ ...hit, key, value });
		}
	}
	return hits;
}

/**
 * The render arm's text: visible text plus the attributes that carry copy
 * (accessible names, tooltips, placeholders, alt text). Class names, hrefs and
 * data attributes are not copy and would only manufacture false hits.
 */
export function customerVisibleText(container: ParentNode): string {
	const parts: string[] = [container.textContent ?? ""];
	for (const element of container.querySelectorAll("*")) {
		for (const name of ["aria-label", "title", "placeholder", "alt"]) {
			const value = element.getAttribute(name);
			if (value) {
				parts.push(value);
			}
		}
	}
	return parts.join("\n");
}

/**
 * The render arm: the DOM's copy, with the allowlisted catalogue VALUES
 * removed first (a Dolby Vision title rendered on the presets page is the same
 * allowlist entry the catalogue arm honours, applied to the same string) —
 * never a pattern-wide exemption.
 */
export function scanDom(container: ParentNode, messages: Messages): Hit[] {
	const leaves = catalogueLeaves(messages);
	let text = customerVisibleText(container);
	for (const entry of CATALOGUE_ALLOWLIST) {
		const value = leaves.get(entry.key);
		if (value !== undefined) {
			text = text.split(value).join(" ");
		}
	}
	return findForbiddenTerms(text);
}
