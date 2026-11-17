import { z } from "zod";

const descriptorSchema = z.strictObject({
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
	resource: z.strictObject({
		type: z.literal("moq"),
		url: z
			.string()
			.max(8192)
			.refine((value) => {
				try {
					const url = new URL(value);
					return (
						url.protocol === "https:" &&
						!url.username &&
						!url.password &&
						!url.search &&
						!url.hash
					);
				} catch {
					return false;
				}
			}),
		metadata: z.strictObject({
			namespace: z.string().min(1).max(1024),
			catalogTrackName: z.literal("catalog"),
			draftVersion: z.union([z.literal(16), z.literal(18)]),
			mediaTypes: z.tuple([z.literal("audio"), z.literal("video")]),
		}),
	}),
});
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
