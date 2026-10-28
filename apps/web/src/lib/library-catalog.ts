import type { ContentView, LibraryFileKind } from "@bitovp/core";

export const MAX_LIBRARY_OFFSET = 100000;

/** Stored supported playback metadata; this does not assert remote availability. */
export type LibraryPlaybackFilter = "all" | "playback" | "metadata";
export type LibraryCatalogItem = ContentView & {
	catalogMetadata: {
		formats: ("HLS" | "DASH" | LibraryFileKind)[];
		duration?: number;
		sceneCount?: number;
	};
};
export type LibraryCatalog = {
	items: LibraryCatalogItem[];
	total: number;
	counts: Record<LibraryPlaybackFilter, number>;
};
