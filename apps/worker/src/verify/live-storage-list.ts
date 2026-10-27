import type { ObjectStorageBrowser, StorageObject } from "@bitovp/storage";

/** Bounded storage listing used by the live runner's listAll adapter. */
export async function listLiveOutputObjects(
	browser: Pick<ObjectStorageBrowser, "listObjects">,
	bucket: string,
	prefix: string,
): Promise<StorageObject[]> {
	const objects: StorageObject[] = [];
	let cursor: string | undefined;
	const MAX_PAGES = 40;
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await browser.listObjects({
			bucket,
			prefix,
			limit: 100,
			recursive: true,
			...(cursor ? { cursor } : {}),
		});
		if (res.prefixes.length)
			throw new Error(
				`recursive listing ${prefix} returned unresolved child prefixes`,
			);
		for (const object of res.objects) objects.push({ ...object });
		if (objects.length > MAX_PAGES * 100) break;
		cursor = res.nextCursor;
		if (!cursor) return objects;
	}
	throw new Error(
		`listing ${prefix} exceeded ${MAX_PAGES * 100} objects — refusing to compare a truncated count, which would make a healthy channel look stalled`,
	);
}
