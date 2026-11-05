import type { VmafExecution } from "@bitovp/core";
import { NATIVE_MODEL_SHA256 } from "./native-contract";

type CpuReason =
	| "GPU_NOT_AVAILABLE"
	| "GPU_RUNTIME_UNAVAILABLE"
	| "GPU_MODEL_UNSUPPORTED"
	| "GPU_GATE_CPU_ONLY";
export type NativeLocalSelection = {
	backend: "cuda" | "vulkan";
	device: number;
	identity: {
		sourceSha256: string;
		binarySha256: string;
		supervisorBinarySha256: string;
		deviceUuid: string;
	};
};
export type LocalSelection = { version: 1; model: string } & (
	| { requested: "CPU"; backend: "cpu" }
	| { requested: "AUTO"; backend: "cpu"; reason: CpuReason }
	| ({ requested: "AUTO" } & NativeLocalSelection)
);
export type SelectLocalNative = (request: {
	signal: AbortSignal;
	pinned?: NativeLocalSelection;
}) => Promise<
	NativeLocalSelection | { backend: "cpu"; reason: "GPU_NOT_AVAILABLE" }
>;

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function keys(value: Record<string, unknown>, expected: string[]) {
	return (
		JSON.stringify(Object.keys(value).sort()) ===
		JSON.stringify(expected.sort())
	);
}
function native(value: unknown): NativeLocalSelection | undefined {
	const raw = object(value);
	const identity = object(raw?.identity);
	const sha = /^[a-f0-9]{64}$/;
	if (
		!raw ||
		!keys(raw, ["backend", "device", "identity"]) ||
		(raw.backend !== "cuda" && raw.backend !== "vulkan") ||
		typeof raw.device !== "number" ||
		!Number.isSafeInteger(raw.device) ||
		raw.device < 0 ||
		raw.device > 256 ||
		!identity ||
		!keys(identity, [
			"sourceSha256",
			"binarySha256",
			"supervisorBinarySha256",
			"deviceUuid",
		]) ||
		![
			identity.sourceSha256,
			identity.binarySha256,
			identity.supervisorBinarySha256,
		].every((hash) => typeof hash === "string" && sha.test(hash)) ||
		typeof identity.deviceUuid !== "string" ||
		identity.deviceUuid.length < 1 ||
		identity.deviceUuid.length > 512
	)
		return undefined;
	return {
		backend: raw.backend,
		device: raw.device,
		identity: {
			sourceSha256: identity.sourceSha256 as string,
			binarySha256: identity.binarySha256 as string,
			supervisorBinarySha256: identity.supervisorBinarySha256 as string,
			deviceUuid: identity.deviceUuid,
		},
	};
}
function parseStored(value: unknown): LocalSelection {
	const raw = object(value);
	if (
		raw?.version !== 1 ||
		typeof raw.model !== "string" ||
		!raw.model ||
		raw.model.length > 128
	)
		throw new Error("VMAF_LOCAL_SELECTION_INVALID");
	const base = { version: 1 as const, model: raw.model };
	if (raw.backend === "cpu") {
		if (
			raw.requested === "CPU" &&
			keys(raw, ["version", "model", "requested", "backend"])
		)
			return { ...base, requested: "CPU", backend: "cpu" };
		if (
			raw.requested === "AUTO" &&
			keys(raw, ["version", "model", "requested", "backend", "reason"]) &&
			typeof raw.reason === "string" &&
			[
				"GPU_NOT_AVAILABLE",
				"GPU_RUNTIME_UNAVAILABLE",
				"GPU_MODEL_UNSUPPORTED",
				"GPU_GATE_CPU_ONLY",
			].includes(raw.reason)
		)
			return {
				...base,
				requested: "AUTO",
				backend: "cpu",
				reason: raw.reason as CpuReason,
			};
	} else if (
		raw.requested === "AUTO" &&
		keys(raw, [
			"version",
			"model",
			"requested",
			"backend",
			"device",
			"identity",
		])
	) {
		const selected = native({
			backend: raw.backend,
			device: raw.device,
			identity: raw.identity,
		});
		if (selected) return { ...base, requested: "AUTO", ...selected };
	}
	throw new Error("VMAF_LOCAL_SELECTION_INVALID");
}

/** Availability chooses CPU only before scoring. A resumed row keeps its
 * method, native build and actual device, even if hardware availability changes. */
