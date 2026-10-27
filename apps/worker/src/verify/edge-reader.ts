/**
 * The Akamai delivery EDGE reader for MSL mirror-leg closure.
 * A plain HTTP GET, as a player would — MSL is Akamai's
 * ingest, so the mirror is observed on its public delivery URL, never on a
 * storage driver. Dormant unless an `edgeBaseUrl` is configured (see
 * `collectEdgeClosures`).
 *
 * A pure factory over `fetch` so the reader itself is testable (rev411 M-A):
 * the one line that forwards `Last-Modified` is the last hop of the WP-C6b
 * freshness verdict, and losing it silently turns every real run into
 * UNVERIFIED (WARN) — a verdict no source-text pin on `runLive` could see.
 */
export type EdgeReaderFetch = (
	url: string,
	init: { redirect: "manual" },
) => Promise<Response>;

export function edgeReaderFor(fetchImpl: EdgeReaderFetch = fetch) {
	return async (url: string) => {
		const res = await fetchImpl(url, { redirect: "manual" });
		// The RAW bytes, so a media segment is hashed byte-for-byte (EV-02):
		// `res.text` decodes lossily and a hash over it names nothing.
		const body = new Uint8Array(await res.arrayBuffer());
		// `Last-Modified` is the object's own age: a re-aired channel's
		// playlists can name a PREVIOUS airing's objects (WP-C6b), and only
		// this header, against the run's start, tells the two apart.
		const lastModified = res.headers.get("last-modified");
		return {
			status: res.status,
			bytes: body.byteLength,
			bodyComplete: true,
			text: Buffer.from(body).toString("utf8"),
			body,
			redirected: res.redirected,
			finalUrl: res.url,
			...(lastModified !== null ? { lastModified } : {}),
		};
	};
}
