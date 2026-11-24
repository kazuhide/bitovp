/** HDR10+ expects an object path on its selected input, not a separate location. */
export function isHdr10PlusObjectPath(value: string) {
	const path = value.trim();
	return (
		path.length > 0 &&
		!/^[a-z][a-z0-9+.-]*:\/\/|^[/\\]{2}|^[^/\s]*:[^/\s]*@|[?#]/i.test(path)
	);
}

export const isHdr10PlusAuditPath = (path: unknown) =>
	typeof path === "string" && /\/input-streams\/hdr10-plus(?:\/|$)/.test(path);

function hasPrivateLocator(value: string): boolean {
	return (
		/(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}[^/\\\s]*@|^[^/\s]*:[^/\s]*@/i.test(
			value,
		) ||
		(/[?#][^\s]+/.test(value) && /[/\\.]|[?&][^=]+=/u.test(value))
	);
}

/** Provider diagnostics can echo signed input locators even in list responses without a plan. */
export function publicStorageDiagnostic<T extends string | null | undefined>(
	value: T,
): T {
	if (typeof value !== "string") return value;
	return value.replace(/[^\s"'<>]+/g, (token) =>
		hasPrivateLocator(token) ? "[withheld]" : token,
	) as T;
}

/** Re-project historical JSON without altering the stored execution or its identifiers.
 * The old compiler could echo one locator into the plan, the log and an SDK diagnostic. */
export function publicHdrSourceProjection<T>(value: T): T {
	const hidden = new Set<string>();
	function scan(input: unknown, hdr: boolean, libraryInputs = false) {
		if (!input || typeof input !== "object" || input instanceof Date) return;
		if (Array.isArray(input)) {
			for (const item of input) scan(item, hdr, libraryInputs);
			return;
		}
		const row = input as Record<string, unknown>;
		const scope =
			hdr ||
			row.kind === "CREATE_HDR10_PLUS_INPUT_STREAM" ||
			row.type === "HDR10_PLUS" ||
			isHdr10PlusAuditPath(row.path);
		for (const [key, item] of Object.entries(row)) {
			if (
				typeof item === "string" &&
				item.length &&
				((scope && (key === "videoInputPath" || key === "metadataInputPath")) ||
					(key === "path" &&
						(row.hdr10Plus || (libraryInputs && hasPrivateLocator(item))))) &&
				!isHdr10PlusObjectPath(item)
			)
				hidden.add(item);
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
	const locators = [...hidden].sort((a, b) => b.length - a.length);
	function project(input: unknown): unknown {
		if (typeof input === "string") {
			if (hidden.has(input)) return "";
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
			Object.entries(input).map(([key, item]) => [key, project(item)]),
		);
	}
	return project(value) as T;
}
