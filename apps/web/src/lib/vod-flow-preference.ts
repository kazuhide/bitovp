"use client";

import { useSyncExternalStore } from "react";
import { resolveVodFlow, VOD_FLOW_COOKIE, type VodFlow } from "./vod-flow";

const listeners = new Set<() => void>();

/**
 * Remember the flow for the next visit. A display preference like the locale and the
 * theme, so it is written from the browser the same way and carries nothing secret.
 */
export function persistVodFlow(flow: VodFlow): void {
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	// biome-ignore lint/suspicious/noDocumentCookie: CookieStore is Chromium-only
	document.cookie = `${VOD_FLOW_COOKIE}=${flow}; Path=/; Max-Age=63072000; SameSite=Lax${secure}`;
	for (const listener of listeners) listener();
}

function remembered(): VodFlow {
	const prefix = `${VOD_FLOW_COOKIE}=`;
	const value = document.cookie
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(prefix))
		?.slice(prefix.length);
	return resolveVodFlow(undefined, value);
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * The remembered flow, for a control outside the wizard. The server render cannot see
 * the cookie from here, so it answers with the default and the browser corrects it
 * after hydration instead of mismatching during it.
 */
export function useRememberedVodFlow(): VodFlow {
	return useSyncExternalStore(subscribe, remembered, () => "streaming");
}
