/** Reviewed impact groups for daily feedback; not a complete import graph. */
export const ALL_PROFILES = Object.freeze([
	"access-isolation",
	"submission-idempotency",
	"vod-timeline",
	"live-lifecycle",
	"library-render-recovery",
	"qc-resource-allocation",
	"qc-measurement-validity",
	"qc-runtime-safety",
]);
export const WORKFLOWS = Object.freeze([
	".github/workflows/ci.yml",
	".github/workflows/installed-gui.yml",
	".github/workflows/offline-media.yml",
	".github/workflows/upgrade-rehearsal.yml",
	".github/workflows/hierarchical-flow.yml",
	".github/workflows/pages.yml",
	".github/workflows/bombadil.yml",
]);
const qc = [
	"qc-resource-allocation",
	"qc-measurement-validity",
	"qc-runtime-safety",
];
export const RULES = Object.freeze(
	[
		{
			id: "shared",
			patterns: [
				/^packages\/(core|db|storage)\//,
				/^(scripts|tests|\.github|native|docker|install|deployment)\//,
				/(^|\/)(package\.json|[^/]*config\.[^/]+)$/,
				/(^|\/)(config|scripts|tests)\//,
				/^(pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|hierarchical-flow-fence\.json|Dockerfile|\.gitignore|\.dockerignore)$/,
				/^apps\/web\/src\/components\/ui\//,
			],
			profiles: ALL_PROFILES,
		},
		{
			id: "access",
			patterns: [
				/(^|\/)(auth|tenant|credentials)\//,
				/^apps\/web\/src\/(proxy|middleware)(\.|\/)/,
				/(^|\/)ingress[/.]/,
			],
			profiles: ["access-isolation"],
		},
		{
			id: "api-access",
			crosscutting: true,
			patterns: [/^apps\/web\/src\/app\/api\//],
			profiles: ["access-isolation"],
		},
		{
			id: "submission",
			patterns: [
				/\/app\/api\/(encoding-jobs|live-channels)\//,
				/(^|\/)create-request[/.]/,
				/^apps\/worker\/src\/orchestrator\//,
			],
			profiles: ["submission-idempotency"],
		},
		{
			id: "vod",
			patterns: [/(^|\/)(vod|vod-input|wizard|rendition)([-/.]|$)/],
			profiles: ["vod-timeline", "submission-idempotency"],
		},
		{
			id: "live",
			patterns: [/(^|\/)(live|aisa-live)([-/.]|$)/],
			profiles: ["live-lifecycle"],
		},
		{
			id: "operation-analytics",
			patterns: [
				/(^|\/)(operation-analytics|operation-attempts|operation-attempt-collector|moq-playback-run)([/.]|$)/,
			],
			profiles: ["access-isolation", "live-lifecycle"],
		},
		{
			id: "library",
			patterns: [/(^|\/)(library|content-editing|local-semantic)([-/.]|$)/],
			profiles: ["library-render-recovery"],
		},
		{
			id: "qc",
			patterns: [
				/(^|\/)(qc|vmaf|banding|cambi)([-/.]|$)/,
				/^apps\/worker\/src\/feeder\//,
			],
			profiles: qc,
		},
		{
			id: "qc-access",
			crosscutting: true,
			patterns: [/^apps\/web\/.*\/(qc|vmaf)([-/.]|$)/],
			profiles: ["access-isolation"],
		},
	].map((rule) =>
		Object.freeze({
			...rule,
			patterns: Object.freeze(rule.patterns),
			profiles: Object.freeze(rule.profiles),
		}),
	),
);

export function safePath(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!/^\//.test(path) &&
		!/[\\\r\n\0]/.test(path) &&
		!path.split("/").some((part) => !part || part === "." || part === "..")
	);
}
const documentation = (path) =>
	/^(README|CHANGELOG|CONTRIBUTING)\.md$/.test(path) ||
	/^(docs|tasks)\/.+\.md$/.test(path);
export function classifyPaths(changed, rules = RULES) {
	if (!Array.isArray(changed) || changed.some((path) => !safePath(path)))
		throw new Error("UNSAFE_CHANGE_PATH");
	const profiles = new Set();
	const paths = [...new Set(changed)].sort().map((path) => {
		if (documentation(path)) return { path, rules: ["documentation"] };
		const matches = rules.filter((rule) =>
			rule.patterns.some((pattern) => pattern.test(path)),
		);
		const matched = matches.map((rule) => rule.id).sort();
		for (const rule of matches)
			for (const id of rule.profiles) profiles.add(id);
		if (!matches.some((rule) => !rule.crosscutting)) {
			matched.push("unclassified");
			for (const id of ALL_PROFILES) profiles.add(id);
		}
		return { path, rules: matched };
	});
	const unclassified = paths
		.filter((entry) => entry.rules.includes("unclassified"))
		.map((entry) => entry.path);
	const classification = unclassified.length
		? "unclassified"
		: !profiles.size
			? "not-required"
			: paths.some((entry) => entry.rules.includes("shared"))
				? "broad"
				: "mapped";
	return {
		classification,
		paths,
		unclassified,
		profiles: [...profiles].sort(),
		reason: unclassified.length
			? "UNCLASSIFIED_CHANGE_FULL_CI_REQUIRED"
			: !paths.length
				? "NO_CHANGES"
				: !profiles.size
					? "DOCUMENTATION_ONLY"
					: classification === "broad"
						? "SHARED_CHANGE"
						: "MAPPED_CHANGE",
	};
}
