"use client";

import {
	createContext,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useId,
	useRef,
	useState,
} from "react";
import { useT } from "@/lib/i18n/context";

const metrics = ["VMAF", "CAMBI"] as const;
type Metric = (typeof metrics)[number];

/** Share disclosure intent only; each mounted metric retains its own clock. */
export const QualityMetricPreviewContext = createContext<{
	open: boolean;
	setOpen: Dispatch<SetStateAction<boolean>>;
} | null>(null);

/** A metric owns its mounted player and clock; switching releases the other. */
export function QualityMetricTabs({
	vmaf,
	cambi,
}: {
	vmaf: ReactNode;
	cambi?: ReactNode;
}) {
	const { t } = useT();
	const id = useId();
	const [selected, setSelected] = useState<Metric>("VMAF");
	const [open, setOpen] = useState(false);
	const tabs = useRef<Partial<Record<Metric, HTMLButtonElement | null>>>({});
	if (!cambi) return vmaf;

	return (
		<QualityMetricPreviewContext.Provider value={{ open, setOpen }}>
			<div className="space-y-3">
				<div
					role="tablist"
					aria-label={t("qc.metricView")}
					className="flex gap-1 border-zinc-800 border-b"
				>
					{metrics.map((metric) => (
						<button
							key={metric}
							type="button"
							role="tab"
							id={`${id}-${metric}-tab`}
							aria-controls={`${id}-${metric}-panel`}
							aria-selected={selected === metric}
							tabIndex={selected === metric ? 0 : -1}
							ref={(element) => {
								tabs.current[metric] = element;
							}}
							className={`border-b-2 px-3 py-2 font-medium text-sm focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2 ${
								selected === metric
									? "border-emerald-500 text-emerald-400"
									: "border-transparent text-zinc-400 hover:text-zinc-200"
							}`}
							onClick={() => setSelected(metric)}
							onKeyDown={(event) => {
								let next: Metric;
								switch (event.key) {
									case "ArrowLeft":
									case "ArrowRight":
										next = metric === "VMAF" ? "CAMBI" : "VMAF";
										break;
									case "Home":
										next = "VMAF";
										break;
									case "End":
										next = "CAMBI";
										break;
									default:
										return;
								}
								event.preventDefault();
								setSelected(next);
								tabs.current[next]?.focus();
							}}
						>
							{metric}
						</button>
					))}
				</div>
				{metrics.map((metric) => (
					<div
						key={metric}
						role="tabpanel"
						id={`${id}-${metric}-panel`}
						aria-labelledby={`${id}-${metric}-tab`}
						hidden={selected !== metric}
						tabIndex={selected === metric ? 0 : -1}
						className="focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
					>
						{selected === metric ? (metric === "VMAF" ? vmaf : cambi) : null}
					</div>
				))}
			</div>
		</QualityMetricPreviewContext.Provider>
	);
}
