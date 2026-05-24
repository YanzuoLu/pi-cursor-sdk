import { parseEnvBoolean } from "./cursor-env-boolean.js";
import {
	isCursorMermaidImageEnabled,
	renderMermaidDiagramToPng,
	resolveMermaidImageWidthCells,
} from "./cursor-mermaid-render.js";
import { buildTerminalImageMarkdown, messageContainsMermaidImage } from "./cursor-mermaid-terminal-image.js";

const MERMAID_FENCE_RE = /```mermaid[^\n]*\n([\s\S]*?)```/gi;
const MERMAID_PREVIEW_MARKER = "**Diagram preview**";
const FLOWCHART_HEADER_RE = /^(?:flowchart|graph)\s+(?:TB|BT|RL|LR|TD|DT)?\s*;?\s*$/i;
const EDGE_RE = /^(.+?)\s+(?:<[-=]+(?:\|[^|]*\|)?[-=]+>|<[-=]+(?:\|[^|]*\|)?[-=]+>o|o[-=]+(?:\|[^|]*\|)?[-=]+o|x[-=]+(?:\|[^|]*\|)?[-=]+x|--(?:\|[^|]*\|)?>|==(?:\|[^|]*\|)?>|--(?:\|[^|]*\|)?o|o(?:\|[^|]*\|)?--o|-\.(?:\|[^|]*\|)?->|---|-\.-)\s*(?:\|([^|]*)\|)?\s*(.+)$/;

interface ParsedNode {
	id: string;
	label: string;
}

interface ParsedEdge {
	from: string;
	to: string;
	label?: string;
}

export function isCursorMermaidPreviewEnabled(): boolean {
	return parseEnvBoolean(process.env.PI_CURSOR_MERMAID_PREVIEW, true);
}

function stripMermaidComments(line: string): string {
	const withoutLineComment = line.replace(/%%.*$/, "").trim();
	return withoutLineComment.replace(/%%\{[\s\S]*?\}%%/g, "").trim();
}

function extractNodeToken(raw: string): ParsedNode | null {
	const token = raw.trim();
	if (!token) return null;

	const patterns: Array<[RegExp, (match: RegExpMatchArray) => ParsedNode]> = [
		[/^([A-Za-z0-9_-]+)\[\[([^\]]+)\]\]$/, (m) => ({ id: m[1], label: m[2].trim() })],
		[/^([A-Za-z0-9_-]+)\[([^\]]+)\]$/, (m) => ({ id: m[1], label: m[2].trim() })],
		[/^([A-Za-z0-9_-]+)\(\(([^)]+)\)\)$/, (m) => ({ id: m[1], label: m[2].trim() })],
		[/^([A-Za-z0-9_-]+)\(([^)]+)\)$/, (m) => ({ id: m[1], label: m[2].trim() })],
		[/^([A-Za-z0-9_-]+)\{([^}]+)\}$/, (m) => ({ id: m[1], label: m[2].trim() })],
		[/^([A-Za-z0-9_-]+)>([^\]]+)\]$/, (m) => ({ id: m[1], label: m[2].trim() })],
		[/^([A-Za-z0-9_-]+)$/, (m) => ({ id: m[1], label: m[1] })],
	];

	for (const [pattern, map] of patterns) {
		const match = token.match(pattern);
		if (match) return map(match);
	}
	return null;
}

function registerNode(labels: Map<string, string>, node: ParsedNode): void {
	if (!labels.has(node.id)) {
		labels.set(node.id, node.label);
	}
}

function parseEdges(source: string): { edges: ParsedEdge[]; labels: Map<string, string> } {
	const labels = new Map<string, string>();
	const edges: ParsedEdge[] = [];

	for (const rawLine of source.split("\n")) {
		const line = stripMermaidComments(rawLine);
		if (!line) continue;
		if (FLOWCHART_HEADER_RE.test(line)) continue;
		if (/^(?:classDef|class|style|linkStyle|direction|click|subgraph|end)\b/i.test(line)) continue;

		const edgeMatch = line.match(EDGE_RE);
		if (edgeMatch) {
			const fromNode = extractNodeToken(edgeMatch[1]);
			const toNode = extractNodeToken(edgeMatch[3]);
			if (!fromNode || !toNode) continue;
			registerNode(labels, fromNode);
			registerNode(labels, toNode);
			const edgeLabel = edgeMatch[2]?.trim();
			edges.push({
				from: fromNode.id,
				to: toNode.id,
				label: edgeLabel || undefined,
			});
			continue;
		}

		const standaloneNode = extractNodeToken(line);
		if (standaloneNode) {
			registerNode(labels, standaloneNode);
		}
	}

	return { edges, labels };
}

function formatNodeLabel(labels: Map<string, string>, nodeId: string): string {
	return labels.get(nodeId) ?? nodeId;
}

