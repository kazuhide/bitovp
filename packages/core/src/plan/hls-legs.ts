/**
 * Which muxing legs an HLS manifest lists, and the playlist version those legs
 * imply — the two rules spelled ONCE, for the same reason `dash-legs.ts`
 * exists (review-323 S2, "one derivation, two callers").
 *
 * Both rules had hand-written copies, and the copy that did NOT get widened is
 * where the defect landed. The wizard's default-version scan read VIDEO legs
 * only, so an audio-only plan whose audio muxing is fMP4 defaulted to V4 while
 * every one of its media playlists carries EXT-X-MAP; the validator's warning
 * carried the identical narrow scan and so stayed silent about it (2026-08-29
 * paid re-audit HIGH-4 — the explicit-V6 audio-only run passed, which is what
 * proves the DEFAULT was the wrong half).
 */

/**
 * Does a manifest with this `videoMuxingKind` / `audioMuxingKind` pin list this
 * muxing leg?
 *
 * An ABSENT pin lists every leg of its family — which is exactly why one
 * rendition packaged into two legs needs a pin: unpinned, the manifest lists
 * the rendition twice (2026-08-29 paid re-audit HIGH-5).
 */
/** The leg kinds an HLS manifest can pin — the schema's `videoMuxingKind` / `audioMuxingKind` enum. */
export type HlsLegKind = "FMP4" | "MP4" | "TS";

export function hlsLegSelected(
	// A muxing's kind is wider than the HLS pin set (WEBM legs exist and are
	// never listed by an HLS manifest); the PIN is the narrow half.
	legKind: string,
	pin: HlsLegKind | undefined,
): boolean {
	return legKind !== "CMAF" && (pin === undefined || legKind === pin);
}

/**
 * The media-playlist version the legs a manifest lists imply: an fMP4 playlist
 * carries EXT-X-MAP, which RFC 8216 §7 places at protocol version 6. TS and MP4
 * legs are complete at version 4, which is what the vendor samples spell.
 *
 * FAMILY-BLIND on purpose. `mediaVersion` is ONE value covering every child
 * playlist the master lists, and an fMP4 AUDIO playlist needs EXT-X-MAP exactly
 * as an fMP4 video playlist does — the assumption "video decides" is the whole
 * of HIGH-4, and stating the rule over legs rather than over videos is what
 * stops it from being re-assumed.
 */
export function hlsVersionForLegs(
	kinds: Iterable<string>,
): "HLS_V4" | "HLS_V6" {
	for (const kind of kinds) {
		if (kind === "FMP4" || kind === "CMAF") {
			return "HLS_V6";
		}
	}
	return "HLS_V4";
}
