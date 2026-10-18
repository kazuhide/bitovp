"use client";

import { useEffect, useState } from "react";
import {
	type DashboardPanelId,
	readHiddenDashboardPanels,
	writeHiddenDashboardPanels,
} from "./dashboard-panels";

/** Browser-only dashboard presentation state, hydrated after the first render. */
export function useDashboardPanelPreferences() {
	const [hiddenPanels, setHiddenPanels] = useState<Set<DashboardPanelId>>(
		() => new Set(),
	);
	const [preferencesLoaded, setPreferencesLoaded] = useState(false);
	useEffect(() => {
		setHiddenPanels(readHiddenDashboardPanels());
		setPreferencesLoaded(true);
	}, []);

	const togglePanel = (id: DashboardPanelId) => {
		const next = new Set(hiddenPanels);
		next.has(id) ? next.delete(id) : next.add(id);
		// State remains authoritative if the best-effort storage write is blocked.
		setHiddenPanels(next);
		writeHiddenDashboardPanels(next);
	};
	const showAllPanels = () => {
		const next = new Set<DashboardPanelId>();
		setHiddenPanels(next);
		writeHiddenDashboardPanels(next);
	};

	return { hiddenPanels, preferencesLoaded, togglePanel, showAllPanels };
}
