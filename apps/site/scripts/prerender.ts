import { readFile, writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { LandingPage } from "../src/landing";

const markup = renderToString(createElement(LandingPage));
const output = new URL("../dist/index.html", import.meta.url);
const html = await readFile(output, "utf8");
if (!html.includes("<!--landing-->"))
	throw new Error("Landing placeholder is missing.");
await writeFile(output, html.replace("<!--landing-->", markup));
console.log("Pre-rendered the feature guide for visitors without JavaScript.");
