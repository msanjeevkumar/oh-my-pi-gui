#!/usr/bin/env bun
/// <reference types="bun" />
import * as fs from "node:fs";
import { createInterface } from "node:readline";
import type {
	AgentMessage,
	ExtensionUIResponse,
	RpcCommand,
	RpcSecurityDashboardResult,
	RpcSessionState,
} from "../src/shared/rpc-types";

// A local protocol peer. No provider credentials, external network, or user session files.
if (process.argv.includes("stats")) {
	const binary = process.env.OMP_GUI_TEST_STATS_BINARY;
	if (binary) {
		const child = Bun.spawn([binary, ...process.argv.slice(2)], {
			stdout: "inherit",
			stderr: "inherit",
			env: process.env,
		});
		process.on("SIGTERM", () => child.kill());
		await child.exited;
	} else {
		const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
		process.stdout.write(`http://localhost:${server.port}\n`);
		process.on("SIGTERM", () => {
			server.stop(true);
			process.exit(0);
		});
	}
} else {
	const messages: AgentMessage[] = [];
	const count = Math.min(50_000, Number(process.env.OMP_GUI_TEST_HISTORY ?? 0));
	for (let index = 0; index < count; index++) {
		const common = { timestamp: 1700000000000 + index * 1000, entryId: `history-${index}` };
		if (index > 0 && index % 1000 === 0)
			messages.push({
				...common,
				role: "compactionSummary",
				summary: `Compacted history ${index}`,
				tokensBefore: 90000,
				tokensAfter: 12000,
			});
		else if (index % 1000 === 2)
			messages.push({
				...common,
				role: "user",
				content: [
					{ type: "text", text: `Image question ${index}` },
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6VQAAAAASUVORK5CYII=",
					},
				],
			});
		else if (index % 10 === 5)
			messages.push({
				...common,
				role: "assistant",
				content: [{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: { path: "example.ts" } }],
				stopReason: "toolUse",
			});
		else if (index % 10 === 6)
			messages.push({
				...common,
				role: "toolResult",
				toolCallId: `tool-${index - 1}`,
				toolName: "read",
				content: [{ type: "text", text: `Result ${index}\nconst value = ${index};` }],
				isError: false,
			});
		else if (index % 2 === 0)
			messages.push({ ...common, role: "user", content: [{ type: "text", text: `History question ${index}` }] });
		else
			messages.push({
				...common,
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Consider context ${index}.` },
					{ type: "text", text: `History answer ${index}. This is a bounded local performance fixture.` },
				],
				stopReason: "stop",
			});
	}

	const model = {
		id: "local-fixture",
		name: "Local fixture",
		provider: "fixture",
		reasoning: true,
		contextWindow: 128000,
		maxTokens: 4096,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const state: RpcSessionState = {
		model,
		thinkingLevel: "medium",
		availableThinkingLevels: ["low", "medium", "high"],
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionFile: null,
		cwd: process.cwd(),
		sessionId: `fixture-${process.pid}`,
		sessionName: "Audit session",
		fastModeEnabled: false,
		fastModeActive: false,
		tokensPerSecond: null,
		autoCompactionEnabled: true,
		autoRetryEnabled: true,
		messageCount: messages.length,
		queuedMessageCount: 0,
		todoPhases: [],
		systemPrompt: [],
		dumpTools: [],
		contextUsage: null,
		planModeEnabled: false,
		agentsPaused: false,
	};
	let queue: { id: string; text: string; lane: string }[] = [];
	let securityMode = "disabled";
	let streamTimer: Timer | null = null;
	let streamChunks = 0;
	let holdSettings = false;
	let releaseSettings: (() => void) | undefined;
	const write = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
	const values: Record<string, unknown> = {
		"approval.mode": "ask",
		"theme.dark": "dark",
		"theme.light": "light",
		"theme.mode": "dark",
		"security.enabled": false,
		"compaction.reserveTokens": 8192,
	};
	const stats = {
		sessionId: state.sessionId,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		premiumRequests: 0,
	};
	write({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
	const lines = createInterface({ input: process.stdin });
	lines.on("line", line => {
		const command = JSON.parse(line) as RpcCommand | ExtensionUIResponse;
		if (process.env.OMP_GUI_TEST_RECORD)
			fs.appendFileSync(process.env.OMP_GUI_TEST_RECORD, `${JSON.stringify(command)}\n`);
		const ok = (data: unknown = {}) =>
			write({ type: "response", id: command.id, command: command.type, success: true, data });
		switch (command.type) {
			case "get_state":
				ok(state);
				break;
			case "get_messages":
			case "get_transcript":
				ok({ messages });
				break;
			case "get_subagents":
				ok({ subagents: [] });
				break;
			case "get_queue":
				ok({ steering: [], followUp: [], entries: queue });
				break;
			case "get_available_models":
				ok({ models: [model], discoveryStates: [], refreshPending: false, generation: 1 });
				break;
			case "get_providers":
				ok({
					providers: [{ id: "fixture", name: "Local fixture", hasAuth: true, authenticated: true, modelCount: 1 }],
					models: [model],
					discoveryStates: [],
					refreshPending: false,
					generation: 1,
				});
				break;
			case "get_login_providers":
				ok({ providers: [] });
				break;
			case "get_settings":
				if (holdSettings && !command.paths) {
					holdSettings = false;
					const snapshot = { ...values };
					releaseSettings = () => ok({ values: snapshot, advisorEnabled: false, advisorActive: false });
					break;
				}
				ok({ values, advisorEnabled: false, advisorActive: false });
				break;
			case "set_setting":
				values[command.path] = command.value;
				ok({ path: command.path, value: command.value });
				break;
			case "get_settings_schema":
				ok({
					tabs: ["context", "model", "providers", "tasks", "files", "shell", "tools", "memory", "interaction"].map(
						id => ({ id, label: id, groups: [] }),
					),
					entries: [
						...["context", "model", "providers", "tasks", "files", "shell", "tools", "memory", "interaction"].map(
							tab => ({
								path: tab === "context" ? "compaction.enabled" : `fixture.${tab}`,
								type: "boolean",
								tab,
								label: tab === "context" ? "Auto compaction" : `Fixture ${tab}`,
								description: "Isolated audit setting",
								default: true,
							}),
						),
						{
							path: "compaction.reserveTokens",
							type: "number",
							tab: "context",
							label: "Reserve tokens",
							description: "Isolated numeric audit setting",
							default: 8192,
						},
					],
				});
				break;
			case "get_goal":
				ok({ enabled: false, status: "none" });
				break;
			case "get_loop_mode":
				ok({ enabled: false, state: "off" });
				break;
			case "get_vibe_mode":
				ok({ enabled: false });
				break;
			case "get_gui_themes":
			case "get_themes":
				ok({ themes: [] });
				break;
			case "get_available_commands":
				ok({
					commands: [
						"jobs",
						"share",
						"live",
						"btw",
						"settings",
						"stats",
						"theme",
						"benchmark",
						"collab",
						"import",
						"context",
						"debug",
						"tools",
						"models",
						"providers",
						"modes",
					].map(name => ({ name, source: "builtin", textModeExecutable: false, description: name })),
				});
				break;
			case "get_context_report":
				ok({ contextWindow: 128000, model: model.id });
				break;
			case "get_session_stats":
				ok(stats);
				break;
			case "get_git_changes":
				ok({ isRepo: false, root: null, base: null, files: [], truncated: false });
				break;
			case "get_git_status":
				ok({ isRepo: false, branch: null, staged: 0, unstaged: 0, untracked: 0 });
				break;
			case "get_active_tools":
				ok({ tools: [] });
				break;
			case "get_jobs":
				ok({
					jobs: [
						{
							id: "done",
							type: "bash",
							label: "Completed local job",
							status: "completed",
							startTime: 1000,
							endedAt: 3000,
						},
					],
				});
				break;
			case "preview_share_session":
				ok({
					snapshotId: "fixture",
					preview: JSON.stringify({ messages }),
					serverUrl: "http://127.0.0.1/local-share",
					store: "blob",
					redactionEnabled: true,
				});
				break;
			case "share_session":
				ok({ url: "http://127.0.0.1/shared#local" });
				break;
			case "get_live_state":
				ok({ active: false, phase: "connecting", muted: false, inputLevel: 0, outputLevel: 0 });
				break;
			case "live_start":
				ok({ active: true, phase: "listening", muted: false, inputLevel: 0, outputLevel: 0 });
				break;
			case "live_stop":
				ok({ active: false, phase: "connecting", muted: false, inputLevel: 0, outputLevel: 0 });
				break;
			case "btw":
				ok({ question: command.question, replyText: "Local side answer", canBranch: false });
				break;
			case "get_plugins":
				ok({ plugins: [] });
				break;
			case "get_marketplaces":
				ok({ marketplaces: [] });
				break;
			case "get_prompt_templates":
				ok({ templates: [] });
				break;
			case "get_hooks":
				ok({ hooks: [] });
				break;
			case "get_mcp_servers":
				ok({ servers: [] });
				break;
			case "get_skills":
				ok({ skills: [] });
				break;
			case "get_security_dashboard": {
				if (securityMode === "unavailable") {
					write({
						type: "response",
						id: command.id,
						command: command.type,
						success: false,
						error: "Isolated dashboard unavailable",
					});
					break;
				}
				const dashboard: RpcSecurityDashboardResult = {
					enabled: securityMode !== "disabled",
					modelReady: true,
					modelLabel: "Local fixture",
					repositoryRoot: process.cwd(),
					scans: [],
					operations: [],
				};
				if (!["disabled", "unscanned"].includes(securityMode)) {
					const now = new Date().toISOString();
					const scan = {
						id: "scan",
						status:
							securityMode === "failed"
								? ("failed" as const)
								: securityMode === "incomplete"
									? ("partial" as const)
									: ("completed" as const),
						createdAt: now,
						producer: "fixture",
						findingCount: securityMode === "findings" ? 1 : 0,
						target: { kind: "working_tree" as const, displayName: "Working tree" },
					};
					dashboard.scans = [scan];
					dashboard.latest = {
						scan,
						findings:
							securityMode === "findings"
								? [
										{
											id: "f1",
											scanId: "scan",
											title: "Untrusted path reaches file access",
											summary: "Isolated finding",
											severity: "high",
											confidence: "high",
											disposition: "open",
											validation: "unvalidated",
											evidence: [],
										},
									]
								: [],
					};
					if (securityMode === "running")
						dashboard.operations = [
							{
								operationId: "op",
								planId: "plan",
								scanId: "scan",
								phase: "reviewing",
								createdAt: now,
								updatedAt: now,
								findingCount: 0,
							},
						];
				}
				ok(dashboard);
				break;
			}
			case "set_subagent_subscription":
			case "set_host_tools":
			case "set_host_uri_schemes":
				ok();
				break;
			case "extension_ui_response":
				state.isStreaming = false;
				ok();
				write({ type: "agent_end", messages: [], isTerminal: true });
				break;
			case "get_collab_state":
				ok(state.collab ?? { role: null, readOnly: false, participants: [] });
				break;
			case "bash": {
				if (command.command === "fixture:progress") {
					ok({ chunks: streamChunks });
					break;
				}
				if (command.command === "fixture:large-tool") {
					const tool = { toolCallId: "large-tool", toolName: "bash" };
					write({ type: "tool_execution_start", ...tool, args: { command: "local audit fixture" } });
					write({
						type: "tool_execution_end",
						...tool,
						result: { content: [{ type: "text", text: "bounded output line\n".repeat(25000) }] },
						isError: false,
					});
					ok();
					break;
				}
				if (command.command.startsWith("fixture:security:")) {
					securityMode = command.command.slice("fixture:security:".length);
					ok();
					break;
				}
				state.collab = {
					role: command.command === "fixture:readonly" ? "guest" : null,
					readOnly: command.command === "fixture:readonly",
					participants: [],
				};
				ok();
				write({ type: "collab_state", state: state.collab });
				break;
			}

			case "get_ssh_hosts":
				ok({ hosts: [], warnings: [], openSshAvailable: true });
				break;
			case "list_foreign_sessions":
				ok({ sessions: [] });
				break;
			case "set_plan_mode":
				state.planModeEnabled = command.enabled;
				ok({ enabled: command.enabled });
				break;
			case "steer":
			case "follow_up":
				queue = [
					...queue,
					{
						id: crypto.randomUUID(),
						text: command.message,
						lane: command.type === "steer" ? "steering" : "followUp",
					},
				];
				ok();
				break;
			case "abort":
				if (streamTimer) clearInterval(streamTimer);
				streamTimer = null;
				state.isStreaming = false;
				ok();
				write({ type: "agent_end", messages: [], isTerminal: true });
				break;
			case "prompt": {
				if (command.message === "fixture hold settings") {
					holdSettings = true;
					ok();
					break;
				}
				if (command.message === "fixture release settings") {
					releaseSettings?.();
					releaseSettings = undefined;
					ok();
					break;
				}
				if (command.message === "fixture uncertain")
					write({
						type: "response",
						id: command.id,
						command: command.type,
						success: false,
						code: "rpc_delivery_unknown",
						error: "Isolated lost acknowledgement",
					});
				else ok();
				state.isStreaming = true;
				const user: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: command.message }],
					timestamp: Date.now(),
					entryId: crypto.randomUUID(),
				};
				messages.push(user);
				write({ type: "agent_start" });
				write({ type: "message_end", message: user });
				if (command.message === "fixture stream") {
					const answer: AgentMessage = {
						role: "assistant",
						content: [],
						timestamp: Date.now(),
						entryId: crypto.randomUUID(),
					};
					write({ type: "message_start", message: answer });
					streamChunks = 0;
					if (streamTimer) clearInterval(streamTimer);
					streamTimer = setInterval(() => {
						streamChunks++;
						write({
							type: "message_update",
							message: answer,
							assistantMessageEvent: {
								type: "text_delta",
								contentIndex: 0,
								delta: `Stream chunk ${streamChunks}.\n`,
								partial: answer,
							},
						});
					}, 16);
				} else if (command.message === "fixture approval") {
					write({
						type: "extension_ui_request",
						id: "approval",
						method: "select",
						title: `Allow tool: bash\n${"x".repeat(2200)}\ncritical final argument`,
						options: ["Approve", "Deny"],
					});
				} else if (command.message !== "fixture running") {
					const answer: AgentMessage = {
						role: "assistant",
						content: [
							{
								type: "text",
								text:
									command.message === "fixture math"
										? `只有统计口径相同时，才有：

\\[\\boxed{TPM = TPS \\times 60}\\]

- \\(P\\)：参数数量，例如 \\(8\\times10^9\\)。

那么，纯权重带宽模型下：

\\[
\\boxed{TPS_{\\text{decode}}\\approx \\frac{\\text{显存有效带宽，byte/s}}{\\text{每步读取的权重，byte}}}
\\]

纯生成阶段 TPS：

\\[
TPS_{\\text{decode}}
=
\\frac{500-1}{12-2}
=
49.9
\\]

减 1 是因为，第一个 token 已经在第 2 秒收到。

\\[
T_{\\text{请求}} = T_{\\text{排队等待}} + T_{\\text{网络传输}} + T_{\\text{输入预处理}} + T_{\\text{输入分词}} + T_{\\text{首令牌等待}} + \\frac{N_{\\text{输出令牌总数}}-1}{TPS_{\\text{decode}}} + T_{\\text{结果后处理}}
\\]`
										: command.message === "fixture annotations"
											? "Annotation example: **exact selected text** stays readable.\n\n```ts\nconst value = 1;\n  return value;\n```\n\nRemove this passage.\n\nDuplicate phrase. Duplicate phrase."
											: "Local fixture reply",
							},
						],
						timestamp: Date.now(),
						entryId: crypto.randomUUID(),
						stopReason: "stop",
					};
					messages.push(answer);
					write({ type: "message_end", message: answer });
					state.isStreaming = false;
					write({ type: "agent_end", messages: [answer], isTerminal: true });
				}
				break;
			}
			default:
				write({
					type: "response",
					id: command.id,
					command: command.type,
					success: false,
					error: `Fixture does not implement ${command.type}`,
				});
		}
	});
}
