/**
 * Output base-path helpers shared by the VOD and Live wizards.
 *
 * The user enters a *folder*; the effective base output path namespaces it by
 * the job/channel name from step 1 — `folder + "/" + name`. We store the joined
 * result in `output.basePath` (the single value the plan compiler emits and the
 * round-trip reads back verbatim), so this is pure wizard-level sugar: it never
 * touches buildPlan, and a byte-for-byte round-trip is unaffected. `splitOutputFolder`
 * is the display inverse used to show the folder for editing.
 */

/**
 * Join a user folder and the job/channel name into a base output path, trimming
 * stray slashes. Empty name → just the folder; empty folder → just the name.
 */
export function joinOutputName(folder: string, name: string): string {
	const f = folder.replace(/\/+$/, "");
	const n = name.replace(/^\/+|\/+$/g, "");
	if (!n) {
		return f;
	}
	if (!f) {
		return n;
	}
	return `${f}/${n}`;
}

/**
 * Display inverse of joinOutputName (also accepts plan-generated trailing slashes): when `base` is exactly `${folder}/${name}`
 * (or equals `name` with an empty folder), return the folder so the wizard can
 * show it for editing. Returns null when `base` does NOT follow the name-suffix
 * pattern (an imported/hand-set path) — callers then show `base` as-is and only
 * re-append the name once the user actively edits the folder.
 */
export function splitOutputFolder(base: string, name: string): string | null {
	const n = name.replace(/^\/+|\/+$/g, "");
	if (!n) {
		return base;
	}
	const normalizedBase = base.replace(/\/+$/, "");
	if (normalizedBase === n) {
		return "";
	}
	const suffix = `/${n}`;
	return normalizedBase.endsWith(suffix)
		? normalizedBase.slice(0, -suffix.length)
		: null;
}

/**
 * Re-namespace an existing base path when the job/channel name changes (step 1).
 * Only rewrites when the current base still follows the `folder/oldName` pattern;
 * a hand-set/divergent base is left untouched so we never clobber the user.
 */
export function renameOutputBase(
	base: string,
	oldName: string,
	newName: string,
): string {
	const folder = splitOutputFolder(base, oldName);
	if (folder === null) return base;
	const renamed = joinOutputName(folder, newName);
	return renamed + (base.match(/\/+$/)?.[0] ?? "");
}
