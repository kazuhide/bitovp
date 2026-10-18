/** Probe only our authenticated Library route, with one byte and no storage locators. */
export async function libraryMp4PlaybackError(
	url: string,
	signal: AbortSignal,
): Promise<"missing" | "storage-access-denied" | null> {
	if (
		!/^\/api\/library\/sources\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/media\?key=[A-Za-z0-9_.!~*'()%:-]+$/i.test(
			url,
		)
	)
		return null;
	try {
		const response = await fetch(url, {
			headers: { Range: "bytes=0-0" },
			cache: "no-store",
			signal,
		});
		if (response.status === 404 || response.status === 502) {
			const body = (await response.json()) as {
				details?: { code?: string };
			};
			if (
				response.status === 404 &&
				body.details?.code === "MEDIA_FILE_NOT_FOUND"
			)
				return "missing";
			if (
				response.status === 502 &&
				body.details?.code === "MEDIA_STORAGE_ACCESS_DENIED"
			)
				return "storage-access-denied";
			return null;
		}
		await response.body?.cancel();
	} catch {
		// Authorization, cancellation, network and decoder failures remain distinct from absence.
	}
	return null;
}

/** Thumbnail availability still distinguishes only a confirmed missing file. */
export async function libraryMp4IsMissing(
	url: string,
	signal: AbortSignal,
): Promise<boolean> {
	return (await libraryMp4PlaybackError(url, signal)) === "missing";
}
