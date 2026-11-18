import { bindPassiveRequestUrl } from "@/lib/passive-request";
import type { MoqPlayerFactory } from "./types";

let loading: Promise<MoqPlayerFactory> | undefined;
function globalFactory(): MoqPlayerFactory | undefined {
	try {
		const factory = (
			window as Window & {
				bitmovin?: { playerx?: { Player?: MoqPlayerFactory } };
			}
		).bitmovin?.playerx?.Player;
		return typeof factory === "function" ? factory : undefined;
	} catch {
		return undefined;
	}
}
/** Load only the fixed, authenticated, digest-checked local asset route. */
export function loadMoqPlayer(
	organizationId?: string,
): Promise<MoqPlayerFactory> {
	let assetUrl: string;
	try {
		if (!organizationId) throw new Error();
		assetUrl = bindPassiveRequestUrl("/api/player-assets/moq", organizationId);
	} catch {
		return Promise.reject(new Error("MoQ player unavailable"));
	}
	if (loading) return loading;
	const previousFactory = globalFactory();
	const script = document.createElement("script");
	script.src = assetUrl;
	script.async = true;
	script.dataset.bitovpMoq = "true";
	const promise = new Promise<MoqPlayerFactory>((resolve, reject) => {
		const timeout = window.setTimeout(() => finish(), 15_000);
		function finish(factory?: MoqPlayerFactory) {
			window.clearTimeout(timeout);
			script.onload = null;
			script.onerror = null;
			if (factory) resolve(factory);
			else {
				script.remove();
				reject(new Error("MoQ player unavailable"));
			}
		}
		script.onload = () => {
			const factory = globalFactory();
			finish(factory !== previousFactory ? factory : undefined);
		};
		script.onerror = () => finish();
		document.head.append(script);
	});
	loading = promise;
	void promise.catch(() => {
		if (loading === promise) loading = undefined;
	});
	return promise;
}
