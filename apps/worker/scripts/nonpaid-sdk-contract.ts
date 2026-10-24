import { readFileSync } from "node:fs";
import { verifyNonpaidSdkContract } from "../src/testing/nonpaid-sdk-contract";

try {
	if (process.argv.length !== 3 || !process.argv[2])
		throw new Error("One evidence file is required");
	const input: unknown = JSON.parse(readFileSync(process.argv[2], "utf8"));
	console.log(JSON.stringify(await verifyNonpaidSdkContract(input)));
} catch {
	// Evidence may contain synthetic secrets; never print input or assertion diffs.
	console.error(
		JSON.stringify({
			version: 1,
			status: "failed",
			reason: "contract-mismatch",
		}),
	);
	process.exitCode = 1;
}