function renderFlowTree(
	labels: Map<string, string>,
	children: Map<string, ParsedEdge[]>,
	nodeId: string,
	depth: number,
	visited: Set<string>,
	lines: string[],
): void {
	const indent = "  ".repeat(depth);
	const prefix = depth === 0 ? "- " : "→ ";
	lines.push(`${indent}${prefix}${formatNodeLabel(labels, nodeId)}`);

	if (visited.has(nodeId)) return;
	visited.add(nodeId);

	for (const edge of children.get(nodeId) ?? []) {
		if (edge.label) {
			lines.push(`${"  ".repeat(depth + 1)}(${edge.label})`);
		}
		renderFlowTree(labels, children, edge.to, depth + 1, visited, lines);
	}
}

function renderFlowchartPreview(source: string): string | null {
	const { edges, labels } = parseEdges(source);
	if (edges.length === 0) return null;

	const children = new Map<string, ParsedEdge[]>();
	const inDegree = new Map<string, number>();

	for (const edge of edges) {
		children.set(edge.from, [...(children.get(edge.from) ?? []), edge]);
		inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
		if (!inDegree.has(edge.from)) inDegree.set(edge.from, inDegree.get(edge.from) ?? 0);
	}

	const roots = [...labels.keys()].filter((id) => (inDegree.get(id) ?? 0) === 0);
	if (roots.length === 0) {
		roots.push(edges[0].from);
	}

	const lines: string[] = [MERMAID_PREVIEW_MARKER];
	const visited = new Set<string>();
	for (const root of roots) {
		renderFlowTree(labels, children, root, 0, visited, lines);
	}

	return lines.join("\n");
}

function renderGenericPreview(source: string): string {
	const cleaned = source
		.split("\n")
		.map(stripMermaidComments)
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !FLOWCHART_HEADER_RE.test(line));

	if (cleaned.length === 0) return MERMAID_PREVIEW_MARKER;

	return [MERMAID_PREVIEW_MARKER, ...cleaned.map((line) => `- ${line}`)].join("\n");
}

export function renderMermaidBlockPreview(source: string): string | null {
	const trimmed = source.trim();
	if (!trimmed) return null;

	const looksFlowchart =
		/^(?:flowchart|graph)\s/i.test(trimmed)
		|| /-->|---|==>|-.->/m.test(trimmed);

	if (looksFlowchart) {
		return renderFlowchartPreview(trimmed) ?? renderGenericPreview(trimmed);
	}

	return renderGenericPreview(trimmed);
}

async function renderMermaidReplacement(source: string): Promise<{ text: string; mode: "image" | "text" } | null> {
	const trimmed = source.trim();
	if (!trimmed) return null;

	if (isCursorMermaidImageEnabled()) {
		const pngResult = await renderMermaidDiagramToPng(trimmed);
		if (pngResult.ok) {
			const imageMarkdown = buildTerminalImageMarkdown(
				pngResult.pngBase64,
				resolveMermaidImageWidthCells(),
			);
			if (imageMarkdown) {
				return { text: imageMarkdown, mode: "image" };
			}
		}
	}

	const preview = renderMermaidBlockPreview(trimmed);
	if (!preview) return null;
	return { text: preview, mode: "text" };
}

export async function transformMermaidFencesInMarkdownAsync(text: string): Promise<string> {
	if (!/```mermaid/i.test(text)) return text;

	const fenceRe = /```mermaid[^\n]*\n([\s\S]*?)```/gi;
	const parts: string[] = [];
	let lastIndex = 0;
	let changed = false;
	let match: RegExpExecArray | null;

	while ((match = fenceRe.exec(text)) !== null) {
		parts.push(text.slice(lastIndex, match.index));
		const replacement = await renderMermaidReplacement(match[1]);
		if (replacement) {
			parts.push(replacement.text);
			changed = true;
		} else {
			parts.push(match[0]);
		}
		lastIndex = match.index + match[0].length;
	}

	if (!changed) return text;
	parts.push(text.slice(lastIndex));
	return parts.join("");
}

export function transformMermaidFencesInMarkdown(text: string): string {
	if (!/```mermaid/i.test(text)) return text;

	let changed = false;
	const transformed = text.replace(MERMAID_FENCE_RE, (match, body: string) => {
		const preview = renderMermaidBlockPreview(body);
		if (!preview) return match;
		changed = true;
		return preview;
	});

	return changed ? transformed : text;
}

export function messageContainsMermaidPreview(text: string): boolean {
	return text.includes(MERMAID_PREVIEW_MARKER) || messageContainsMermaidImage(text);
}

export const __testUtils = {
	parseEdges,
	renderMermaidBlockPreview,
	renderMermaidReplacement,
};
