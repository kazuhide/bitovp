import {
	MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH,
	moqPlaybackUrlSchema,
} from "@bitovp/core";
import { z } from "zod";

const descriptorSchema = z
	.strictObject({
		runId: z.uuid(),
		encodingId: z.uuid(),
		relay: z
			.strictObject({
				provider: z.literal("cloudflare"),
				endpointOrigin: z.enum([
					"https://draft-16.cloudflare.mediaoverquic.com",
					"https://draft-18.cloudflare.mediaoverquic.com",
				]),
				configuredRelayId: z.string().regex(/^[a-f0-9]{32}$/),
				tokenExpiresAt: z.iso.datetime(),
				tokenOperations: z.tuple([z.literal("subscribe")]),
				metadataSource: z.literal("unverified-token-claims"),
			})
			.optional(),
		playerLicenseKey: z.string().min(1).max(200),
		analytics: z
			.strictObject({
				licenseKey: z.string().min(1).max(200),
				licenseKeySha256: z.string().regex(/^[0-9a-f]{64}$/),
				videoId: z.string().max(200),
				collectorVersion: z.literal("2.62.0"),
				latencyField: z.literal("customData1"),
			})
			.optional(),
		resource: z.strictObject({
			type: z.literal("moq"),
			url: moqPlaybackUrlSchema,
			metadata: z.strictObject({
				namespace: z.string().min(1).max(MOQ_PLAYBACK_NAMESPACE_MAX_LENGTH),
				catalogTrackName: z.literal("catalog"),
				draftVersion: z.union([z.literal(16), z.literal(18)]),
				mediaTypes: z.tuple([z.literal("audio"), z.literal("video")]),
			}),
		}),
	})
	.refine(
		(value) =>
			!value.analytics ||
			value.analytics.videoId ===
				`bitovp-moq:${value.encodingId}:${value.runId}`,
	);
export type MoqPlaybackDescriptor = z.infer<typeof descriptorSchema>;
export function parseMoqPlaybackDescriptor(
	value: unknown,
	runId: string,
): MoqPlaybackDescriptor {
	const parsed = descriptorSchema.safeParse(value);
	if (!parsed.success || parsed.data.runId !== runId)
		throw new Error("MoQ descriptor unavailable");
	return parsed.data;
}

export type MoqSource = {
	setTargetBufferLevel(seconds: number): void;
	setVolume(volume: number): void;
	play(): Promise<unknown> | undefined;
	logLevel?: number;
	/** Official MoQ demo APIs report seconds, not milliseconds or network RTT. */
	getLatency?(): number;
	getBufferLevel?(): number;
	getVideoQuality?(): unknown;
	getAvailableVideoQualities?(): unknown;
};
export type MoqPlayer = {
	sources: {
		add(
			config: { resources: MoqPlaybackDescriptor["resource"][] },
			options: { attach: false },
		): MoqSource;
		remove(source: MoqSource): void;
	};
	dispose(): Promise<unknown> | undefined;
	events?: {
		Type: { PlayerError?: string; SourceError?: string };
		on(type: string, callback: () => void): void;
		off(type: string, callback: () => void): void;
	};
};
export type MoqPlayerFactory = (config: {
	key: string;
	defaultContainer: HTMLElement;
	defaultLogLevel: 0;
	playback: { autoplay: false; muted: true };
	volume: 0;
}) => MoqPlayer | Promise<MoqPlayer>;
