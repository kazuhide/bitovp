import type { ReactNode } from "react";

/** Keep the time series and ladder compact beside the score distribution. */
export function AnalysisChartLayout({
	frames,
	distribution,
	ladder,
}: {
	frames: ReactNode;
	distribution: ReactNode;
	ladder: ReactNode;
}) {
	return (
		<div className="grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(35rem,1fr)]">
			<div className="min-w-0 space-y-2">{frames}</div>
			<div className="min-w-0 xl:col-start-2 xl:row-span-2 xl:row-start-1">
				{distribution}
			</div>
			<div className="min-w-0 space-y-2">{ladder}</div>
		</div>
	);
}
