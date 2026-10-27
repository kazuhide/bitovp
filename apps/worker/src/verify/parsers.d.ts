/**
 * Minimal declarations for `m3u8-parser` and `mpd-parser`.
 *
 * Neither ships types, and this project is TypeScript strict, so an untyped `import`
 * is a build error rather than a silent `any` — which is the right default. Declared
 * here narrowly: only the members the adapters actually read, so a future upstream
 * change surfaces as a type error at the one place that touches it instead of
 * propagating `any` through the engine.
 */

declare module "m3u8-parser" {
	/** A variant stream in a master playlist. */
	export type M3u8Playlist = {
		uri?: string;
		attributes?: {
			BANDWIDTH?: number;
			RESOLUTION?: { width?: number; height?: number };
			CODECS?: string;
		};
	};

	export type M3u8Manifest = {
		playlists?: M3u8Playlist[];
		/** `{ AUDIO: { groupId: { name: { uri } } }, SUBTITLES: {…} }` */
		mediaGroups?: Record<
			string,
			Record<
				string,
				Record<string, { uri?: string; language?: string; instreamId?: string }>
			>
		>;
		segments?: {
			uri?: string;
			duration?: number;
			byterange?: { offset?: number; length?: number };
			/** EXT-X-MAP for fMP4 media playlists. */
			map?: { uri?: string; byterange?: { offset?: number; length?: number } };
		}[];
		version?: number;
		targetDuration?: number;
		endList?: boolean;
	};

	export class Parser {
		manifest: M3u8Manifest;
		push(chunk: string): void;
		end(): void;
	}
}

declare module "mpd-parser" {
	export type MpdPlaylist = {
		uri?: string;
		resolvedUri?: string;
		attributes?: {
			id?: string;
			BANDWIDTH?: number;
			NAME?: string;
			CODECS?: string;
			RESOLUTION?: { width?: number; height?: number };
		};
		/** Segments the parser RESOLVED from the template/timeline/list . */
		segments?: {
			uri?: string;
			resolvedUri?: string;
			map?: { uri?: string; resolvedUri?: string };
		}[];
	};

	export type MpdManifest = {
		playlists?: MpdPlaylist[];
		mediaGroups?: Record<
			string,
			Record<string, Record<string, { playlists?: MpdPlaylist[] }>>
		>;
		duration?: number;
	};

	export function parse(manifestString: string, options?: unknown): MpdManifest;
	export function stringToMpdXml(manifestString: string): unknown;
	export type MpdRepresentationInfo = {
		attributes: { contentType?: string; mimeType?: string };
	};
	export function inheritAttributes(manifest: unknown): {
		representationInfo: MpdRepresentationInfo[];
	};
	export function toPlaylists(
		representations: MpdRepresentationInfo[],
	): MpdPlaylist[];
}