export async function resolveLocalSelection(
	deps: { selectNative?: SelectLocalNative; nativeFailure?: Error },
	request: {
		execution: VmafExecution;
		model: string;
		gate: boolean;
		stored?: unknown;
		signal: AbortSignal;
	},
): Promise<LocalSelection | undefined> {
	const { execution, model, signal } = request;
	signal.throwIfAborted();
	const requested =
		execution.backend === "LOCAL" ? execution.localMode : undefined;
	if (!requested) {
		if (request.stored !== undefined)
			throw new Error("VMAF_LOCAL_SELECTION_CHANGED");
		return undefined;
	}
	let stored: LocalSelection | undefined;
	if (request.stored !== undefined) {
		stored = parseStored(request.stored);
		if (stored.requested !== requested || stored.model !== model)
			throw new Error("VMAF_LOCAL_SELECTION_CHANGED");
		// A CPU fallback stays CPU even if a GPU later becomes available.
		if (stored.backend === "cpu") return stored;
	}
	if (requested === "CPU")
		return { version: 1, requested, model, backend: "cpu" };
	const cpu = (reason: CpuReason): LocalSelection => ({
		version: 1,
		requested,
		model,
		backend: "cpu",
		reason,
	});
	if (stored && stored.backend !== "cpu") {
		if (deps.nativeFailure) throw deps.nativeFailure;
		if (request.gate || !deps.selectNative)
			throw new Error("VMAF_LOCAL_SELECTION_UNAVAILABLE");
		const pinned: NativeLocalSelection = {
			backend: stored.backend,
			device: stored.device,
			identity: stored.identity,
		};
		const original = JSON.stringify(pinned);
		const current = native(await deps.selectNative({ signal, pinned }));
		signal.throwIfAborted();
		if (!current || JSON.stringify(current) !== original)
			throw new Error("VMAF_LOCAL_SELECTION_CHANGED");
		return stored;
	}
	if (request.gate) return cpu("GPU_GATE_CPU_ONLY");
	if (!Object.hasOwn(NATIVE_MODEL_SHA256, model))
		return cpu("GPU_MODEL_UNSUPPORTED");
	if (deps.nativeFailure) throw deps.nativeFailure;
	if (!deps.selectNative) return cpu("GPU_RUNTIME_UNAVAILABLE");
	const selected = await deps.selectNative({ signal });
	signal.throwIfAborted();
	if (selected.backend === "cpu" && selected.reason === "GPU_NOT_AVAILABLE")
		return cpu(selected.reason);
	const parsed = native(selected);
	if (!parsed) throw new Error("VMAF_LOCAL_SELECTION_INVALID");
	return { version: 1, requested, model, ...parsed };
}

/** CAMBI owns its own pinned selection. Its official CPU oracle judges gates;
 * the VMAF gate/model restrictions above remain unchanged. */
export async function resolveBandingSelection(
	deps: {
		selectNative?: SelectLocalNative;
		nativeFailure?: Error;
		available?: (
			selected: NativeLocalSelection,
			signal: AbortSignal,
		) => Promise<boolean>;
	},
	request: { execution: VmafExecution; stored?: unknown; signal: AbortSignal },
): Promise<LocalSelection> {
	const { execution, signal } = request;
	signal.throwIfAborted();
	if (execution.backend !== "LOCAL")
		throw new Error("BANDING_CLOUD_UNSUPPORTED");
	const requested = execution.localMode ?? "CPU";
	const base = { version: 1 as const, model: "CAMBI", requested };
	const stored =
		request.stored === undefined ? undefined : parseStored(request.stored);
	if (stored && (stored.model !== "CAMBI" || stored.requested !== requested))
		throw new Error("BANDING_LOCAL_SELECTION_CHANGED");
	if (
		stored?.backend === "cpu" &&
		"reason" in stored &&
		!["GPU_NOT_AVAILABLE", "GPU_RUNTIME_UNAVAILABLE"].includes(stored.reason)
	)
		throw new Error("BANDING_LOCAL_SELECTION_INVALID");
	if (stored?.backend === "cpu") return stored;
	if (requested === "CPU") return { ...base, requested, backend: "cpu" };
	if (deps.nativeFailure) throw deps.nativeFailure;
	const fallback = (): LocalSelection => ({
		...base,
		requested: "AUTO",
		backend: "cpu",
		reason: "GPU_RUNTIME_UNAVAILABLE",
	});
	if (!deps.selectNative || !deps.available) {
		if (stored) throw new Error("BANDING_LOCAL_SELECTION_UNAVAILABLE");
		return fallback();
	}
	const pinned = stored
		? {
				backend: stored.backend,
				device: stored.device,
				identity: stored.identity,
			}
		: undefined;
	const selected = await deps.selectNative({
		signal,
		...(pinned ? { pinned } : {}),
	});
	signal.throwIfAborted();
	if (selected.backend === "cpu") {
		if (stored) throw new Error("BANDING_LOCAL_SELECTION_UNAVAILABLE");
		if (selected.reason !== "GPU_NOT_AVAILABLE")
			throw new Error("BANDING_LOCAL_SELECTION_INVALID");
		return {
			...base,
			requested: "AUTO",
			backend: "cpu",
			reason: selected.reason,
		};
	}
	const parsed = native(selected);
	if (!parsed) throw new Error("BANDING_LOCAL_SELECTION_INVALID");
	if (pinned && JSON.stringify(parsed) !== JSON.stringify(pinned))
		throw new Error("BANDING_LOCAL_SELECTION_CHANGED");
	if (!(await deps.available(parsed, signal))) {
		if (stored) throw new Error("BANDING_LOCAL_SELECTION_UNAVAILABLE");
		return fallback();
	}
	signal.throwIfAborted();
	return { ...base, requested: "AUTO", ...parsed };
}
