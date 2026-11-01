import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { type NativeDeviceInfo, nativeDeviceInfoSchema } from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";
import { verifiedFileIdentity } from "./file-identity";
import { nativeSourceFromVersion } from "./native-contract";

export async function resolveNativeExecutable(path: string) {
	if (!path.trim()) throw new Error("NATIVE_EXECUTABLE_UNAVAILABLE");
	const candidates =
		isAbsolute(path) || path.includes("/")
			? [resolve(path)]
			: (process.env.PATH ?? "")
					.split(delimiter)
					.filter(Boolean)
					.map((directory) => resolve(directory, path));
	for (const candidate of candidates) {
		try {
			if (!(await stat(candidate)).isFile()) continue;
			await access(candidate, constants.X_OK);
			return await realpath(candidate);
		} catch {
			// A later PATH entry may provide the selected executable.
		}
	}
	throw new Error("NATIVE_EXECUTABLE_UNAVAILABLE");
}

/** Identity is verified on each inspection; changing headroom is never cached. */
export async function inspectNativeDevice(
	deps: { runner: ProcessRunner; nativePath: string },
	selection: { backend: "cuda" | "vulkan"; device?: number },
	signal?: AbortSignal,
): Promise<{ executable: string; info: NativeDeviceInfo; cacheable: boolean }> {
	signal?.throwIfAborted();
	if (
		selection.device !== undefined &&
		(!Number.isSafeInteger(selection.device) ||
			selection.device < 0 ||
			selection.device > 256)
	)
		throw new Error("NATIVE_DEVICE_SELECTION_INVALID");
	const executable = await resolveNativeExecutable(deps.nativePath);
	const before = await verifiedFileIdentity(executable);
	signal?.throwIfAborted();
	const version = await deps.runner.run(executable, ["--version"], {
		signal,
		abortKillAfterMs: 250,
	});
	signal?.throwIfAborted();
	if (version.code !== 0) throw new Error("NATIVE_BINARY_UNAVAILABLE");
	const source = nativeSourceFromVersion(version.stdout);
	const probe = await deps.runner.run(
		executable,
		[
			"--device-info",
			"--backend",
			selection.backend,
			...(selection.device === undefined
				? []
				: ["--device", String(selection.device)]),
			"--vendor",
			selection.backend === "cuda" ? "nvidia" : "amd",
		],
		{ signal, abortKillAfterMs: 250 },
	);
	signal?.throwIfAborted();
	if (probe.code !== 0) throw new Error("NATIVE_DEVICE_INFO_UNAVAILABLE");
	let raw: unknown;
	try {
		raw = JSON.parse(probe.stdout);
	} catch {
		throw new Error("NATIVE_DEVICE_INFO_INVALID_JSON");
	}
	const parsed = nativeDeviceInfoSchema.safeParse(raw);
	if (!parsed.success) throw new Error("NATIVE_DEVICE_INFO_PROTOCOL_MISMATCH");
	const info = parsed.data;
	const after = await verifiedFileIdentity(executable);
	signal?.throwIfAborted();
	if (
		after.sha256 !== before.sha256 ||
		info.sourceSha256 !== source ||
		(info.binarySha256 !== null && info.binarySha256 !== before.sha256)
	)
		throw new Error("NATIVE_DEVICE_INFO_BUILD_MISMATCH");
	if (
		info.backend !== selection.backend ||
		(selection.device !== undefined &&
			info.device.index !== selection.device) ||
		info.device.vendorId !== (selection.backend === "cuda" ? 0x10de : 0x1002)
	)
		throw new Error("NATIVE_DEVICE_INFO_SELECTION_MISMATCH");
	return {
		executable,
		info,
		cacheable: info.binarySha256 !== null && info.device.driverVersionKnown,
	};
}

export type NativeAutoWorkload = {
	model: string;
	modelSha256: string;
	width: number;
	height: number;
	referenceWidth: number;
	referenceHeight: number;
	distortedWidth: number;
	distortedHeight: number;
	referenceBitDepth: number;
	distortedBitDepth: number;
	referenceCodec: string;
	distortedCodec: string;
	fps: number;
	cpuCapacity: number;
	hostCapacityBytes: number;
};

/** A profile is performance advice for these settings, never a parity waiver. */
export function nativeAutoProfileKey(
	info: NativeDeviceInfo,
	work: NativeAutoWorkload,
): string {
	const sha = /^[a-f0-9]{64}$/;
	const dimensions = [
		work.width,
		work.height,
		work.referenceWidth,
		work.referenceHeight,
		work.distortedWidth,
		work.distortedHeight,
	];
	if (
		!sha.test(work.modelSha256) ||
		!work.model ||
		dimensions.some((n) => !Number.isSafeInteger(n) || n <= 0 || n > 16384) ||
		![work.referenceBitDepth, work.distortedBitDepth].every((n) =>
			[8, 10, 12, 16].includes(n),
		) ||
		![work.fps, work.cpuCapacity, work.hostCapacityBytes].every(
			(n) => Number.isFinite(n) && n > 0,
		) ||
		!Number.isSafeInteger(work.hostCapacityBytes) ||
		![work.referenceCodec, work.distortedCodec].every((codec) =>
			/^[a-z0-9_-]{1,64}$/.test(codec),
		)
	)
		throw new Error("NATIVE_AUTO_PROFILE_SETTINGS_INVALID");
	return createHash("sha256")
		.update(
			JSON.stringify([
				"bitovp-native-auto-v1",
				info.sourceSha256,
				info.binarySha256,
				info.capabilities.supervisorBinarySha256 ?? null,
				info.backend,
				info.device.uuid,
				info.device.driverVersion,
				info.device.driverVersionKnown,
				"software-decode",
				"mandatory-cpu-parity",
				"comparison-10-bit",
				work.model,
				work.modelSha256,
				...dimensions,
				work.referenceBitDepth,
				work.distortedBitDepth,
				work.referenceCodec,
				work.distortedCodec,
				work.fps,
				work.cpuCapacity,
				work.hostCapacityBytes,
			]),
		)
		.digest("hex");
}

/** PCI identity joins APIs on one host; UUID remains the safe missing-PCI key. */
export function nativePhysicalDeviceKey(
	info: NativeDeviceInfo,
	hostKey: string,
) {
	if (!/^[a-f0-9]{64}$/.test(hostKey))
		throw new Error("VMAF_RESOURCE_HOST_ID_INVALID");
	return createHash("sha256")
		.update(
			JSON.stringify(
				info.device.pciBusId !== null
					? ["host-pci", hostKey, info.device.pciBusId.toLowerCase()]
					: ["gpu-uuid", info.device.vendorId, info.device.uuid.toLowerCase()],
			),
		)
		.digest("hex");
}
