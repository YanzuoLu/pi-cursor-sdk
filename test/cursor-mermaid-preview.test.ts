import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import {
	isCursorMermaidPreviewEnabled,
	renderMermaidBlockPreview,
	transformMermaidFencesInMarkdown,
	transformMermaidFencesInMarkdownAsync,
	__testUtils,
} from "../src/cursor-mermaid-preview.js";
import { registerCursorMermaidPreview } from "../src/cursor-mermaid-message.js";
import { setMermaidRenderHookForTests } from "../src/cursor-mermaid-render.js";
import {
	formatImageLinesForMarkdown,
	messageContainsMermaidImage,
} from "../src/cursor-mermaid-terminal-image.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SAMPLE_FLOWCHART = `flowchart TD
  cli[pi-fleet upgrade --latest] --> pre[Preflight shell]
  pre --> loop[For each repo in manifest]
  loop --> branch[git checkout -b chore/pi-X.Y.Z]
  branch --> agent[Agent.prompt local cwd=repo]
  agent --> validate[Run repo validate scripts]
  validate --> scope[Diff scope check]
  scope --> commit[git commit scoped files only]
  commit --> push[git push -u origin branch]
  push --> pr[gh pr create]
  pr --> report[Fleet report JSON]`;

describe("cursor-mermaid-preview", () => {
	it("renders a flowchart as an indented outline", () => {
		const preview = renderMermaidBlockPreview(SAMPLE_FLOWCHART);
		expect(preview).toContain("**Diagram preview**");
		expect(preview).toContain("- pi-fleet upgrade --latest");
		expect(preview).toContain("→ Preflight shell");
		expect(preview).toContain("→ Fleet report JSON");
	});

	it("replaces mermaid fences in markdown", () => {
		const markdown = `Architecture (local v1)

\`\`\`mermaid
${SAMPLE_FLOWCHART}
\`\`\`

Split responsibilities:`;

		const transformed = transformMermaidFencesInMarkdown(markdown);
		expect(transformed).not.toContain("```mermaid");
		expect(transformed).toContain("**Diagram preview**");
		expect(transformed).toContain("Split responsibilities:");
	});

	it("leaves non-mermaid fences unchanged", () => {
		const markdown = "```typescript\nconst x = 1;\n```";
		expect(transformMermaidFencesInMarkdown(markdown)).toBe(markdown);
	});

	it("is idempotent when preview marker is already present", () => {
		const markdown = "**Diagram preview**\n- already rendered";
		expect(transformMermaidFencesInMarkdown(markdown)).toBe(markdown);
	});

	it("respects PI_CURSOR_MERMAID_PREVIEW=0", () => {
		process.env.PI_CURSOR_MERMAID_PREVIEW = "0";
		expect(isCursorMermaidPreviewEnabled()).toBe(false);
		delete process.env.PI_CURSOR_MERMAID_PREVIEW;
		expect(isCursorMermaidPreviewEnabled()).toBe(true);
	});
});

