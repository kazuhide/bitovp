import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
	ipAllowedByPolicy,
	normalizeClientIp,
	validateIpCidrs,
} from "@bitovp/core";

export const CLIENT_IP_HEADER = "x-bitovp-client-ip";
export const CLIENT_IP_PROOF_HEADER = "x-bitovp-client-ip-proof";

/** Walk from the actual socket peer; an untrusted hop ends forwarding trust. */
export function connectionClientIp(
	peer: string | undefined,
	forwarded: string | undefined,
	trusted: readonly string[],
): string | null {
	if (!validateIpCidrs(trusted)) throw new Error("Invalid TRUSTED_PROXY_CIDRS");
	let address = peer ? normalizeClientIp(peer) : null;
	if (!address || trusted.length === 0 || !ipAllowedByPolicy(trusted, address))
		return address;
	if (!forwarded || forwarded.length > 2048) return null;
	const chain = forwarded.split(",");
	if (chain.length > 32) return null;
	for (let i = chain.length - 1; i >= 0; i--) {
		if (!ipAllowedByPolicy(trusted, address)) break;
		address = normalizeClientIp(chain[i]?.trim() ?? "");
		if (!address) return null;
	}
	return address;
}

export function ingressHeaders(
	headers: IncomingHttpHeaders,
	peer: string | undefined,
	secret: string | undefined,
	trusted: readonly string[],
): IncomingHttpHeaders {
	const next = { ...headers };
	delete next[CLIENT_IP_HEADER];
	delete next[CLIENT_IP_PROOF_HEADER];
	const forwarded =
		typeof headers["x-forwarded-for"] === "string"
			? headers["x-forwarded-for"]
			: undefined;
	const ip = connectionClientIp(peer, forwarded, trusted);
	// Next never authorizes from XFF, but overwrite it so ancillary readers agree.
	if (ip) next["x-forwarded-for"] = ip;
	else delete next["x-forwarded-for"];
	delete next["x-real-ip"];
	if (ip && secret) {
		next[CLIENT_IP_HEADER] = ip;
		next[CLIENT_IP_PROOF_HEADER] = createHmac("sha256", secret)
			.update(`client-ip\0${ip}`)
			.digest("hex");
	}
	return next;
}
