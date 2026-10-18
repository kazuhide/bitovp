type IpAddress = { family: 4 | 6; bits: 32 | 128; value: bigint; text: string };

function ipv4(raw: string): IpAddress | null {
	const parts = raw.split(".");
	if (
		parts.length !== 4 ||
		parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)
	)
		return null;
	return {
		family: 4,
		bits: 32,
		value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n),
		text: parts.join("."),
	};
}

function parseIp(raw: string): IpAddress | null {
	if (!raw || raw !== raw.trim() || raw.length > 64 || /[%[\]\s]/.test(raw))
		return null;
	if (!raw.includes(":")) return ipv4(raw);
	let input = raw.toLowerCase();
	if (input.includes(".")) {
		const last = input.lastIndexOf(":");
		const tail = ipv4(input.slice(last + 1));
		if (!tail) return null;
		input = `${input.slice(0, last + 1)}${(tail.value >> 16n).toString(16)}:${(tail.value & 65535n).toString(16)}`;
	}
	const halves = input.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	if ([...left, ...right].some((part) => !/^[a-f0-9]{1,4}$/.test(part)))
		return null;
	const missing = 8 - left.length - right.length;
	if (
		(halves.length === 1 && missing !== 0) ||
		(halves.length === 2 && missing < 1)
	)
		return null;
	const parts = [
		...left,
		...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
		...right,
	];
	const value = parts.reduce((n, p) => (n << 16n) | BigInt(`0x${p}`), 0n);
	if (value >> 32n === 65535n) {
		return ipv4(
			[24n, 16n, 8n, 0n]
				.map((shift) => ((value >> shift) & 255n).toString())
				.join("."),
		);
	}
	return {
		family: 6,
		bits: 128,
		value,
		text: parts.map((p) => Number.parseInt(p, 16).toString(16)).join(":"),
	};
}

function parseCidr(raw: string) {
	const parts = raw.split("/");
	if (parts.length > 2) return null;
	const address = parseIp(parts[0] ?? "");
	if (!address) return null;
	let prefix: number = address.bits;
	if (parts.length === 2) {
		if (!/^(0|[1-9]\d{0,2})$/.test(parts[1] ?? "")) return null;
		prefix = Number(parts[1]);
		if (address.family === 4 && raw.includes(":")) prefix -= 96;
	}
	if (prefix < 0 || prefix > address.bits) return null;
	const shift = BigInt(address.bits - prefix);
	return { address, prefix, shift, network: address.value >> shift };
}

export function normalizeClientIp(raw: string): string | null {
	return parseIp(raw)?.text ?? null;
}

export function validateIpCidrs(cidrs: readonly string[]): boolean {
	return cidrs.length <= 100 && cidrs.every((cidr) => parseCidr(cidr) !== null);
}

export function normalizeAllowedIpCidrs(cidrs: readonly string[]): string[] {
	if (!validateIpCidrs(cidrs))
		throw new Error("Invalid IP address or CIDR range");
	return [
		...new Set(
			cidrs.map((raw) => {
				const parsed = parseCidr(raw);
				if (!parsed) throw new Error("Invalid IP address or CIDR range");
				return `${parsed.address.text}/${parsed.prefix}`;
			}),
		),
	];
}

/** A configured policy fails closed on malformed addresses or ranges. */
export function ipAllowedByPolicy(
	cidrs: readonly string[],
	ip: string | null,
): boolean {
	if (cidrs.length === 0) return true;
	if (!validateIpCidrs(cidrs) || !ip) return false;
	const address = parseIp(ip);
	if (!address) return false;
	return cidrs.some((cidr) => {
		const range = parseCidr(cidr);
		return (
			range !== null &&
			range.address.family === address.family &&
			address.value >> range.shift === range.network
		);
	});
}
