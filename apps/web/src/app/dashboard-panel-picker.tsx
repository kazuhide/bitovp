"use client";

import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	DASHBOARD_INSIGHT_PANEL_IDS,
	DASHBOARD_USAGE_PANEL_IDS,
	type DashboardPanelId,
	dashboardPanelIsVisible,
} from "./dashboard-panels";

const LABEL_KEYS: Record<DashboardPanelId, MessageKey> = {
	"usage-minutes": "usage.minutesTitle",
	"usage-breakdown": "usage.breakdownTitle",
	"jobs-by-day": "insights.encodedVolume",
	"live-airtime": "insights.egressVolume",
};

export function DashboardPanelPicker({
	hiddenPanels,
	onTogglePanel,
	onShowAllPanels,
	children,
}: {
	hiddenPanels: ReadonlySet<DashboardPanelId>;
	onTogglePanel: (id: DashboardPanelId) => void;
	onShowAllPanels: () => void;
	children?: ReactNode;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const usage = [...DASHBOARD_USAGE_PANEL_IDS];
	return (
		<div className="relative shrink-0">
			<Button
				variant="secondary"
				size="sm"
				aria-expanded={open}
				aria-controls="dashboard-panel-picker"
				onClick={() => setOpen((value) => !value)}
			>
				{t("dashboard.panelsButton")}
			</Button>
			{open ? (
				<fieldset
					id="dashboard-panel-picker"
					aria-label={t("dashboard.panelsButton")}
					className="absolute right-0 z-20 mt-2 max-h-[80vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-4 shadow-xl"
				>
					{children}
					<PanelChoices
						legend={t("dashboard.panelsUsage")}
						ids={usage}
						hidden={hiddenPanels}
						onToggle={onTogglePanel}
					/>
					<PanelChoices
						legend={t("dashboard.trends")}
						ids={DASHBOARD_INSIGHT_PANEL_IDS}
						hidden={hiddenPanels}
						onToggle={onTogglePanel}
					/>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="mt-3 w-full"
						disabled={hiddenPanels.size === 0}
						onClick={onShowAllPanels}
					>
						{t("dashboard.panelsReset")}
					</Button>
				</fieldset>
			) : null}
		</div>
	);
}

function PanelChoices({
	legend,
	ids,
	hidden,
	onToggle,
}: {
	legend: string;
	ids: readonly DashboardPanelId[];
	hidden: ReadonlySet<DashboardPanelId>;
	onToggle: (id: DashboardPanelId) => void;
}) {
	const { t } = useT();
	return (
		<fieldset className="mt-4 border-zinc-800 border-t pt-3">
			<legend className="px-1 font-medium text-xs text-zinc-300">
				{legend}
			</legend>
			<div className="mt-1 space-y-2">
				{ids.map((id) => {
					const label = t(LABEL_KEYS[id]);
					return (
						<div key={id}>
							<label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
								<input
									type="checkbox"
									className="mt-0.5 accent-emerald-500"
									aria-label={label}
									checked={dashboardPanelIsVisible(hidden, id)}
									onChange={() => onToggle(id)}
								/>
								<span>{label}</span>
							</label>
						</div>
					);
				})}
			</div>
		</fieldset>
	);
}
