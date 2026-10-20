/** Give a copied rung its own filename without editing the source's override. */
export function copiedHlsVideoUri(
	uri: string,
	key: string,
	reserved: Iterable<string | undefined> = [],
	groups: Iterable<string> = [],
): string {
	const audioGroups = [...groups];
	const concrete = (name: string) => [
		name,
		...audioGroups.map((group) => name.replaceAll("{group}", group)),
	];
	const taken = new Set(
		[...reserved].flatMap((name) => (name === undefined ? [] : concrete(name))),
	);
	const stem = `video-${key.slice(0, 160)}${uri.includes("{group}") ? "-{group}" : ""}`;
	let candidate = `${stem}.m3u8`;
	for (let n = 2; concrete(candidate).some((name) => taken.has(name)); n += 1)
		candidate = `${stem}-${n}.m3u8`;
	return candidate;
}
