/** Reserve the flat name even while destination folders are still being edited. */
function flatOutputFilename(name: string): string {
	const parts: string[] = [];
	for (const part of name.split("/")) {
		if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return parts.at(-1) ?? "";
}

/** Give a copied rung its own filename without editing the source's override. */
export function copiedHlsVideoUri(
	uri: string,
	key: string,
	reserved: Iterable<string | undefined> = [],
	groups: Iterable<string> = [],
): string {
	const audioGroups = [...groups];
	const concrete = (name: string) =>
		[
			name,
			...audioGroups.map((group) => name.replaceAll("{group}", group)),
		].flatMap((value) => [value, flatOutputFilename(value)]);
	const taken = new Set(
		[...reserved].flatMap((name) => (name === undefined ? [] : concrete(name))),
	);
	const stem = `video-${key.slice(0, 160)}${uri.includes("{group}") ? "-{group}" : ""}`;
	let candidate = `${stem}.m3u8`;
	for (let n = 2; concrete(candidate).some((name) => taken.has(name)); n += 1)
		candidate = `${stem}-${n}.m3u8`;
	return candidate;
}
