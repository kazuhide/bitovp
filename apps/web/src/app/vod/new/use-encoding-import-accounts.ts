"use client";

import type { BitmovinAccountSummaryWire } from "@bitovp/core";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

type Account = Pick<BitmovinAccountSummaryWire, "id" | "label">;

export function useEncodingImportAccounts(enabled: boolean) {
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [status, setStatus] = useState<"loading" | "loaded" | "error">(
		"loading",
	);
	const [attempt, setAttempt] = useState(0);
	const currentAttempt = useRef(0);
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		let current = true;
		const fresh = () => current && currentAttempt.current === attempt;
		setStatus("loading");
		void (async () => {
			try {
				const value = await apiFetch<Account[]>("/api/bitmovin-accounts", {
					cache: "no-store",
					signal: controller.signal,
				});
				if (
					!Array.isArray(value) ||
					value.some(
						(account) =>
							!account ||
							typeof account.id !== "string" ||
							typeof account.label !== "string",
					)
				)
					throw new Error("Invalid account list");
				if (fresh()) {
					setAccounts(value);
					setStatus("loaded");
				}
			} catch {
				if (fresh()) setStatus("error");
			}
		})();
		return () => {
			current = false;
			controller.abort();
		};
	}, [enabled, attempt]);
	return {
		accounts,
		status,
		retry: () => {
			currentAttempt.current += 1;
			setAttempt(currentAttempt.current);
		},
	};
}
