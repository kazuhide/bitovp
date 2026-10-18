"use client";
import type { UsageBackfillStatus } from "@bitovp/core";
import { useEffect, useRef, useState } from "react";

export type BackfillResult = {
	job: (UsageBackfillStatus & { automatic?: boolean }) | null;
};
const isActive = (job: BackfillResult["job"]) =>
	job?.status === "queued" || job?.status === "running";
type Cycle = {
	alive: boolean;
	inFlight: boolean;
	failed: boolean;
	observedActive: boolean;
	followupAvailable: boolean;
	run: (followup?: boolean) => void;
};

/** Mount/account/focus refreshes are independent of the selected historical range.
 * A joined job gets one completion recheck; a followup job cannot loop on itself. */
export function useAutomaticUsageBackfill({
	accountId,
	enabled,
	job,
	request,
}: {
	accountId: string;
	enabled: boolean;
	job: BackfillResult["job"] | undefined;
	request: () => Promise<BackfillResult>;
}) {
	const requestRef = useRef(request);
	requestRef.current = request;
	const cycleRef = useRef<Cycle | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!enabled || !accountId) return;
		const cycle: Cycle = {
			alive: true,
			inFlight: false,
			failed: false,
			observedActive: false,
			followupAvailable: true,
			run: () => {},
		};
		cycleRef.current = cycle;
		cycle.run = (followup = false) => {
			if (!cycle.alive || cycle.inFlight || cycle.failed) return;
			if (!followup) cycle.followupAvailable = true;
			cycle.inFlight = true;
			setBusy(true);
			void requestRef
				.current()
				.then((result) => {
					if (!cycle.alive) return;
					cycle.failed = result.job?.status === "failed";
					cycle.observedActive = isActive(result.job);
				})
				.catch(() => {
					if (cycle.alive) cycle.failed = true;
				})
				.finally(() => {
					if (cycle.alive) {
						cycle.inFlight = false;
						setBusy(false);
					}
				});
		};
		const focus = () => cycle.run();
		window.addEventListener("focus", focus);
		cycle.run();
		return () => {
			cycle.alive = false;
			window.removeEventListener("focus", focus);
			if (cycleRef.current === cycle) cycleRef.current = null;
		};
	}, [accountId, enabled]);
	useEffect(() => {
		const cycle = cycleRef.current;
		if (!cycle || busy || job?.accountId !== accountId) return;
		if (isActive(job)) cycle.observedActive = true;
		else if (job?.status === "failed") cycle.failed = true;
		else if (
			job?.status === "completed" &&
			cycle.observedActive &&
			cycle.followupAvailable
		) {
			cycle.observedActive = false;
			cycle.followupAvailable = false;
			cycle.run(true);
		}
	}, [job, accountId, busy]);
	return {
		retry: () => {
			const cycle = cycleRef.current;
			if (cycle) {
				cycle.failed = false;
				cycle.run();
			}
		},
		manualStarted: () => {
			const cycle = cycleRef.current;
			if (cycle) {
				cycle.failed = false;
				cycle.followupAvailable = true;
				cycle.observedActive = false;
			}
		},
	};
}
