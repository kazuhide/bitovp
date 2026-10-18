import type { LiveChannelPlan } from "../live/schema";

/**
 * Derive the RTMP push target a SCHEDULED feeder should use  —
 * the server-side twin of the feeder panel's prefill: RTMP channels push to
 * `rtmp://<encoderIp>/live` with the channel's stream key; REDUNDANT_RTMP
 * pushes to the FIRST dynamic ingest point's application with that point's
 * key. Everything else is a NAMED refusal — scheduled feeders are v1
 * RTMP-family only (SRT caller-mode feeders exist manually; scheduling them
 * is future work recorded on row 96).
 *
 * Returns null coordinates while the channel has no encoder IP yet — the
 * sweep treats that as WAIT, exactly like the slate's not-RUNNING wait.
 */
/**
 * The fixed ingest FQDN a static redundant point pushes to ( —
 * live-INPUT, not live-ingest; DNS-settled). Single source: the web feeder
 * prefill and the verify harness both import it from here.
 */
export const STATIC_INGEST_URL = "rtmps://live-input.bitmovin.com/live";

export type FeederTarget =
	| { ok: true; url: string; streamKey: string }
	| { ok: false; reason: string }
	| { ok: "pending"; reason: string };

export function deriveFeederRtmpTarget(
	plan: Pick<LiveChannelPlan, "liveInput" | "start">,
	channelStreamKey: string | null,
	encoderIp: string | null,
): FeederTarget {
	const input = plan.liveInput;
	const key = channelStreamKey ?? plan.start.streamKey;
	switch (input.kind) {
		case "RTMP": {
			if (!encoderIp) {
				return { ok: "pending", reason: "encoder IP not known yet" };
			}
			return { ok: true, url: `rtmp://${encoderIp}/live`, streamKey: key };
		}
		case "REDUNDANT_RTMP": {
			const point = input.ingestPoints?.[0];
			if (!point) {
				return {
					ok: false,
					reason:
						"REDUNDANT_RTMP channel has no dynamic ingest points — scheduled feeders need one to target",
				};
			}
			if (!encoderIp) {
				return { ok: "pending", reason: "encoder IP not known yet" };
			}
			return {
				ok: true,
				url: `rtmp://${encoderIp}/${point.applicationName}`,
				streamKey: point.streamKey,
			};
		}
		default:
			return {
				ok: false,
				reason: `scheduled feeders support RTMP-family inputs only (channel input is ${input.kind}) — attach a feeder manually or use an external ingest`,
			};
	}
}
