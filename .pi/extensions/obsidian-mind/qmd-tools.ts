/**
 * QMD semantic-search tools for pi.
 *
 * Registers the same typed tool surface the qmd MCP server exposed to
 * Claude Code sessions (`query`, `get`, `multi_get`, `status`) as native
 * pi tools, backed by the qmd CLI. Index name resolution runs through the
 * SAME single resolver (`resolveQmdIndex`) every other caller uses — the
 * named-index contract must not grow a second implementation.
 *
 * Safety: invocations run qmd's JS entry directly with argv (no shell), so
 * model-provided query text can never become a shell command. When qmd is
 * not resolvable the tools are NOT registered — the qmd skill already
 * documents the Grep/Glob last-resort path, and a tool that pretends to
 * work is worse than an absent one.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { buildQmdCommand, resolveQmdEntry } from "../../../.claude/scripts/lib/qmd.ts";
import { resolveQmdIndex } from "../../../.claude/scripts/lib/session-start.ts";
import { readManifest } from "./briefing.ts";

type ToolResult = {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
};

const DEFAULT_QUERY_LIMIT = 10;
const DEFAULT_MULTI_GET_LIMIT = 40;
const TIMEOUT_MS = 120_000;

/**
 * Run a qmd subcommand against the vault's named index and return stdout.
 * Direct argv spawn of qmd's JS entry — no shell, so query text is never
 * interpreted. Aborts and timeouts kill the child and report a refusal.
 */
function runQmd(
	entry: string,
	index: string,
	args: readonly string[],
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const invocation = buildQmdCommand(entry, ["--index", index, ...args]);
		if (invocation.shell) {
			// No shell path for tools: an unresolved entry means no tools were
			// registered in the first place; this is unreachable by design.
			resolve({ ok: false, output: "qmd entry unresolved — tool unavailable" });
			return;
		}
		const child = spawn(invocation.cmd, [...invocation.args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok,
				output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
			});
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(false);
		}, timeoutMs);
		timer.unref();
		if (signal) {
			if (signal.aborted) {
				child.kill("SIGTERM");
				finish(false);
			} else {
				signal.addEventListener(
					"abort",
					() => {
						child.kill("SIGTERM");
						finish(false);
					},
					{ once: true },
				);
			}
		}
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}

function text(result: { ok: boolean; output: string }, degraded: string): ToolResult {
	if (result.ok) {
		const body = result.output.length > 0 ? result.output : "(no results)";
		return { content: [{ type: "text", text: body }], details: {} };
	}
	// Degradation is explicit: a failed qmd call must never read as "the
	// vault is empty". Name the failure and the fallback, per ARCHITECTURE.
	return {
		content: [
			{
				type: "text",
				text: `qmd call failed: ${result.output || "no output"}\n${degraded}`,
			},
		],
		details: {},
		isError: true,
	};
}

export function registerQmdTools(pi: ExtensionAPI, root: string): void {
	const entry = resolveQmdEntry();
	if (entry === null) return; // qmd absent → no tools; skill covers fallbacks
	const index = resolveQmdIndex(readManifest(root), root);
	if (index === null) return; // no usable index name → no tools

	pi.registerTool({
		name: "qmd_query",
		label: "QMD Query",
		description: [
			"Semantic search over this Obsidian vault (QMD). Use PROACTIVELY before reading files.",
			"mode 'hybrid' (default) = best quality; 'lex' = exact terms, names, ticket numbers, dates; 'vec' = conceptual/unknown wording.",
			"Triggers: past decisions, incidents, people, meetings, architecture, patterns; before creating a note (duplicates/related); after creating a note (backlinks).",
		].join(" "),
		parameters: Type.Object({
			query: Type.String({ description: "The search query (natural language)" }),
			mode: Type.Optional(
				StringEnum(["hybrid", "lex", "vec"] as const, {
					description: "hybrid (default) | lex (keyword BM25) | vec (semantic)",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max results (default 10)", default: DEFAULT_QUERY_LIMIT }),
			),
		}),
		async execute(_id, params, signal) {
			const verb =
				params.mode === "lex" ? "search" : params.mode === "vec" ? "vsearch" : "query";
			const args = [verb, params.query, "-n", String(params.limit ?? DEFAULT_QUERY_LIMIT)];
			return text(
				await runQmd(entry, index, args, signal, TIMEOUT_MS),
				"Fallback: use Grep/Glob on the vault, or ask the user whether qmd is installed (`npm i -g @tobilu/qmd`).",
			);
		},
	});

	pi.registerTool({
		name: "qmd_get",
		label: "QMD Get",
		description:
			"Read a vault note's indexed content by path (e.g. 'work/active/X.md') or by doc id ('#abc123'). Cheaper than a full file read; returns what the index holds.",
		parameters: Type.Object({
			target: Type.String({
				description: "Note path relative to the vault root, or '#docid'",
			}),
		}),
		async execute(_id, params, signal) {
			return text(
				await runQmd(entry, index, ["get", params.target], signal, TIMEOUT_MS),
				"Fallback: Read the file directly with the read tool.",
			);
		},
	});

	pi.registerTool({
		name: "qmd_multi_get",
		label: "QMD Multi Get",
		description:
			"Batch-read indexed vault notes matching a glob pattern (e.g. 'org/people/*.md', 'perf/evidence/*.md').",
		parameters: Type.Object({
			pattern: Type.String({ description: "Glob pattern relative to the vault root" }),
			limit: Type.Optional(
				Type.Number({ description: "Max files (default 40)", default: DEFAULT_MULTI_GET_LIMIT }),
			),
		}),
		async execute(_id, params, signal) {
			return text(
				await runQmd(
					entry,
					index,
					["multi-get", params.pattern, "-l", String(params.limit ?? DEFAULT_MULTI_GET_LIMIT)],
					signal,
					TIMEOUT_MS,
				),
				"Fallback: use Glob + Read on the vault.",
			);
		},
	});

	pi.registerTool({
		name: "qmd_status",
		label: "QMD Status",
		description:
			"Report the health of this vault's QMD index (documents, embeddings, model, store path). Call when search returns nothing unexpected or before relying on results.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			return text(
				await runQmd(entry, index, ["status"], signal, 15_000),
				"Fallback: search is unavailable — use Grep/Glob and tell the user qmd may need `npm i -g @tobilu/qmd` + the bootstrap.",
			);
		},
	});
}
