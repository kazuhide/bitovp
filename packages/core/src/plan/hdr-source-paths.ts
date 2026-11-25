const uriScheme = /^[a-z][a-z\d+.-]*:/i;

/** HDR10+ expects an object path on its selected input, not a separate location. */
export function isHdr10PlusObjectPath(value: string) {
	const path = value.trim();
	return (
		path.length > 0 &&
		!uriScheme.test(path) &&
		!path.startsWith("//") &&
		!/[\\?#]/u.test(value) &&
		!Array.from(value).some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		) &&
		!/^[^/\s]*:[^/\s]*@/u.test(path)
	);
}

export const isHdr10PlusAuditPath = (path: unknown) =>
	typeof path === "string" && /\/input-streams\/hdr10-plus(?:\/|$)/.test(path);

function hasPrivateLocator(value: string): boolean {
	// A fragment in a relative object key is ordinary storage data. Query
	// parameters and URL authorities, including normalized HTTP authorities,
	// can contain credentials in old snapshots that lack a typed source marker.
	return (
		(value.includes("@") &&
			(/[a-z][a-z\d+.-]*:/i.test(value) ||
				/[/\\]{2}|^[^/\s]*:[^/\s]*@/u.test(value))) ||
		(/[?][^\s]+/.test(value) && /[/\\.]|[?&][^=]+=/u.test(value)) ||
		(uriScheme.test(value) && value.includes("#"))
	);
}

/** Provider diagnostics can echo signed input locators even in list responses without a plan. */
export function publicStorageDiagnostic<T extends string | null | undefined>(
	value: T,
): T {
	if (typeof value !== "string") return value;
	// A diagnostic is opaque provider prose. Quoting, punctuation and line
	// breaks may appear within a locator. Withhold the complete message if it
	// contains a potential storage credential.
	// Any unescaped userinfo contains an at-sign. The original URL may span
	// whitespace or punctuation in a provider's formatted error.
	return value.includes("@") || hasPrivateLocator(value)
		? ("[withheld]" as T)
		: value;
}

/** Re-project historical JSON without altering the stored execution or its identifiers.
 * The old compiler could echo one locator into the plan, the log and an SDK diagnostic. */
export function publicHdrSourceProjection<T>(
	value: T,
	purpose: "record" | "draft" = "record",
): T {
	const hidden = new Set<string>();
	const fields = new WeakMap<object, Set<string>>();
	function mark(row: Record<string, unknown>, key: string, path: string) {
		let names = fields.get(row);
		if (!names) {
			names = new Set();
			fields.set(row, names);
		}
		names.add(key);
		hidden.add(path);
	}
	function scan(input: unknown, hdr: boolean, libraryInputs = false) {
		if (!input || typeof input !== "object" || input instanceof Date) return;
		if (Array.isArray(input)) {
			for (const item of input) scan(item, hdr, libraryInputs);
			return;
		}
		const row = input as Record<string, unknown>;
		// Wizard drafts bind the HDR picture by file-row key, not by an inline path.
		const sources = row.sources as { hdr10PlusStreams?: unknown } | undefined;
		if (
			Array.isArray(row.inputFiles) &&
			Array.isArray(sources?.hdr10PlusStreams)
		) {
			const selected = new Set(
				sources.hdr10PlusStreams
					.map((stream) => stream?.videoInputFile)
					.filter((key) => typeof key === "string"),
			);
			for (const file of row.inputFiles) {
				if (
					selected.has(file?.key) &&
					typeof file.path === "string" &&
					file.path.trim() &&
					!isHdr10PlusObjectPath(file.path)
				)
					mark(file, "path", file.path);
			}
		}
		const scope =
			hdr ||
			row.kind === "CREATE_HDR10_PLUS_INPUT_STREAM" ||
			row.type === "HDR10_PLUS" ||
			isHdr10PlusAuditPath(row.path);
		for (const [key, item] of Object.entries(row)) {
			if (
				typeof item === "string" &&
				item.trim().length &&
				((scope && (key === "videoInputPath" || key === "metadataInputPath")) ||
					(key === "path" &&
						(row.hdr10Plus || (libraryInputs && hasPrivateLocator(item))))) &&
				!isHdr10PlusObjectPath(item)
			)
				mark(row, key, item);
			else if (typeof item === "object")
				scan(
					item,
					scope || key === "hdr10PlusStreams",
					row.kind === "VOD_JOB" && key === "inputs",
				);
		}
	}
	scan(value, false);
	if (!hidden.size) return value;
	const locators = [...hidden]
		.filter(
			(path) =>
				hasPrivateLocator(path) ||
				(purpose === "record" &&
					/^(?:https?|s?ftp|s3|gs|azure):[/\\]+.+|^(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}.+|^[^?#]+[?#].+/i.test(
						path.trim(),
					)),
		)
		.sort((a, b) => b.length - a.length);
	function project(input: unknown): unknown {
		if (typeof input === "string") {
			if (locators.includes(input)) return "";
			let result = input;
			for (const path of locators)
				if (result.includes(path))
					result = result.replaceAll(path, "[withheld]");
			return result;
		}
		if (Array.isArray(input)) return input.map(project);
		if (!input || typeof input !== "object" || input instanceof Date)
			return input;
		return Object.fromEntries(
			Object.entries(input).map(([key, item]) => [
				key,
				fields.get(input)?.has(key) ? "" : project(item),
			]),
		);
	}
	return project(value) as T;
}
