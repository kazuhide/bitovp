import type { PlanMuxing, PlanRendition } from "./schema";
import { AUDIO_CODECS } from "./schema";

/**
 * What a container packages — the ONE answer, for every reader.
 *
 * Until `additionalStreamKeys` landed, "which renditions does this muxing
 * package?" had a trivial answer (`muxing.streamKey`) that a dozen modules
 * each open-coded: the validator's unmuxed-rendition rail, the verification
 * compiler's artefact enumeration, the VMAF target resolver, the detail view,
 * the template instantiator, and both plan compilers. Every one of those was
 * CORRECT while a container held exactly one stream, and every one of them
 * silently answers the wrong question the moment a container holds two.
 *
 * That failure has a shape this repo keeps meeting: nothing throws, nothing
 * goes red, and the reader just does not see the second stream. The unmuxed
 * rail would warn that a muxed-in audio rendition "will be encoded but never
 * packaged" — about a rendition that IS packaged. So the rule lives here,
 * once, and the readers ask instead of remembering.
 */

/**
 * Every rendition key this container packages, primary first.
 *
 * Wire order matters and is preserved: the compiler maps this list straight
 * onto `Muxing.streams` as `MuxingStream[]`, and `streamKey` is stream 0 for
 * every plan ever written — which is what keeps the goldens byte-identical.
 */
export function muxingStreamKeys(muxing: PlanMuxing): readonly string[] {
	// `in` rather than an optional read: FMP4/WEBM/CHUNKED_TEXT do not carry
	// the field at all, so this is the narrowing TypeScript actually has.
	const extra =
		"additionalStreamKeys" in muxing ? muxing.additionalStreamKeys : undefined;
	return extra === undefined
		? [muxing.streamKey]
		: [muxing.streamKey, ...extra];
}

/** True when this container packages more than its primary stream. */
export function isMuxedContainer(muxing: PlanMuxing): boolean {
	return muxingStreamKeys(muxing).length > 1;
}

/**
 * Does this container carry audio ALONGSIDE its primary (video) stream?
 *
 * This is the HLS master-playlist question, and both compilers must answer it
 * the same way — the VOD one and the live one are separate files that have
 * drifted before .
 *
 * When it is true the variant's audio travels INSIDE the segments, so there is
 * no EXT-X-MEDIA audio rendition group to point at. Writing `audio=<group-id>`
 * anyway names a GROUP-ID that appears nowhere else in the playlist, which is
 * a broken master playlist rather than a cosmetic wart — the player resolves
 * the group, finds nothing, and has no audio. The compilers therefore OMIT the
 * attribute for such a variant (C33).
 *
 * "Is this rendition audio?" reads `AUDIO_CODECS`, the set the validator's
 * HLS-media rail and the compiler's Kantar fan-out already share — the same
 * question deserves the same answer, and three modules had already open-coded
 * their own `isAudioCodec` before this one arrived.
 */
export function hasMuxedInAudio(
	muxing: PlanMuxing,
	renditionByKey: ReadonlyMap<string, PlanRendition>,
): boolean {
	// The docstring above says "alongside its primary (VIDEO) stream" and the
	// first cut did not check that half — so a container holding two audio
	// tracks answered yes, and the C33 rails that ask this question treated it
	// as a self-contained video variant (review found it). A container whose
	// primary is not a picture is not a variant at all.
	const primary = renditionByKey.get(muxing.streamKey);
	if (
		primary === undefined ||
		primary.codec === "WEBVTT" ||
		primary.codec === "IMSC" ||
		AUDIO_CODECS.has(primary.codec)
	) {
		return false;
	}
	return muxingStreamKeys(muxing)
		.slice(1)
		.some((key) => {
			const rendition = renditionByKey.get(key);
			return rendition !== undefined && AUDIO_CODECS.has(rendition.codec);
		});
}
