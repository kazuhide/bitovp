import { z } from "zod";
import { NATIVE_OFFICIAL_REVISION } from "./native-receipt";

const bytes = z.number().int().nonnegative().safe();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Read-only hardware information, separate from a measurement receipt. */
export const nativeDeviceInfoSchema = z
	.object({
		schemaVersion: z.literal(1),
		sourceSha256: sha256,
		binarySha256: sha256.nullable(),
		officialSourceRevision: z.literal(NATIVE_OFFICIAL_REVISION),
		backend: z.enum(["cuda", "vulkan"]),
		device: z
			.object({
				index: bytes.max(256),
				name: z.string().min(1).max(512),
				uuid: z.string().min(1).max(128),
				vendorId: bytes.positive().max(65535),
				deviceId: bytes,
				integrated: z.boolean(),
				memoryBudgetBytes: bytes,
				memoryTotalBytes: bytes.positive().nullable(),
				memoryAvailableBytes: bytes.nullable(),
				driverVersion: z.string().min(1).max(1024),
				driverVersionKnown: z.boolean(),
				driverVersionSource: z.string().min(1).max(128),
				memoryAvailableSource: z.string().min(1).max(128),
				memoryHeapIndex: bytes.nullable().optional(),
				pciBusId: z
					.string()
					.regex(/^[a-f0-9]{4}:[a-f0-9]{2}:[a-f0-9]{2}\.[0-7]$/i)
					.nullable(),
			})
			.strict()
			.refine(
				(device) =>
					device.memoryAvailableBytes === null ||
					(device.memoryTotalBytes !== null &&
						device.memoryAvailableBytes <= device.memoryTotalBytes),
				"Available GPU memory exceeds its physical capacity",
			),
		capabilities: z
			.object({
				inflightFrames: z
					.array(z.union([z.literal(1), z.literal(2), z.literal(4)]))
					.min(1)
					.max(3)
					.refine(
						(values) =>
							values.includes(1) && new Set(values).size === values.length,
						"Frame concurrency must include the serial path without duplicates",
					),
				cpuParity: z.literal(true),
				processSupervisor: z.boolean().optional(),
				supervisorBinarySha256: sha256.nullable().optional(),
			})
			.strict(),
	})
	.strict();

export type NativeDeviceInfo = z.infer<typeof nativeDeviceInfoSchema>;
