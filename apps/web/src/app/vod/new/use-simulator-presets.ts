"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
	type PerTitleSimulatorPreset,
	simulatorPresetListSchema,
} from "./per-title-simulator-presets";

export function useSimulatorPresets() {
	const [presets, setPresets] = useState<PerTitleSimulatorPreset[]>([]);
	useEffect(() => {
		const controller = new AbortController();
		let current = true;
		void (async () => {
			try {
				const data = await apiFetch<unknown>(
					"/api/per-title-simulator-presets",
					{
						cache: "no-store",
						signal: controller.signal,
					},
				);
				if (current) setPresets(simulatorPresetListSchema.parse(data).presets);
			} catch {
				// Local test presets are optional; file import remains available.
			}
		})();
		return () => {
			current = false;
			controller.abort();
		};
	}, []);
	return presets;
}
