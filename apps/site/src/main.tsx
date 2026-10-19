import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { LandingPage } from "./landing";
import "./landing.css";

const DemoApp = lazy(() => import("./demo/app"));
const isDemo = () => window.location.hash.startsWith("#/demo");

function Site() {
	const [demo, setDemo] = useState(isDemo);
	useEffect(() => {
		const changed = () => setDemo(isDemo());
		window.addEventListener("hashchange", changed);
		return () => window.removeEventListener("hashchange", changed);
	}, []);
	return demo ? (
		<Suspense fallback={<p role="status">Loading the interactive demo…</p>}>
			<DemoApp />
		</Suspense>
	) : (
		<LandingPage />
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("The site root is missing.");
if (!isDemo() && root.querySelector(".site-landing")) {
	hydrateRoot(root, <Site />);
} else {
	createRoot(root).render(<Site />);
}
