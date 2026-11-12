"use client";

import { useId } from "react";
import { useT } from "@/lib/i18n/context";
import { parseVodFlow, VOD_FLOWS } from "@/lib/vod-flow";
import {
	persistVodFlow,
	useRememberedVodFlow,
} from "@/lib/vod-flow-preference";
import { InfoHint } from "./ui/info-hint";
import { SelectNative } from "./ui/input";

/**
 * The flow a new VOD job opens in, changed from Settings. It is the one preference the
 * switch on the New VOD job page writes, not a second setting beside it.
 */
export function VodFlowPreference() {
	const id = useId();
	const { t } = useT();
	const flow = useRememberedVodFlow();
	return (
		<div className="max-w-sm">
			<div className="flex items-center gap-1.5">
				<label htmlFor={id} className="shrink-0 text-xs text-zinc-400">
					{t("vodFlow.preferenceLabel")}
				</label>
				<InfoHint
					text={t("vodFlow.preferenceHint")}
					labelFor={t("vodFlow.preferenceLabel")}
				/>
			</div>
			<SelectNative
				id={id}
				className="mt-2"
				value={flow}
				onChange={(event) => {
					const next = parseVodFlow(event.target.value);
					if (next) persistVodFlow(next);
				}}
			>
				{VOD_FLOWS.map((option) => (
					<option key={option} value={option}>
						{t(`vodFlow.${option}`)}
					</option>
				))}
			</SelectNative>
		</div>
	);
}
