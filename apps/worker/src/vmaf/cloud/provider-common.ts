import { createHash } from "node:crypto";
import type {
	CloudLaunch,
	VmafCloudProfile,
	VmafComputeAdapter,
} from "@bitovp/core";

export const WORKER_COMMAND = [
	"node",
	"--import",
	"tsx",
	"/app/apps/worker/scripts/vmaf-cloud-worker.mjs",
];
export const hashId = (value: string) =>
	createHash("sha256").update(value).digest("hex").slice(0, 40);
export const taskName = (id: string) => `vmaf-${hashId(id)}`;
export const profileHash = (profile: VmafCloudProfile) => hashId(profile.id);
export type RestDependencies = {
	fetch?: typeof fetch;
	googleToken?: () => Promise<string>;
	azureToken?: () => Promise<string>;
	akamaiToken?: () => string;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

export function launchSeconds(
	profile: VmafCloudProfile,
	launch: CloudLaunch,
	now = Date.now(),
): number {
	const url = new URL(launch.manifestUrl);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		/[\r\n]/.test(launch.manifestUrl)
	)
		throw new Error("Invalid cloud manifest URL");
	if (!/^[a-zA-Z0-9._-]{1,128}$/.test(launch.taskId))
		throw new Error("Invalid cloud task ID");
	const remaining = Math.floor((Date.parse(launch.deadline) - now) / 1000);
	if (
		!Number.isFinite(remaining) ||
		remaining < 60 ||
		remaining > profile.timeoutSeconds + profile.queueTimeoutSeconds
	)
		throw new Error("Invalid cloud deadline");
	return Math.min(profile.timeoutSeconds, remaining);
}

export function safeAdapter(adapter: VmafComputeAdapter): VmafComputeAdapter {
	const safe = async <T>(
		action: string,
		operation: () => Promise<T>,
	): Promise<T> => {
		try {
			return await operation();
		} catch {
			throw new Error(`VMAF cloud ${action} failed`);
		}
	};
	const failureReason = adapter.failureReason?.bind(adapter);
	return {
		submit: (launch) => safe("submit", () => adapter.submit(launch)),
		find: (taskId) => safe("find", () => adapter.find(taskId)),
		status: (id) => safe("status", () => adapter.status(id)),
		...(failureReason
			? {
					failureReason: (id: string) =>
						safe("failure reason", () => failureReason(id)),
				}
			: {}),
		cancel: (id) => safe("cancel", () => adapter.cancel(id)),
		cleanup: (id) => safe("cleanup", () => adapter.cleanup(id)),
	};
}

export function restClient(
	deps: RestDependencies,
	token: () => Promise<string>,
) {
	return async (
		url: string,
		method = "GET",
		body?: unknown,
		headers?: Record<string, string>,
	): Promise<Record<string, unknown> | undefined> => {
		const response = await (deps.fetch ?? fetch)(url, {
			method,
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
			headers: {
				Authorization: `Bearer ${await token()}`,
				"Content-Type": "application/json",
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (response.status === 404) {
			await response.body?.cancel();
			return undefined;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("Cloud provider request failed");
		}
		const text = await response.text();
		return text ? (JSON.parse(text) as Record<string, unknown>) : {};
	};
}

export async function waitMissing(
	read: () => Promise<unknown | undefined>,
	deps: RestDependencies,
): Promise<void> {
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let attempt = 0; attempt < 60; attempt++) {
		if ((await read()) === undefined) return;
		await sleep(2_000);
	}
	throw new Error("Cloud cleanup is not confirmed");
}

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid provider response");
	return value as Record<string, unknown>;
}

export function httpsEndpoint(value: string, suffix: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		!url.hostname.endsWith(suffix) ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!["", "/"].includes(url.pathname)
	)
		throw new Error("Invalid cloud account endpoint");
	return url.origin;
}
