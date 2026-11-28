import { z } from "zod";

export const nativeOperationUuid = z.uuid().toLowerCase();
export const NATIVE_OPERATION_KEY_CONFLICT = "NATIVE_OPERATION_KEY_CONFLICT";

const account = {
	bitmovinAccountId: nativeOperationUuid,
	scopeVersion: nativeOperationUuid,
};
const name = z
	.string()
	.trim()
	.min(1)
	.max(180)
	.regex(/^[^\p{Cc}$]+$/u);
const secret = z.string().min(1).max(4096);
const host = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(
		/^(?:(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?|\[[a-f\d:]+\])$/i,
	);
const port = z.int().min(1).max(65535).optional();
const username = secret.optional();
const password = secret.optional();
const network = { name, host, port, username, password };
const ftp = { ...network, passive: z.boolean().optional() };
const fullPath = z
	.string()
	.trim()
	.min(1)
	.max(768)
	.regex(/^[^\\%\p{Cc}?#$]+$/u);
function hasPathSegments(value: string) {
	return value
		.split("/")
		.every((segment) => segment && segment !== "." && segment !== "..");
}
const relativePath = fullPath
	.transform((value) => value.replace(/\/$/, ""))
	.refine(hasPathSegments);
const localPath = fullPath.refine(
	(value) =>
		value.startsWith("/") && hasPathSegments(value.slice(1).replace(/\/$/, "")),
);
const pathPair = {
	name,
	inputId: nativeOperationUuid,
	inputPath: relativePath,
	outputId: nativeOperationUuid,
	outputPath: relativePath,
};
const target = {
	resourceId: nativeOperationUuid,
	confirmId: nativeOperationUuid,
};
const matchedTarget = ({
	resourceId,
	confirmId,
}: {
	resourceId: string;
	confirmId: string;
}) => resourceId === confirmId;
const matchedCredentials = ({
	username,
	password,
}: {
	username?: string;
	password?: string;
}) => (username === undefined) === (password === undefined);

function remove<A extends string>(action: A) {
	return z
		.strictObject({ ...account, action: z.literal(action), ...target })
		.refine(matchedTarget);
}

export const nativeOperationSchema = z.discriminatedUnion("action", [
	z
		.strictObject({
			...account,
			action: z.literal("create-aspera-input"),
			name,
			host,
			username,
			password,
			token: secret.optional(),
			sshPort: port,
			faspPort: port,
		})
		.refine((row) =>
			row.token !== undefined
				? row.username === undefined && row.password === undefined
				: row.username !== undefined && row.password !== undefined,
		),
	remove("delete-aspera-input"),
	z.strictObject({
		...account,
		action: z.literal("create-direct-upload"),
		name,
	}),
	remove("delete-direct-upload"),
	z
		.strictObject({ ...account, action: z.literal("create-ftp-input"), ...ftp })
		.refine(matchedCredentials),
	remove("delete-ftp-input"),
	z
		.strictObject({
			...account,
			action: z.literal("create-http-input"),
			...network,
		})
		.refine(matchedCredentials),
	remove("delete-http-input"),
	z.strictObject({
		...account,
		action: z.literal("create-local-input"),
		name,
		path: localPath,
	}),
	remove("delete-local-input"),
	z
		.strictObject({
			...account,
			action: z.literal("create-sftp-input"),
			...network,
		})
		.refine(matchedCredentials),
	remove("delete-sftp-input"),
	z
		.strictObject({
			...account,
			action: z.literal("create-ftp-output"),
			...ftp,
		})
		.refine(matchedCredentials),
	remove("delete-ftp-output"),
	z.strictObject({
		...account,
		action: z.literal("create-local-output"),
		name,
		path: localPath,
	}),
	remove("delete-local-output"),
	z.strictObject({
		...account,
		action: z.literal("create-azure-captions"),
		name,
		region: z
			.string()
			.trim()
			.regex(/^[a-z0-9]{2,40}$/),
		language: z
			.string()
			.trim()
			.regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){1,5}$/),
		subscriptionKey: secret,
	}),
	remove("delete-azure-captions"),
	z.strictObject({
		...account,
		action: z.literal("create-template"),
		...pathPair,
	}),
	remove("delete-template"),
	z
		.strictObject({
			...account,
			action: z.literal("start-template"),
			...pathPair,
			confirmId: nativeOperationUuid,
			acceptCharges: z.literal(true),
		})
		.refine((row) => row.confirmId === row.outputId),
	z.strictObject({
		...account,
		action: z.literal("create-watch-folder"),
		...pathPair,
	}),
	remove("delete-watch-folder"),
	z
		.strictObject({
			...account,
			action: z.literal("start-watch-folder"),
			...target,
			acceptCharges: z.literal(true),
		})
		.refine(matchedTarget),
	remove("stop-watch-folder"),
	z
		.strictObject({
			...account,
			action: z.literal("check-s3-output"),
			...target,
			path: relativePath,
			acceptWrite: z.literal(true),
		})
		.refine(matchedTarget),
]);

export type NativeOperation = z.infer<typeof nativeOperationSchema>;
export type NativeOperationAction = NativeOperation["action"];

export const nativeOperationActions = nativeOperationSchema.options.map(
	(option) => option.shape.action.value,
);

export type NativeOperationTarget = Pick<
	NativeOperation,
	"bitmovinAccountId" | "scopeVersion"
>;
export type NativeOperationState =
	| "PENDING"
	| "ACCEPTED"
	| "REJECTED"
	| "UNKNOWN";
export type NativeOperationOutcome = {
	state: Exclude<NativeOperationState, "PENDING">;
	providerId?: string;
	passed?: boolean;
};
export type NativeOperationReceipt = {
	id: string;
	action: string;
	state: string;
	targetId: string | null;
	providerId: string | null;
	passed: boolean | null;
	createdAt: string;
};
