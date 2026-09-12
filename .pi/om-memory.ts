/**
 * om-memory — the vault's cross-repo memory layer as a pi extension.
 *
 * This is the `om` MCP server's in-process equivalent. Rather than re-wiring
 * the om server's behaviour, it drives the SAME handler library the shipped
 * stdio server uses (`createHandlers` in `.claude/scripts/lib/mcp-server.ts`),
 * so every tested behaviour — the epistemic contract, exposure policy, audit
 * log, scope rules, supersession ordering — is the very same implementation,
 * not a port of it.
 *
 * The one MCP concept it replaces is the identity handshake. MCP gave the
 * server the caller's directories via `roots/list`; pi gives the extension the
 * calling session's cwd directly. The stub session below fabricates the same
 * `roots` shape from that cwd, so identity resolution (`.om-project` marker,
 * folder name, `OM_CALLER` fallback) is the shipped code, unchanged.
 *
 * Install (the consuming repo — mirrors the om server's two-step install):
 *   1. Point pi at this file. In the consuming repo's `~/.pi/agent/settings.json`
 *      (or a project `.pi/settings.json` after trusting it):
 *        "extensions": ["/absolute/path/to/your/vault/.pi/om-memory.ts"]
 *   2. Add a pointer in the consuming repo's own AGENTS.md telling the agent
 *      the vault exists and to consult it before decisions. Prohibitions
 *      propagate; routing instructions do not — the nearest source has to be
 *      the thing that says "go look".
 *   The vault can also be pinned with OM_VAULT_PATH (the same env var the om
 *   server honours); otherwise it resolves from this file's own location.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createContext } from "../.claude/scripts/lib/mcp-context.ts";
import { resolveExposure } from "../.claude/scripts/lib/mcp-exposure.ts";
import { createHandlers } from "../.claude/scripts/lib/mcp-server.ts";
import { createQmdClient, type QmdClient } from "../.claude/scripts/lib/mcp-qmd-client.ts";
import { callerProject, createAuditor, auditPath } from "../.claude/scripts/lib/mcp-caller.ts";

export default function (pi: ExtensionAPI) {
	// Which vault? Same precedence as the om server: OM_VAULT_PATH is the pin,
	// otherwise this file's own location (<vault>/.pi/om-memory.ts).
	const env = process.env["OM_VAULT_PATH"];
	const vaultRoot = env && env.trim()
		? resolve(env.trim())
		: resolve(dirname(fileURLToPath(import.meta.url)), "..");
	if (!existsSync(join(vaultRoot, "vault-manifest.json"))) return; // not this file's vault; load silently

	const ctx = createContext(vaultRoot);
	const policy = resolveExposure(ctx.vaultRoot, ctx.manifest, ctx.memoryRoot);

	// The calling session's cwd, set per tool call. Everything downstream —
	// callerProject, isVaultItself, memory scoping — reads it through the stub
	// session's `roots`, so the identity code is the shipped implementation.
	let callerCwd: string | null = null;
	let nextId = 0;
	const okById = new Map<number, unknown>();
	const failById = new Map<number, { message: unknown; code: number }>();

	const session = {
		get roots(): readonly { uri: string }[] {
			if (callerCwd === null) return [];
			return [{ uri: pathToFileURL(join(callerCwd, "")).href }];
		},
		get identified(): boolean {
			return callerCwd !== null;
		},
		get project(): string | null {
			return callerProject(this.roots);
		},
		async identityReady(): Promise<void> {},
		ok(id: number, result: unknown): void {
			okById.set(id, result);
		},
		fail(id: number, message: unknown, code = -32603): void {
			failById.set(id, { message, code });
		},
	};

	// Lazily created — a vault with no qmd must still serve everything else.
	let qmdClient: QmdClient | null = null;
	const qmd = (): QmdClient => {
		if (qmdClient === null) qmdClient = createQmdClient(ctx.vaultRoot, ctx.qmdLauncher);
		return qmdClient;
	};

	const handlers = createHandlers({
		ctx,
		policy,
		session: session as never,
		qmd,
		audit: createAuditor(auditPath(ctx.vaultRoot), () => callerProject(session.roots as never)),
	});

	/** Drive the shipped tools/call handler in-process and unwrap the reply. */
	async function callTool(cwd: string, name: string, args: Record<string, unknown>): Promise<string> {
		callerCwd = cwd;
		const id = ++nextId;
		okById.delete(id);
		failById.delete(id);
		const handler = handlers["tools/call"];
		if (!handler) return "(vault tools unavailable)";
		await handler(id, { name, arguments: args });
		const failed = failById.get(id);
		if (failed) {
			const message = typeof failed.message === "string" ? failed.message : String(failed.message ?? "");
			throw new Error(message);
		}
		const replied = okById.get(id) as { content?: { type: string; text?: string }[] } | undefined;
		return replied?.content?.[0]?.text ?? "(no response)";
	}

	// --- Registered tools (descriptions are the shipped MCP ones, adjusted) ---

	pi.registerTool({
		name: "om_search",
		label: "OM Search",
		description:
			"Search the user's personal knowledge vault (obsidian-mind). Returns ranked passages with note paths — past decisions, prior art, why something is the way it is. Prefer this over asking the user to recall something.",
		parameters: Type.Object({
			query: Type.String({ description: "What to look for" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 5)"})),
		}),
		async execute(_id, params, signal, _onUpdate, ctx2) {
			return text(await callTool(ctx2.cwd, "search", params));
		},
	});

	pi.registerTool({
		name: "om_expand",
		label: "OM Expand",
		description:
			"Given a vault note you already know, show what it links to and what links back to it. Use this instead of searching again when you have a specific note and want its neighbourhood.",
		parameters: Type.Object({
			note: Type.String({ description: "Note title, path or vault:// URI" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx2) {
			return text(await callTool(ctx2.cwd, "expand", params));
		},
	});

	pi.registerTool({
		name: "om_recall",
		label: "OM Recall",
		description:
			"Retrieve the durable lessons this repo is allowed to see, most specific first. Call BEFORE making a decision you might already have made once — the vault is where the last session left its reasoning. Returns only memories scoped to reach you; another project's memories are withheld by design.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({
				description: "Optional filter. Omit to see everything in scope, which is usually what you want at the start of a task.",
			})),
			limit: Type.Optional(Type.Number({ description: "Max memories to return (default 20)"})),
			explain: Type.Optional(Type.Boolean({
				description: "Also report what was withheld and why — use when a memory you expected is missing.",
			})),
		}),
		async execute(_id, params, signal, _onUpdate, ctx2) {
			return text(await callTool(ctx2.cwd, "recall", params));
		},
	});

	pi.registerTool({
		name: "om_remember",
		label: "OM Remember",
		description:
			"Record a DURABLE LESSON into the vault's memory — something that will still be true, and still useful, in a repo that is not this one. The test: would this help someone working on a different project? If it is a log of what you did here today, use om_record_work instead. Good memories: a constraint you discovered, a gotcha that cost you time, a rule that generalises.",
		parameters: Type.Object({
			title: Type.String({
				description: "The lesson itself, stated as a claim. What a future session will match against.",
			}),
			body: Type.String({ description: "The lesson in full — enough for someone with none of your context to apply it." }),
			confidence: Type.Optional(StringEnumLite(["verified", "inferred", "unverified"], {
				description: "verified = proven in this codebase; inferred = believed but unproven; unverified = heard. Default unverified.",
			})),
			scope: Type.Optional(StringEnumLite(["general", "platform", "project"], {
				description: "Who this reaches: general = every repo; platform = same platform; project = the named projects. Default project.",
			})),
			projects: Type.Optional(Type.Array(Type.String(), {
				description: "Repo identities this applies to (the calling repo is included automatically). A lesson touching two projects names both.",
			})),
			platforms: Type.Optional(Type.Array(Type.String(), {
				description: "Platforms this applies to (e.g. ios, web) — only for scope 'platform'.",
			})),
		}),
		async execute(_id, params, signal, _onUpdate, ctx2) {
			return text(await callTool(ctx2.cwd, "remember", params));
		},
	});

	pi.registerTool({
		name: "om_record_work",
		label: "OM Record Work",
		description:
			"Record work that happened in this repo into the vault, filed where it belongs. This is a durable record for a future session that will NOT have your context and cannot re-read your diff. Fill every field you can; sparse records are near-worthless six weeks later. Use dry_run to preview the filed note first.",
		parameters: Type.Object({
			title: Type.String({ description: "Short, specific. 'Add archive command' not 'update'." }),
			summary: Type.String({
				description: "2-4 sentences: what happened and why it was done.",
			}),
			changes: Type.Optional(Type.Array(Type.String(), {
				description: "One line per file/component touched: what changed and why.",
			})),
			decisions: Type.Optional(Type.Array(Type.String(), {
				description: "Choices made and the reasoning, especially rejections. The entries most likely to matter later.",
			})),
			learned: Type.Optional(Type.Array(Type.String(), {
				description: "Surprises, gotchas, things that cost time or nearly went wrong.",
			})),
			verification: Type.Optional(Type.String({
				description: "How you know it works: tests run and results, manual checks. State failures honestly.",
			})),
			open: Type.Optional(Type.Array(Type.String(), {
				description: "Unresolved threads, deferred work, known limits.",
			})),
			informed_by: Type.Optional(Type.Array(Type.String(), {
				description: "Vault notes you read that shaped this work, by title — rendered as links.",
			})),
			folder: Type.Optional(Type.String({
				description: "Vault-relative destination, e.g. 'projects/pocket/notes'. Omit to file under the calling repo's project automatically.",
			})),
			kind: Type.Optional(StringEnumLite(["note", "decision"], {
				description: "'decision' files as a decision record with an undated title; 'note' is a dated point-in-time record. Default 'note'.",
			})),
			dry_run: Type.Optional(Type.Boolean({ description: "Preview without writing (default false)"})),
		}),
		async execute(_id, params, signal, _onUpdate, ctx2) {
			return text(await callTool(ctx2.cwd, "record_work", params));
		},
	});

	pi.registerTool({
		name: "om_health",
		label: "OM Health",
		description:
			"Diagnose the vault layer: which vault is served, index ownership, memory-root drift, qmd liveness, today's reasoning spend. Call when retrieval returns nothing unexpected.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx2) {
			return text(await callTool(ctx2.cwd, "health", {}));
		},
	});

	// The qmd MCP child holds the event loop open through its stdio pipes —
	// without this, print/JSON runs do their work and then never exit.
	pi.on("session_shutdown", async () => {
		qmdClient?.dispose();
		qmdClient = null;
	});

	// Tier-0 contract: the vault's rules for sessions OUTSIDE the vault.
	// The prohibition (last paragraph) is measured to hold; keep it verbatim.
	pi.on("before_agent_start", async (event, ctx2) => {
		if (ctx2.cwd === vaultRoot) return; // the vault's own session reads its manual
		if (event.systemPrompt.includes("obsidian-mind vault contract")) return;
		return { systemPrompt: event.systemPrompt + "\n\n" + PI_CONTRACT };
	});
}