function createMockPi() {
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => Promise<unknown>>>();
	return {
		handlers,
		pi: {
			on: (event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		},
	};
}

describe("registerCursorMermaidPreview", () => {
	beforeEach(() => {
		process.env.PI_CURSOR_MERMAID_IMAGE = "0";
		setMermaidRenderHookForTests(undefined);
	});

	afterEach(() => {
		delete process.env.PI_CURSOR_MERMAID_IMAGE;
		setMermaidRenderHookForTests(undefined);
		resetCapabilitiesCache();
	});
	it("transforms cursor assistant messages on message_end", async () => {
		const { handlers, pi } = createMockPi();
		registerCursorMermaidPreview(pi);

		const message: AssistantMessage = {
			role: "assistant",
			provider: "cursor",
			api: "cursor-sdk",
			model: "composer-2.5",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{
				type: "text",
				text: `\`\`\`mermaid\n${SAMPLE_FLOWCHART}\n\`\`\``,
			}],
		};

		const result = await handlers.get("message_end")?.[0]?.({ message }) as { message: AssistantMessage } | undefined;
		expect(result?.message.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("**Diagram preview**"),
		});
	});

	it("transforms mermaid even when prose mentions Diagram preview", async () => {
		const { handlers, pi } = createMockPi();
		registerCursorMermaidPreview(pi);

		const message: AssistantMessage = {
			role: "assistant",
			provider: "cursor",
			api: "cursor-sdk",
			model: "composer-2.5",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{
				type: "text",
				text: `You should see **Diagram preview** instead of raw source.\n\n\`\`\`mermaid\n${SAMPLE_FLOWCHART}\n\`\`\``,
			}],
		};

		const result = await handlers.get("message_end")?.[0]?.({ message }) as { message: AssistantMessage } | undefined;
		expect(result?.message.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("- pi-fleet upgrade --latest"),
		});
		expect(result?.message.content[0]).toMatchObject({
			type: "text",
			text: expect.not.stringContaining("```mermaid"),
		});
	});

	it("backfills loaded session messages on session_start", async () => {
		const { handlers, pi } = createMockPi();
		registerCursorMermaidPreview(pi);

		const message: AssistantMessage = {
			role: "assistant",
			provider: "cursor",
			api: "cursor-sdk",
			model: "composer-2.5",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{
				type: "text",
				text: `\`\`\`mermaid\n${SAMPLE_FLOWCHART}\n\`\`\``,
			}],
		};

		await handlers.get("session_start")?.[0]?.({
			type: "session_start",
			reason: "reload",
		}, {
			sessionManager: {
				getBranch: () => [{ type: "message", message }],
			},
		});

		expect(message.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("**Diagram preview**"),
		});
	});

	it("skips non-cursor assistant messages", async () => {
		const { handlers, pi } = createMockPi();
		registerCursorMermaidPreview(pi);

		const message: AssistantMessage = {
			role: "assistant",
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{
				type: "text",
				text: "```mermaid\nA --> B\n```",
			}],
		};

		const result = await handlers.get("message_end")?.[0]?.({ message }) as { message: AssistantMessage } | undefined;
		expect(result).toBeUndefined();
	});

	it("does not transform when disabled", async () => {
		process.env.PI_CURSOR_MERMAID_PREVIEW = "0";
		const { handlers, pi } = createMockPi();
		registerCursorMermaidPreview(pi);

		const message: AssistantMessage = {
			role: "assistant",
			provider: "cursor",
			api: "cursor-sdk",
			model: "composer-2.5",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{
				type: "text",
				text: "```mermaid\nA --> B\n```",
			}],
		};

		const result = await handlers.get("message_end")?.[0]?.({ message }) as { message: AssistantMessage } | undefined;
		expect(result).toBeUndefined();
		delete process.env.PI_CURSOR_MERMAID_PREVIEW;
	});
});

describe("cursor-mermaid image rendering", () => {
	beforeEach(() => {
		process.env.PI_CURSOR_MERMAID_IMAGE = "1";
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		setMermaidRenderHookForTests(async () => ({ ok: true, pngBase64: TINY_PNG_BASE64 }));
	});

	afterEach(() => {
		delete process.env.PI_CURSOR_MERMAID_IMAGE;
		setMermaidRenderHookForTests(undefined);
		resetCapabilitiesCache();
	});

	it("replaces mermaid fences with terminal image markdown when rendering succeeds", async () => {
		const markdown = `\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\``;
		const transformed = await transformMermaidFencesInMarkdownAsync(markdown);
		expect(messageContainsMermaidImage(transformed)).toBe(true);
		expect(transformed).toContain("\x1b_G");
		expect(transformed).not.toContain("```mermaid");
		expect(transformed).not.toContain("**Diagram preview**");
		expect(transformed).not.toContain("<!-- pi-cursor-sdk:mermaid-image -->");
	});

	it("transforms cursor assistant messages to image markdown on message_end", async () => {
		const { handlers, pi } = createMockPi();
		registerCursorMermaidPreview(pi);

		const message: AssistantMessage = {
			role: "assistant",
			provider: "cursor",
			api: "cursor-sdk",
			model: "composer-2.5",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{
				type: "text",
				text: "```mermaid\nflowchart TD\n  A --> B\n```",
			}],
		};

		const result = await handlers.get("message_end")?.[0]?.({ message }) as { message: AssistantMessage } | undefined;
		expect(result?.message.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/\x1b_G|\x1b]1337;File=/),
		});
	});

	it("preserves image row reservation through markdown paragraph spacing", () => {
		const imageLines = ["", "", "\x1b_Ga=T,f=100,q=2;abc\x1b\\"];
		const formatted = formatImageLinesForMarkdown(imageLines);
		expect(formatted.split("\n\n")).toHaveLength(3);
		expect(formatted).not.toContain("<!--");
	});
});

describe("cursor-mermaid-preview parseEdges", () => {
	it("parses labeled nodes and edges", () => {
		const { edges, labels } = __testUtils.parseEdges(SAMPLE_FLOWCHART);
		expect(edges).toHaveLength(10);
		expect(labels.get("cli")).toBe("pi-fleet upgrade --latest");
		expect(edges[0]).toEqual({ from: "cli", to: "pre", label: undefined });
	});
});
