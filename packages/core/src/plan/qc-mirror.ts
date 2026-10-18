/**
 * The QC VMAF mirror's NAME, in one leaf module.
 *
 * The compiler emits, for every video rendition, an unencrypted single-file
 * mirror muxing whose filename is `qcMirrorFilename(key, codec)` — the object
 * the VMAF runner scores. That filename is not decoration: beside the resolved
 * `qc/` output path, it carries the plan rendition KEY that ties a generated
 * PER_TITLE_RESULT back to its template . So
 * three readers need it now:
 *
 *  - the compiler, when it emits the mirror muxing;
 *  - the VMAF target enumeration and per-title population, to fetch the mirror;
 *  - and the per-title RESULT attribution, to bind a result to its template.
 *
 * It lived in `compiler.ts`, but `compiler.ts` imports `per-title-results.ts`,
 * so importing it back there for attribution would close an import cycle. It is
 * pure (codec string in, name out), so it lives here as a LEAF that both sides
 * import, and `compiler.ts` re-exports it for the callers that already reach it
 * through the compiler .
 */

/**
 * The mirror's CONTAINER for a codec — VP9 rides a progressive WebM because the
 * provider refuses a VP9 progressive MP4 (paid audit 893eb66 HIGH-9, case 9);
 * every other codec keeps `.mp4`. Exported on its own because the Akamai MSL
 * checker counts the synthesized mirror among the muxing kinds reaching an
 * output (review-324 I1). One definition, several callers.
 */
export function qcMirrorMuxingKind(codec: string): "MP4" | "WEBM" {
	return codec === "VP9" ? "WEBM" : "MP4";
}

/**
 * The QC mirror's filename for a rendition — ONE definition, read here when the
 * mirror muxing is emitted, by the VMAF runner's target enumeration when it goes
 * to fetch it, and by per-title attribution when it binds a RESULT muxing back
 * to its template .
 */
export function qcMirrorFilename(renditionKey: string, codec: string): string {
	return `${renditionKey}.${qcMirrorMuxingKind(codec) === "WEBM" ? "webm" : "mp4"}`;
}

/**
 * The single-file muxing kinds the compiler emits for the QC mirror (ledger
 * #205): an MP4 for every codec but VP9, which rides a progressive WebM. The
 * one definition, shared by the per-title population (which fetches the mirror)
 * and the per-title attribution (which reads the mirror muxing's filename to
 * bind a RESULT to its template — audit 602ec286 §5.4). Compared uppercased,
 * because the SDK's polymorphic discriminant casing is not ours to assume.
 */
export const QC_MIRROR_MUXING_TYPES: ReadonlySet<string> = new Set([
	"MP4",
	"PROGRESSIVE_WEBM",
	"WEBM",
]);

/**
 * Whether a resolved provider output is the compiler-owned QC child directory.
 *
 * Single-file delivery muxings (Smooth MP4 and progressive WebM) also carry a
 * filename, so container kind + filename alone cannot identify a QC mirror.
 * The compiler's stable discriminator is the final, exact `qc` path segment.
 */
export function isQcMirrorOutputPath(path: string): boolean {
	return /(^|\/)qc\/?$/.test(path);
}
