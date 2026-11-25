/**
 * Whether a draft keeps this text. An address, a query or fragment, and a login
 * before a host are refused, and the field comes back empty.
 */
export function draftKeepsText(value: string, imagePath = false): boolean {
	const normalized = value.trimStart();
	if (
		/^[/\\]{2}/u.test(normalized) ||
		normalized.includes("://") ||
		/[?#]/u.test(normalized)
	)
		return false;
	const address = normalized.replace(/^[\s/\\]+/u, "");
	const authority = address.split(/[/\\]/u, 1)[0] ?? "";
	const colon = authority.indexOf(":");
	const at = authority.lastIndexOf("@");
	if (colon < 0 || at <= colon) return true;
	// A directory after the apparent login makes it an address. A generated
	// output directory may have only its final slash.
	const tail = address.slice(authority.length);
	const rawHost = authority.slice(at + 1);
	const host = rawHost.trimStart();
	if (
		address !== normalized &&
		!(
			imagePath &&
			normalized.startsWith("/") &&
			normalized.slice(1).trimStart() === address
		)
	)
		return false;
	if (!rawHost && !tail && /^(?:s3|gs):/iu.test(authority)) return true;
	if (!rawHost && !tail)
		return !imagePath && /\S\s+\S/u.test(authority.slice(colon + 1, at));
	if (!host || host !== host.trimEnd() || !/\s/u.test(authority.charAt(at - 1)))
		return false;
	const spacedLabel = host !== rawHost;
	// A multiword directory such as "Opening Credits" cannot be a network
	// hostname. Preserve the directory and any nested object key literally.
	if (spacedLabel && /\S\s+\S/u.test(host)) return true;
	if (/[^/]/u.test(tail)) return false;
	if (!spacedLabel && !/\s/u.test(authority.charAt(colon + 1))) return false;
	// Compare only terminal extensions. A host like cdn.png.invalid is
	// different from a filename ending in .png. Generated render filenames
	// add a container extension and can append a rendition or collision index.
	let stem = host;
	if (!imagePath && /\.(?:ts|mp4|mov|webm)$/iu.test(stem)) {
		stem = stem.slice(0, stem.lastIndexOf("."));
		for (let i = 0; i < 2; i++) {
			const dash = stem.lastIndexOf("-");
			if (dash < 0 || !/^\d+p?$/u.test(stem.slice(dash + 1))) break;
			stem = stem.slice(0, dash);
		}
	}
	const dot = stem.lastIndexOf(".");
	if (dot < 0) return !imagePath && spacedLabel;
	const extension = stem.slice(dot + 1);
	// Delivery labels can include a revision, either as the final component
	// of a display name or after the file format of an artwork asset.
	if (!imagePath && spacedLabel && /^v[0-9]+$/iu.test(extension)) return true;
	return (
		dot > 0 &&
		(/^(?:png|jpe?g|webp|gif|avif|bmp|tiff?|svg)(?:-v[0-9]+)?$/iu.test(
			extension,
		) ||
			(!imagePath && spacedLabel && /^(?:ts|mp4|mov|webm)$/iu.test(extension)))
	);
}

const extensions = new Map([
	["MP4", "mp4"],
	["PROGRESSIVE_TS", "ts"],
	["PROGRESSIVE_MOV", "mov"],
	["PROGRESSIVE_WEBM", "webm"],
]);
export function fileExtension(kind?: string) {
	return extensions.get(kind ?? "") ?? "mp4";
}
/**
 * Text a saved draft keeps. A draft drops text that reads as an address or a login,
 * and a file name dropped that way comes back empty: a TS or MOV file would then be
 * written under its container's own name, with nothing said. Both shapes are
 * spelled with ":".
 */
function keptByDraft(text: string): string {
	return draftKeepsText(text) ? text : text.replace(/:+/g, "-");
}

/** The part of a derived file name that comes from the job name. */
export function fileStem(name: string): string {
	return keptByDraft(name.trim().replace(/[/\\?#]+/g, "-")) || "output";
}

/**
 * A name as the format screen takes it. `?` and `#` end the path in a URL, so a file
 * named with one cannot be fetched by its address, and a saved draft drops any text
 * that holds one (`keptByDraft`). A folder in the name is left alone.
 */
export function typedFileName(name: string): string {
	return keptByDraft(name.replace(/[?#]+/g, "-"));
}

/**
 * The name each file gets while nobody has typed one: the job name for the first file,
 * the job name and the height for the rest. All files share one folder, so the names
 * have to differ.
 */
export function defaultFileNames(
	name: string,
	videos: readonly { height?: number | null; muxing?: { kind?: string } }[],
): string[] {
	const stem = fileStem(name);
	const taken = new Set<string>();
	return videos.map((video, index) => {
		const extension = fileExtension(video.muxing?.kind);
		const label =
			index === 0
				? stem
				: `${stem}-${video.height === null ? index + 1 : `${video.height}p`}`;
		let candidate = `${label}.${extension}`;
		for (let n = index + 1; taken.has(candidate); n++)
			candidate = `${label}-${n}.${extension}`;
		taken.add(candidate);
		return candidate;
	});
}

/**
 * The folder, relative to the destination folder, for what a job writes besides its
 * files: the AI Scene Analysis result, the copies the quality check measures and the
 * Kantar report. The files go straight into the destination folder, which other
 * jobs write to as well, and none of the three is named after the job: the result
 * is `analysis.json` unless renamed, and a copy is named by the key of its file's
 * video stream (`v1080.mp4`). Left in the destination folder, the next job would
 * replace them, and a job could be scored on a copy another job wrote.
 */
export function fileJobFolder(name: string): string {
	return `${fileStem(name)}/`;
}
