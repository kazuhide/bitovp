import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeClientIp } from "@bitovp/core";

export { ipAllowedByPolicy, normalizeAllowedIpCidrs } from "@bitovp/core";

export const CLIENT_IP_HEADER = "x-bitovp-client-ip";
export const CLIENT_IP_PROOF_HEADER = "x-bitovp-client-ip-proof";

/** Proof originates at the socket-aware ingress; caller-supplied XFF is ignored. */
export function verifiedClientIp(headers: Headers): string | null {
	const raw = headers.get(CLIENT_IP_HEADER);
	const proof = headers.get(CLIENT_IP_PROOF_HEADER);
	const secret = process.env.AUTH_SESSION_SECRET;
	if (!raw || !proof || !secret || !/^[a-f0-9]{64}$/.test(proof)) return null;
	const ip = normalizeClientIp(raw);
	if (!ip || ip !== raw) return null;
	const expected = createHmac("sha256", secret)
		.update(`client-ip\0${ip}`)
		.digest("hex");
	return timingSafeEqual(
		Buffer.from(proof, "hex"),
		Buffer.from(expected, "hex"),
	)
		? ip
		: null;
}
