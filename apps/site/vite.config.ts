import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { SITE_BASE } from "./src/site-config";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	base: SITE_BASE,
	plugins: [react()],
	envPrefix: "BITOVP_SITE_PUBLIC_",
	resolve: {
		alias: [
			{
				find: "next/navigation",
				replacement: local("./src/shims/navigation.ts"),
			},
			{ find: "next/link", replacement: local("./src/shims/link.tsx") },
			{ find: "next/image", replacement: local("./src/shims/image.tsx") },
			{
				find: /^(?:@\/components\/|\.\/)session-menu$/,
				replacement: local("./src/shims/session-menu.tsx"),
			},
			{ find: "@", replacement: local("../web/src") },
		],
		dedupe: ["react", "react-dom", "@tanstack/react-query"],
	},
	css: { postcss: { plugins: [tailwindcss()] } },
	server: { fs: { allow: [local("../..")] } },
	build: { sourcemap: false },
});
