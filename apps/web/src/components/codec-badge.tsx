import type { RenditionFamily } from "@bitovp/core";
import { Badge } from "@/components/ui/badge";

/**
 * Codec and muxing badges for the rendition tables.
 *
 * Colour carries a MEANING here rather than decoration, which is why these are
 * components and not a `<Badge>{codec}</Badge>` at each call site: the tables
 * list a dozen rows, and an operator scanning them needs video/audio/subtitle to
 * separate at a glance. Video is emerald, audio neutral, subtitle neutral with a
 * dimmer border — three tiers, not nine colours, because the codec name is
 * already written in the badge and hue only has to answer "which family".
 *
 * Deliberately NOT reusing the `tone="ok"` semantic: `ok` means a status is
 * healthy elsewhere in this app (a FINISHED job, a passing check), and a video
 * codec is not "healthy". These carry their own classes so the semantic tones
 * keep meaning exactly one thing.
 */

/**
 * The family comes from CORE, never from a local list.
 *
 * The first version forked both codec sets character-for-character out of
 * `schema.ts` and `detail-view.ts` — exactly what `codec-families.test.ts` was
 * written to prevent, except that test guards `renditionFamily` and has no reach
 * into the web layer. A codec added to the schema would have rendered with
 * "unknown" styling while the selector filed it correctly (review finding).
 *
 * Every caller already has the answer: `RenditionSummary.family` is on every row.
 * `family` is therefore required, and `renditionFamily` is re-exported from core
 * for the few callers that hold a bare codec string.
 */
const FAMILY_CLASS: Record<RenditionFamily, string> = {
	video: "border-emerald-900 bg-emerald-950/30 text-emerald-300",
	audio: "border-sky-900 bg-sky-950/30 text-sky-300",
	subtitle: "border-zinc-800 text-zinc-500",
};

export function CodecBadge({
	codec,
	family,
}: {
	codec: string;
	family: RenditionFamily;
}) {
	return <Badge className={`font-mono ${FAMILY_CLASS[family]}`}>{codec}</Badge>;
}

/**
 * Muxing kind. Neutral across the board: unlike codecs, the kinds do not group
 * into families an operator scans for — FMP4 vs TS vs MP4 is a packaging choice,
 * and tinting them would spend colour that the codec column needs.
 */
export function MuxingBadge({ kind }: { kind: string }) {
	return <Badge className="font-mono">{kind}</Badge>;
}
