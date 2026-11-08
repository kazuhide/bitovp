/** The server binds a requested airing to its channel before sending this view. */
export type AisaSelectedRun = {
	id: string;
	liveChannelId: string;
	seq: number;
	aisaAnalysisId: string;
	bitmovinEncodingId: string;
	aisaStatus?: string | null;
	aisaSnapshot?: unknown;
};
