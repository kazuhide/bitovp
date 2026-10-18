import {
	enumerateLiveCaptureTargets,
	type LiveCaptureTarget,
	type LiveChannelPlan,
	vmafSourceFor,
} from "@bitovp/core";
import type { ObjectStorageBrowser } from "@bitovp/storage";

export const LIVE_CAPTURE_READ_TIMEOUT_MS = 5_000;
const BUDGET_MS = 15_000;
const MAX_TARGETS = 16;
const MAX_PAGES = 10;
type State = "ready" | "awaiting" | "unobservable";

/** Existence/freshness only: not a complete capture window or decoded-media proof. */
export async function checkLiveCaptureReadiness(
	plan: LiveChannelPlan,
	createdAt: Date,
	resolveBrowser: (
		credentialId: string,
	) => Promise<ObjectStorageBrowser | null>,
	now: () => number = Date.now,
): Promise<{ kind: State; ready: number; total: number; expiresAt: number }> {
	const expiresAt = now() + BUDGET_MS;
	const targets = enumerateLiveCaptureTargets(plan);
	const total = targets.length;
	const start = createdAt.getTime();
	const unknown = { kind: "unobservable" as const, ready: 0, total, expiresAt };
	if (
		!Number.isFinite(start) ||
		start > now() ||
		total === 0 ||
		total > MAX_TARGETS ||
		total !==
			plan.renditions.filter((r) => r.codec === "H264" || r.codec === "H265")
				.length
	)
		return unknown;

	async function inspect(target: LiveCaptureTarget): Promise<State> {
		let browser: ObjectStorageBrowser | null = null;
		try {
			const output = plan.outputs.find((out) => out.key === target.outputKey);
			if (!output) return "unobservable";
			const source = vmafSourceFor(output);
			if (!source.streamable) return "unobservable";
			const path = target.segmentPrefix.replace(/\/+$/, "");
			const safeName = (name: string) =>
				name.length > 0 &&
				!/[\\/]/.test(name) &&
				!name.includes("\0") &&
				name !== "." &&
				name !== "..";
			if (
				path.startsWith("/") ||
				path.includes("\\") ||
				path.split("/").some((part) => part === ".." || part === ".") ||
				!safeName(target.segmentNaming) ||
				!target.segmentNaming.includes("%number%") ||
				(target.kind === "FMP4" &&
					(!target.initSegmentName || !safeName(target.initSegmentName)))
			)
				return "unobservable";
			const prefix = path ? `${path}/` : "";
			const pattern = new RegExp(
				`^${target.segmentNaming.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%number%/g, "([0-9]+)")}$`,
			);
			if (now() >= expiresAt) return "unobservable";
			browser = await resolveBrowser(source.credentialId);
			if (!browser?.getObject) return "unobservable";
			let segment = false;
			let init = target.kind === "TS";
			let uncertain = false;
			let cursor: string | undefined;
			const cursors = new Set<string>();
			for (let page = 0; page < MAX_PAGES; page++) {
				if (now() >= expiresAt) return "unobservable";
				// SDK timeouts are opt-in at browser construction. Await this call;
				// never race it into a detached read or start another after the budget.
				const result = await browser.listObjects({
					bucket: source.bucket,
					prefix,
					recursive: true,
					limit: 100,
					...(cursor ? { cursor } : {}),
				});
				if (now() >= expiresAt || result.objects.length > 100)
					return "unobservable";
				for (const object of result.objects) {
					if (!object.key.startsWith(prefix)) continue;
					const name = object.key.slice(prefix.length);
					const match = pattern.exec(name);
					const isSegment =
						!!match && Number.isFinite(Number.parseInt(match[1] ?? "", 10));
					const isInit =
						target.kind === "FMP4" && name === target.initSegmentName;
					if (!isSegment && !isInit) continue;
					if (!Number.isFinite(object.size) || object.size <= 0) continue;
					const modified = Date.parse(object.lastModified ?? "");
					if (!Number.isFinite(modified) || modified > now()) {
						uncertain = true;
						continue;
					}
					if (modified < start) continue;
					segment ||= isSegment;
					init ||= isInit;
				}
				if (segment && init) return "ready";
				if (!result.nextCursor) return uncertain ? "unobservable" : "awaiting";
				if (cursors.has(result.nextCursor)) return "unobservable";
				cursors.add(result.nextCursor);
				cursor = result.nextCursor;
			}
			return "unobservable";
		} catch {
			// No SDK messages, paths, URLs or credentials in customer responses.
			return "unobservable";
		} finally {
			browser?.dispose?.();
		}
	}

	const results: State[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(2, total) }, async () => {
			while (next < total) {
				const target = targets[next++];
				if (target) results.push(await inspect(target));
			}
		}),
	);
	const ready = results.filter((state) => state === "ready").length;
	return {
		kind:
			now() >= expiresAt || results.includes("unobservable")
				? "unobservable"
				: ready === total
					? "ready"
					: "awaiting",
		ready,
		total,
		expiresAt,
	};
}
