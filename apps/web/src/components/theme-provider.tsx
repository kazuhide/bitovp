"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

const ThemeContext = createContext<{
	theme: Theme;
	choose: (theme: Theme) => void;
}>({ theme: "neon", choose: () => {} });

export function ThemeProvider({
	initialTheme,
	children,
}: {
	initialTheme: Theme;
	children: ReactNode;
}) {
	const [theme, setTheme] = useState(initialTheme);
	function choose(next: Theme) {
		setTheme(next);
		document.documentElement.dataset.theme = next;
		const secure = window.location.protocol === "https:" ? "; Secure" : "";
		// biome-ignore lint/suspicious/noDocumentCookie: A non-secret preference; CookieStore is not cross-browser.
		document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=63072000; SameSite=Lax${secure}`;
	}
	return (
		<ThemeContext.Provider value={{ theme, choose }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	return useContext(ThemeContext);
}
