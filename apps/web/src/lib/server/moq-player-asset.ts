import "server-only";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const OFFICIAL_SHA256 =
	"38c57dda461817fea186144468d70e9f1b9d2f642178cfece0cf8101bfc1a904";
const MAX_BYTES = 2 * 1024 * 1024;
type BundleEnvironment = {
	BITOVP_MOQ_PLAYER_BUNDLE_PATH?: string;
	BITOVP_MOQ_PLAYER_BUNDLE_SHA256?: string;
};

/** Only operator environment configuration can select these local bytes. */
export async function readMoqPlayerBundle(
	env: BundleEnvironment = {
		BITOVP_MOQ_PLAYER_BUNDLE_PATH: process.env.BITOVP_MOQ_PLAYER_BUNDLE_PATH,
		BITOVP_MOQ_PLAYER_BUNDLE_SHA256:
			process.env.BITOVP_MOQ_PLAYER_BUNDLE_SHA256,
	},
): Promise<ArrayBuffer> {
	try {
		const path = env.BITOVP_MOQ_PLAYER_BUNDLE_PATH;
		const digest = (
			env.BITOVP_MOQ_PLAYER_BUNDLE_SHA256 ?? OFFICIAL_SHA256
		).toLowerCase();
		if (!path || !/^[a-f0-9]{64}$/.test(digest)) throw new Error();
		const file = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
			// Read at most the budget plus one byte, even if the file grows after stat.
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(
					buffer,
					length,
					buffer.length - length,
					length,
				);
				if (bytesRead === 0) break;
				length += bytesRead;
			}
			if (length > MAX_BYTES || length !== stat.size) throw new Error();
			const bytes = buffer.subarray(0, length);
			if (createHash("sha256").update(bytes).digest("hex") !== digest)
				throw new Error();
			return Uint8Array.from(bytes).buffer;
		} finally {
			await file.close();
		}
	} catch {
		throw new Error("MoQ player bundle unavailable");
	}
}
