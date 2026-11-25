import { objectInputFields } from "./object-input-path";

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

export function hasPrivateStorageLocator(
	value: string,
	objectKey = false,
): boolean {
	// Let the URL parser recognize absolute network locators, including its
	// specified normalization of leading C0 controls and embedded tab/CR/LF.
	// The caller always returns the original spelling of a public object key.
	if (URL.canParse(value)) {
		const url = new URL(value);
		if (url.host && (url.username || url.password || url.search || url.hash))
			return true;
	}
	const location = value.trim().replace(/[\t\r\n]/gu, "");
	const authority = /^(?:([a-z][a-z\d+.-]*):)?([/\\]{2,})([^/\\?#]*)/iu.exec(
		location,
	);
	if (authority) {
		const [, scheme, slashes, host] = authority;
		// Two separators introduce a network-path reference. Extra separators
		// without a scheme also occur in real S3 object keys (///reels@day).
		// Only explicit credentials identify that ambiguous spelling as private.
		if (
			(scheme || slashes?.length === 2 || /^[^@]*:[^@]*@/u.test(host ?? "")) &&
			(host?.includes("@") || /[?#].+/u.test(location))
		)
			return true;
	}
	if (objectKey) return false;
	// Historical Library rows lack the input provider. Parse only the query.
	// A typed Dolby/object key may legitimately contain "?version=2".
	const beforeFragment = location.split("#", 1)[0] ?? "";
	const queryStart = beforeFragment.indexOf("?");
	if (queryStart < 0) return false;
	const query = beforeFragment.slice(queryStart + 1);
	for (const [name, value] of new URLSearchParams(query)) {
		if (value.length === 0) continue;
		const field = name.replace(/[-_.]/gu, "").toLowerCase();
		if (
			/(token|credential|signature|password|secret)$|^(auth|authorization|hdnts|hdnea|hdntl|hmac|jwt|sig|key|apikey|accesskey|keypairid|policy|awsaccesskeyid|googleaccessid)$/u.test(
				field,
			)
		)
			return true;
		// An origin can rename an EdgeAuth parameter or carry a JWT in a
		// generic parameter. Their token formats identify them independently.
		if (
			/(?:^|~)hmac=[^~\s]+/iu.test(value) ||
			/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/u.test(value)
		)
			return true;
	}
	return false;
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
		hasPrivateStorageLocator(compact)
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

/** Job/preset routes have the actual plan. Library and audit records without it
 * retain the conservative path projection. */
export function publicVodSourceProjection<T>(
	row: T,
	plan: unknown,
	stepLog?: unknown,
): T {
	return publicHdrSourceProjection(
		row,
		"record",
		objectInputFields(plan, stepLog),
	);
}

/** Re-project historical JSON without altering the stored execution or its identifiers.
 * The old compiler could echo one locator into the plan, the log and an SDK diagnostic. */
export function publicHdrSourceProjection<T>(
	value: T,
	purpose: "record" | "draft" = "record",
	objectFields?: WeakSet<object>,
): T {
	const hidden = new Set<string>();
	const fields = new WeakMap<object, Map<string, string>>();
	let changed = false;
	function replace(row: object, key: string, replacement: string) {
		let values = fields.get(row);
		if (!values) {
			values = new Map();
			fields.set(row, values);
		}
		values.set(key, replacement);
		changed = true;
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
				else scan(item, hdr, libraryInputs, diagnostics);
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

			if (
				key === "inputPath" &&
				typeof item === "string" &&
				objectFields?.has(row) &&
				hasPrivateStorageLocator(item) &&
				!hasPrivateStorageLocator(item, true)
			) {
				// A separate historical step can have lost its proof and therefore
				// redact this same text. The plan's independently typed field survives.
				replace(row, key, item);
				continue;
			}
			if (
				typeof item === "string" &&
				item.trim().length &&
				((purpose === "record" &&
					key === "inputPath" &&
					hasPrivateStorageLocator(item)) ||
					(scope &&
						(key === "videoInputPath" || key === "metadataInputPath")) ||
					(key === "path" &&
						(row.hdr10Plus ||
							(libraryInputs && hasPrivateStorageLocator(item))))) &&
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
