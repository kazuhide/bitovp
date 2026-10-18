import { MasterKeyConfigError, SecretDecryptError } from "@bitovp/core";
import { VmafProfileError } from "@bitovp/db";
import { jsonError, routeError } from "./http";

/** Never log ORM/validation errors: these operations receive write-only secrets. */
export function vmafSettingsError(error: unknown) {
	if (error instanceof VmafProfileError)
		return jsonError(
			error.code === "CONFLICT" ? 409 : 400,
			error.code === "CONFLICT"
				? "Configuration changed; reload before saving"
				: error.code === "CREDENTIAL"
					? "Credential is missing, disabled, or incompatible"
					: "Invalid VMAF profile configuration",
		);
	if (
		error instanceof MasterKeyConfigError ||
		error instanceof SecretDecryptError ||
		(error as { code?: string })?.code === "P2025"
	)
		return routeError(error);
	return jsonError(500, "VMAF settings operation failed");
}
