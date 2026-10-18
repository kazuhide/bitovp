import type { LiveChannelPlan } from "@bitovp/core";
import type { MessageKey } from "@/lib/i18n";
import { STATIC_INGEST_URL } from "../feeders/feeder-shared";

/**
 * Derives operator-facing ingest coordinates (what to type into the
 * encoder) from the plan's input kind plus the channel's streamKey /
 * encoderIp columns. The stream key IS displayed here — the ledgered
 * redaction exception: it is connection-routing material the operator
 * must read back to point an encoder (COVERAGE P3 batch 1/2). It is never
 * logged elsewhere.
 *
 * Labels, hints and the not-yet-known sentinel are MESSAGE KEYS, not strings: this
 * is a pure function with its own tests, so it holds no translator, and the caller
 * formats. Returning English here is what left twenty strings untranslated under a
 * Japanese heading (review catch) — the same shape `dvrGaugeModel` solved by
 * returning `{key, values}`.
 */

export type IngestCoordinate = {
	labelKey: MessageKey;
	/** Values for an interpolated label (ingest point name, backup index). */
	labelValues?: Record<string, string | number>;
	/**
	 * The coordinate itself, or `null` when it is only known once the channel is
	 * RUNNING — the caller renders the "available once RUNNING" copy for `null`.
	 */
	value: string | null;
	/**
	 * A localized value, for the one row whose value IS prose: a CALLER backup is an
	 * address Bitmovin dials, and main rendered "Bitmovin calls host:port" in the
	 * always-visible value column. Moving that to a hint would have hidden it below
	 * `lg`, where the hint column is `hidden`.
	 */
	valueKey?: MessageKey;
	valueValues?: Record<string, string | number>;
	copyable: boolean;
	hintKey?: MessageKey;
};

export function ingestCoordinates(
	plan: LiveChannelPlan,
	streamKey: string | null,
	encoderIp: string | null,
): IngestCoordinate[] {
	const input = plan.liveInput;
	const ip = encoderIp ?? null;
	const key = streamKey ?? plan.start.streamKey;
	const rows: IngestCoordinate[] = [];

	switch (input.kind) {
		case "RTMP": {
			rows.push({
				labelKey: "ingest.rtmpPushUrl",
				value: ip ? `rtmp://${ip}/live` : null,
				copyable: ip !== null,
				hintKey: "ingest.rtmpPushUrlHint",
			});
			rows.push({
				labelKey: "ingest.streamKey",
				value: key,
				copyable: true,
			});
			if (ip) {
				rows.push({
					labelKey: "ingest.fullRtmpTarget",
					value: `rtmp://${ip}/live/${key}`,
					copyable: true,
					hintKey: "ingest.fullRtmpTargetHint",
				});
			}
			break;
		}
		case "REDUNDANT_RTMP": {
			if (input.ingestPoints) {
				for (const point of input.ingestPoints) {
					rows.push({
						labelKey: "ingest.ingestPointNamed",
						labelValues: { name: point.applicationName },
						value: ip
							? `rtmp://${ip}/${point.applicationName}/${point.streamKey}`
							: null,
						copyable: ip !== null,
						hintKey: "ingest.dynamicIngestPointHint",
					});
				}
			}
			if (input.staticIngestPoints) {
				input.staticIngestPoints.forEach((point, index) => {
					rows.push({
						labelKey: "ingest.staticIngestPointNamed",
						labelValues: { name: point.name ?? index + 1 },
						value: STATIC_INGEST_URL,
						copyable: true,
						hintKey: "ingest.staticIngestPointHint",
					});
				});
			}
			// STATIC uses a separately revealed StreamKey resource, never the
			// start request's placeholder or generic live-details streamKey.
			rows.push(
				input.staticIngestPoints?.length
					? {
							labelKey: "ingest.streamKey",
							value: null,
							valueKey: "feeder.staticKeyHint",
							copyable: false,
						}
					: { labelKey: "ingest.streamKey", value: key, copyable: true },
			);
			break;
		}
		case "SRT": {
			if (input.mode === "LISTENER") {
				rows.push({
					labelKey: "ingest.srtCallerTarget",
					value: ip ? `srt://${ip}:${input.port}` : null,
					copyable: ip !== null,
					hintKey: input.credentialId
						? "ingest.srtCallerHintWithPassphrase"
						: "ingest.srtCallerHint",
				});
				for (const [index, backup] of (
					input.backup?.srtInputs ?? []
				).entries()) {
					// A CALLER backup is an address Bitmovin dials, so its value is prose
					// and rides `valueKey` — the hint column is `hidden` below `lg`, so
					// moving it there would have dropped the information on a laptop.
					const dialled = backup.mode !== "LISTENER";
					rows.push({
						labelKey: "ingest.backupListenerN",
						labelValues: { n: index + 1 },
						value: dialled || !ip ? null : `srt://${ip}:${backup.port}`,
						...(dialled
							? {
									valueKey: "ingest.bitmovinCallsHost" as const,
									valueValues: {
										host: backup.host ?? "?",
										port: backup.port,
									},
								}
							: {}),
						copyable: !dialled && ip !== null,
					});
				}
			} else {
				rows.push({
					labelKey: "ingest.srtSourceBitmovinCalls",
					value: `${input.host ?? "?"}:${input.port}`,
					copyable: true,
					hintKey: "ingest.srtSourceHint",
				});
			}
			rows.push({
				labelKey: "ingest.streamKey",
				value: key,
				copyable: true,
				hintKey: "ingest.startRequestStreamKeyHint",
			});
			break;
		}
		case "ZIXI": {
			rows.push({
				labelKey: "ingest.zixiSource",
				value: `${input.host}:${input.port} / ${input.stream}`,
				copyable: true,
				hintKey: "ingest.zixiSourceHint",
			});
			rows.push({ labelKey: "ingest.streamKey", value: key, copyable: true });
			break;
		}
		case "HLS": {
			rows.push({
				labelKey: "ingest.hlsSourceUrl",
				value: input.url ?? "—",
				copyable: input.url !== undefined,
				hintKey: "ingest.hlsSourceHint",
			});
			rows.push({ labelKey: "ingest.streamKey", value: key, copyable: true });
			break;
		}
	}
	if (ip) {
		rows.push({ labelKey: "ingest.encoderIp", value: ip, copyable: true });
	}
	return rows;
}
