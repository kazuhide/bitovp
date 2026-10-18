import type { LibrarySourceView } from "@bitovp/core";

export type JobAnalysisResponse = {
	enabled: boolean;
	captureSuppressed: boolean;
	source: LibrarySourceView | null;
};
