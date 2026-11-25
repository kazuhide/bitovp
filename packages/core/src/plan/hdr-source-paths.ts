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

export type StoragePathKind = "OBJECT_KEY" | "HTTPS_PATH" | "UNKNOWN";

/** An unqualified path beginning with three slashes can be either a URL
 * authority or an object key. Only trusted storage provenance can choose the
 * latter. A control prefix or a backslash never qualifies for this exception. */
export function hasPrivateStorageLocator(
	value: string,
	kind: StoragePathKind = "UNKNOWN",
): boolean {
	const location = value
		.replace(/^[\s\p{Cc}]+|[\s\p{Cc}]+$/gu, "")
		.replace(/[\t\n\r]/gu, "");
	const literalObject =
		kind === "OBJECT_KEY" &&
		/^\/{3,}[^/]/u.test(value) &&
		!/[\\\p{Cc}]/u.test(value);
	const authority = /^(?:[a-z][a-z\d+.-]*:)?[/\\]{2,}([^/\\?#]*)/iu.exec(
		location,
	);
	if (!literalObject && (authority || uriScheme.test(location))) {
		try {
			const url = uriScheme.test(location)
				? new URL(location)
				: new URL(location, "https://storage.invalid");
			if (url.host && (url.username || url.password || url.search || url.hash))
				return true;
		} catch {
			// Incomplete authority fields still must not persist as public text.
		}
		if (authority && (authority[1]?.includes("@") || /[?#].+/u.test(location)))
			return true;
	}
	// An object store receives the bytes as a key. An HTTPS input resolves
	// the path against its host, which can assign any name to a signed query.
	if (kind === "OBJECT_KEY") return false;
	const fragment = location.indexOf("#");
	const path = fragment < 0 ? location : location.slice(0, fragment);
	return path.includes("?") || (kind === "HTTPS_PATH" && fragment >= 0);
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
	const compact = value.replace(/\s+/gu, "");
	return value.includes("@") ||
		(/[?].+/u.test(compact) && /[/\\.]|[?&][^=]+=/u.test(compact)) ||
		(uriScheme.test(compact) && hasPrivateStorageLocator(compact))
		? ("[withheld]" as T)
		: value;
}

/** Provider SDK task messages and our attributed slate event have the same diagnostic role. */
export function isProviderDiagnosticList(key: string) {
	return key === "messages" || key === "warnings" || key === "providerMessages";
}

export function isProviderDiagnosticText(key: string) {
	return [
		"message",
		"shortMessage",
		"developerMessage",
		"reason",
		"detail",
		"text",
	].includes(key);
}

/** Re-project historical JSON without altering the stored execution or its identifiers.
 * The old compiler could echo one locator into the plan, the log and an SDK diagnostic. */
export function publicHdrSourceProjection<T>(
	value: T,
	purpose: "record" | "draft" = "record",
	pathKinds?: WeakMap<object, StoragePathKind>,
): T {
	const hidden = new Set<string>();
	const fields = new WeakMap<object, Map<string, string>>();
	let changed = false;
	function replace(
		row: object,
		key: string,
		replacement: string,
		modified = true,
	) {
		let values = fields.get(row);
		if (!values) {
			values = new Map();
			fields.set(row, values);
		}
		values.set(key, replacement);
		if (modified) changed = true;
	}
	function mark(row: object, key: string, path: string) {
		replace(row, key, "");
		hidden.add(path);
	}
	function scan(
		input: unknown,
		hdr: boolean,
		libraryInputs = false,
		diagnostics: "response" | "list" | false = false,
		ingest = false,
	) {
		if (!input || typeof input !== "object" || input instanceof Date) return;
		if (Array.isArray(input)) {
			for (const [index, item] of input.entries()) {
				if (
					diagnostics === "list" &&
					typeof item === "string" &&
					publicStorageDiagnostic(item) !== item
				)
					replace(input, String(index), "[withheld]");
				else scan(item, hdr, libraryInputs, diagnostics, ingest);
			}
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
				purpose === "record" &&
				typeof item === "string" &&
				(key === "error" ||
					((scope || diagnostics) && isProviderDiagnosticText(key))) &&
				publicStorageDiagnostic(item) !== item
			) {
				replace(row, key, "[withheld]");
			}

			const mediaPath =
				key === "videoInputPath" ||
				key === "metadataInputPath" ||
				(ingest && key === "inputPath");
			if (
				!scope &&
				((libraryInputs && key === "path") || mediaPath) &&
				typeof item === "string" &&
				pathKinds?.get(row) === "OBJECT_KEY" &&
				!hasPrivateStorageLocator(item, "OBJECT_KEY")
			) {
				// An untrusted row elsewhere in the same snapshot can carry identical bytes.
				replace(row, key, item, false);
				continue;
			}
			if (
				!scope &&
				mediaPath &&
				typeof item === "string" &&
				hasPrivateStorageLocator(item, pathKinds?.get(row))
			) {
				// A projected plan is also used to verify genuine literal mask names.
				// A private authored name cannot become evidence for "[REDACTED]".
				replace(
					row,
					key,
					row.kind === "VISION" || (ingest && typeof row.inputKey === "string")
						? ""
						: "[REDACTED]",
				);
				hidden.add(item);
				continue;
			}
			if (
				typeof item === "string" &&
				item.trim().length &&
				((mediaPath && scope) ||
					(key === "path" &&
						(row.hdr10Plus ||
							(libraryInputs &&
								hasPrivateStorageLocator(item, pathKinds?.get(row)))))) &&
				!isHdr10PlusObjectPath(item)
			)
				mark(row, key, item);
			else if (typeof item === "object")
				scan(
					item,
					scope || key === "hdr10PlusStreams",
					row.kind === "VOD_JOB" && key === "inputs",
					purpose === "record" &&
						(isProviderDiagnosticList(key)
							? "list"
							: (key === "response" || diagnostics) && "response"),
					(key === "ingest" && Array.isArray(row.inputs)) ||
						((key === "payload" || key === "request" || key === "response") &&
							(row.kind === "CREATE_INGEST_INPUT_STREAM" ||
								(typeof row.path === "string" &&
									row.path.endsWith("/input-streams/ingest")))),
				);
		}
	}
	scan(value, false);
	if (!changed) return value;
	const locators = [...hidden]
		.filter(
			(path) =>
				hasPrivateStorageLocator(path) ||
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
		if (Array.isArray(input))
			return input.map(
				(item, index) => fields.get(input)?.get(String(index)) ?? project(item),
			);
		if (!input || typeof input !== "object" || input instanceof Date)
			return input;
		return Object.fromEntries(
			Object.entries(input).map(([key, item]) => [
				key,
				fields.get(input)?.get(key) ?? project(item),
			]),
		);
	}
	return project(value) as T;
}
