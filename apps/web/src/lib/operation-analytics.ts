export type OperationAnalyticsWeek = {
	weekStart: string;
	isPartial: boolean;
	started: number;
	firstFrame: number;
	failed: number;
	canceled: number;
	unconfirmed: number;
	pending: number;
	firstFrameShare: number | null;
	p50Ms: number | null;
	p95Ms: number | null;
};

export type OperationAnalyticsDto = {
	weeks: OperationAnalyticsWeek[];
	isCollecting: boolean;
};