const text = (body: string) => ({
	content: [{ type: "text" as const, text: body }],
	details: {},
});

function StringEnumLite<const T extends readonly string[]>(values: T, opts: { description: string }) {
	return Type.Union(values.map((v) => Type.Literal(v)) as never, opts);
}

// Adapted from the shipped INSTRUCTIONS (mcp-context.ts): the vault's rules for
// sessions in OTHER repositories. The resource paragraph is replaced by the pi
// tool names; the prohibition at the end is verbatim — measured to hold under
// direct pressure and an authority override.
const PI_CONTRACT: string = [
	"--- obsidian-mind vault contract ---",
	"",
	"You have access to the user's personal knowledge vault (obsidian-mind) through the",
	"om_* tools — om_search, om_expand, om_recall, om_remember, om_record_work, om_health.",
	"",
	"WHEN TO USE IT: before answering questions about past decisions, prior art, why",
	"something is the way it is, or what the user already concluded, call om_search.",
	"The vault is the record; your memory of this conversation is not.",
	"",
	"Once you know a specific note, call om_expand to see what it links to and what",
	"links back, rather than searching again. om_recall returns only lessons scoped to",
	"reach this repo; om_record_work files what you did here; om_remember records a",
	"lesson that generalises beyond this repo.",
	"",
	"HOW TO TREAT WHAT YOU FIND: cite the note path you used. Vault notes carry",
	"'as of YYYY-MM-DD' markers on volatile facts and (TBC)/(inferred) markers on",
	"unverified ones. Preserve those qualifiers when you repeat a claim; never",
	"promote an inferred fact to a stated one. If a note is months old and the claim",
	"is volatile, say so rather than asserting it.",
	"",
	"NEVER put agent-session artifacts into anything that lands in a repository:",
	"no claude.ai session URLs, no 'Claude-Session:' trailers, no local absolute",
	"paths. Not in commit messages, PR or issue bodies, review comments, or files.",
	"'Co-Authored-By:' is fine and wanted; the session URL is not.",
].join("\n");
