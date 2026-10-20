/** The app expands only this token; StreamInfo.uri receives a literal filename. */
export const HLS_VIDEO_GROUP_TOKEN = "{group}";

/** Flat filenames keep segmentPath relative to the existing master directory. */
export function isHlsVideoFilename(value: string): boolean {
	return (
		value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._-]*\.m3u8$/.test(value)
	);
}

export function isHlsVideoUriPattern(value: string): boolean {
	return (
		value.length <= 200 &&
		isHlsVideoFilename(value.replaceAll(HLS_VIDEO_GROUP_TOKEN, "group"))
	);
}

export function resolveHlsVideoUri(value: string, group?: string): string {
	return group === undefined
		? value
		: value.replaceAll(HLS_VIDEO_GROUP_TOKEN, group);
}

/** Normalize object paths, not URLs; explicit video names are always flat. */
export function hlsPlaylistWritePath(base: string, filename: string): string {
	const parts: string[] = [];
	for (const part of `${base}/${filename}`.split("/")) {
		if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return parts.join("/");
}
