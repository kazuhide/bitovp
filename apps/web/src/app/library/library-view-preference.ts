import {
	type LibraryPlaybackFilter,
	MAX_LIBRARY_OFFSET,
} from "@/lib/library-catalog";

export type LibraryView = "grid" | "list";
export type LibrarySceneMatch = "all" | "any";
export type LibrarySceneSort = "relevance" | "recent";
export type LibraryBrowseState = {
	q: string;
	archived: boolean;
	playback: LibraryPlaybackFilter;
	mode: "content" | "scenes";
	offset: number;
	match?: LibrarySceneMatch;
	sort?: LibrarySceneSort;
	locale?: string;
};
const VIEW_KEY = "bitovp.library.view";

export function readLibraryBrowseState(
	params: Record<string, string | string[] | undefined>,
): LibraryBrowseState {
	const offset = typeof params.offset === "string" ? Number(params.offset) : 0;
	return {
		q: typeof params.q === "string" ? params.q.slice(0, 200) : "",
		archived: params.archived === "true",
		playback:
			params.playback === "playback" || params.playback === "metadata"
				? params.playback
				: "all",
		mode: params.mode === "scenes" ? "scenes" : "content",
		match: params.match === "any" ? "any" : "all",
		sort: params.sort === "recent" ? "recent" : "relevance",
		locale:
			typeof params.locale === "string" &&
			params.locale.length <= 35 &&
			/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(params.locale)
				? params.locale
				: "",
		offset:
			Number.isInteger(offset) && offset >= 0 && offset <= MAX_LIBRARY_OFFSET
				? offset
				: 0,
	};
}

export function libraryBrowseSearch(state: LibraryBrowseState): string {
	const params = new URLSearchParams();
	if (state.q) params.set("q", state.q);
	if (state.archived) params.set("archived", "true");
	if (state.playback !== "all") params.set("playback", state.playback);
	if (state.mode !== "content") params.set("mode", state.mode);
	if (state.match === "any") params.set("match", state.match);
	if (state.sort === "recent") params.set("sort", state.sort);
	if (state.locale) params.set("locale", state.locale);
	if (state.offset) params.set("offset", String(state.offset));
	return params.size ? `?${params}` : "";
}

export function readLibraryViewPreference(): LibraryView {
	try {
		return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
	} catch {
		return "grid";
	}
}

export function saveLibraryViewPreference(view: LibraryView) {
	try {
		localStorage.setItem(VIEW_KEY, view);
	} catch {
		// A denied browser storage permission does not prevent browsing.
	}
}

export function libraryTimeLabel(seconds: number) {
	const whole = Math.floor(seconds);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
