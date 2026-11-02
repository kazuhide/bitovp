import { expect, it } from "vitest";
import { nativeDeviceInfoSchema } from "./native-device-info";
import { NATIVE_OFFICIAL_REVISION } from "./native-receipt";

const fixture = () => ({
	schemaVersion: 1,
	sourceSha256: "a".repeat(64),
	binarySha256: "b".repeat(64),
	officialSourceRevision: NATIVE_OFFICIAL_REVISION,
	backend: "cuda",
	device: {
		index: 0,
		name: "Example GPU",
		uuid: "0123456789abcdef0123456789abcdef",
		vendorId: 0x10de,
		deviceId: 0,
		integrated: false,
		memoryBudgetBytes: 8 * 1024 ** 3,
		memoryTotalBytes: 16 * 1024 ** 3,
		memoryAvailableBytes: 8 * 1024 ** 3,
		driverVersion: "example-driver-build",
		driverVersionKnown: true,
		driverVersionSource: "sysfs",
		memoryAvailableSource: "cudaMemGetInfo",
		memoryHeapIndex: null,
		pciBusId: "0000:01:00.0",
	},
	capabilities: { inflightFrames: [1, 2, 4], cpuParity: true },
});

it("distinguishes physical capacity, current headroom and unavailable information", () => {
	expect(nativeDeviceInfoSchema.parse(fixture()).device.memoryTotalBytes).toBe(
		16 * 1024 ** 3,
	);
	const unknown = fixture();
	expect(
		nativeDeviceInfoSchema.parse({
			...unknown,
			device: {
				...unknown.device,
				memoryAvailableBytes: null,
				driverVersionKnown: false,
				driverVersion: "unknown",
				pciBusId: null,
			},
		}).device.memoryAvailableBytes,
	).toBeNull();
	expect(
		nativeDeviceInfoSchema.parse({
			...unknown,
			device: { ...unknown.device, memoryAvailableBytes: 0 },
		}).device.memoryAvailableBytes,
	).toBe(0);
});

it("rejects invalid resource bounds and incompatible hardware protocols", () => {
	const valid = fixture();
	for (const device of [
		{ ...valid.device, memoryTotalBytes: 0 },
		{ ...valid.device, memoryTotalBytes: null },
		{ ...valid.device, memoryAvailableBytes: -1 },
		{ ...valid.device, memoryAvailableBytes: 32 * 1024 ** 3 },
		{ ...valid.device, memoryAvailableBytes: Number.POSITIVE_INFINITY },
		{ ...valid.device, index: 257 },
		{ ...valid.device, pciBusId: "another/device" },
		{ ...valid.device, unrecognizedResource: 1 },
	])
		expect(nativeDeviceInfoSchema.safeParse({ ...valid, device }).success).toBe(
			false,
		);
	for (const patch of [
		{ schemaVersion: 2 },
		{ officialSourceRevision: "c".repeat(40) },
		{ binarySha256: "unverified" },
		{ backend: "cpu" },
		{ capabilities: { inflightFrames: [1, 3], cpuParity: true } },
		{ capabilities: { inflightFrames: [1, 1], cpuParity: true } },
		{ capabilities: { inflightFrames: [2, 4], cpuParity: true } },
		{ capabilities: { inflightFrames: [1, 2, 4], cpuParity: false } },
	])
		expect(
			nativeDeviceInfoSchema.safeParse({ ...valid, ...patch }).success,
		).toBe(false);
});
