import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { localSemanticStageRegistry } from "@bitovp/core";

const [output, ...extra] = process.argv.slice(2);
if (!output || extra.length)
	throw new Error("Usage: write-local-semantic-stages.ts OUTPUT.json");
writeFileSync(
	resolve(output),
	`${JSON.stringify(localSemanticStageRegistry(), null, 2)}\n`,
);
console.log("Local semantic stage registry written.");
