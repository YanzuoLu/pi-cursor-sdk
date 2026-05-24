import { accessSync, constants } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseEnvBoolean } from "./cursor-env-boolean.js";

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const DEFAULT_RENDER_TIMEOUT_MS = 15_000;
const DEFAULT_VIEWPORT = { width: 1400, height: 900 };

export type MermaidRenderResult =
	| { ok: true; pngBase64: string }
	| { ok: false; reason: string };

export type MermaidRenderHook = (source: string) => Promise<MermaidRenderResult>;

let renderHook: MermaidRenderHook | undefined;

export function isCursorMermaidImageEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return parseEnvBoolean(env.PI_CURSOR_MERMAID_IMAGE, true);
}

export function resolveMermaidRenderTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.PI_CURSOR_MERMAID_RENDER_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_RENDER_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RENDER_TIMEOUT_MS;
}

export function resolveMermaidImageWidthCells(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.PI_CURSOR_MERMAID_IMAGE_WIDTH?.trim();
	if (!raw) return 60;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

export function setMermaidRenderHookForTests(hook: MermaidRenderHook | undefined): void {
	renderHook = hook;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function buildMermaidHtml(source: string): string {
	const diagram = escapeHtml(source.trim());
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body {
    margin: 0;
    padding: 24px;
    background: #1e1e1e;
    color: #e6e6e6;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .mermaid {
    display: flex;
    justify-content: center;
  }
  .mermaid svg {
    max-width: 100%;
    height: auto;
  }
</style>
</head>
<body>
<pre class="mermaid">${diagram}</pre>
<script type="module">
import mermaid from "${MERMAID_CDN}";
mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "strict",
});
await mermaid.run({ querySelector: ".mermaid" });
</script>
</body>
</html>`;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK | constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findExecutableOnPath(names: string[]): string | undefined {
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// keep searching
			}
		}
	}
	return undefined;
}

export async function resolveChromeExecutable(
	env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
	const configured = env.PI_CURSOR_MERMAID_CHROME_PATH?.trim();
	if (configured && await isExecutable(configured)) {
		return configured;
	}

	const macCandidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	];
	for (const candidate of macCandidates) {
		if (await isExecutable(candidate)) return candidate;
	}

	return findExecutableOnPath([
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
		"chrome",
	]);
}

function runChromeScreenshot(
	chromePath: string,
	htmlPath: string,
	pngPath: string,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(chromePath, [
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--hide-scrollbars",
			`--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
			`--virtual-time-budget=${Math.max(1000, timeoutMs)}`,
			`--screenshot=${pngPath}`,
			htmlPath,
		], {
			stdio: ["ignore", "ignore", "ignore"],
		});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("mermaid chrome render timed out"));
		}, timeoutMs);

		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`mermaid chrome render exited with code ${code ?? "unknown"}`));
			}
		});
	});
}

async function renderMermaidToPngWithChrome(source: string): Promise<MermaidRenderResult> {
	const chromePath = await resolveChromeExecutable();
	if (!chromePath) {
		return { ok: false, reason: "chrome_not_found" };
	}

	const workDir = await mkdtemp(join(tmpdir(), "pi-cursor-mermaid-"));
	const htmlPath = join(workDir, "diagram.html");
	const pngPath = join(workDir, "diagram.png");
	const timeoutMs = resolveMermaidRenderTimeoutMs();

	try {
		await writeFile(htmlPath, buildMermaidHtml(source), "utf8");
		await runChromeScreenshot(chromePath, htmlPath, pngPath, timeoutMs);
		const pngBytes = await readFile(pngPath);
		if (pngBytes.length === 0) {
			return { ok: false, reason: "empty_png" };
		}
		return { ok: true, pngBase64: pngBytes.toString("base64") };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: message.slice(0, 120) };
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function renderMermaidDiagramToPng(source: string): Promise<MermaidRenderResult> {
	if (renderHook) {
		return renderHook(source);
	}
	return renderMermaidToPngWithChrome(source);
}
