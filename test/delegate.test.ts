import { expect, test } from "bun:test";
import { fakeMuse, isolated, temporary, testCatalog } from "./helpers.ts";
import { prepareMuseContext } from "../src/context.ts";
import {
	buildOmpTaskArgs,
	isChildApproval,
	parseSubagentSpawnArgs,
	parseSubagentSpawnResult,
	pickDenyChoice,
	TurnRun,
	type Frame,
	type MuseRequester,
} from "../src/msp.ts";
import { delegateRedirectEnabled, museHarnessArgs } from "../src/runtime.ts";

function recordingHost() {
	const requests: Array<{ method: string; params: Frame }> = [];
	const host: MuseRequester = {
		request: (method: string, params: Frame) => {
			requests.push({ method, params });
			return Promise.resolve({});
		},
	};
	return { requests, host };
}

const spawnItem = (): Frame => ({
	sessionId: "session-1",
	item: {
		itemId: "spawn-1", kind: "toolCall", turnId: "parent-turn", status: "completed",
		tool: "subagent_spawn", callId: "call_1",
		args: JSON.stringify({ command_id: "c1", role: "general-purpose", objective: "do the thing" }),
		visibleOutput: JSON.stringify({ status: "accepted", subagent_id: "subagent-1" }),
	},
});

const childApproval = (): Frame => ({
	sessionId: "session-1",
	approvalId: "a1", turnId: "child-turn", itemId: "i1", toolName: "bash", rawArgs: "{}",
	currentRequirementId: { approvalId: "a1", sourceIndex: 0 },
	availableChoices: [
		{ choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
		{ choiceId: "abort", decision: "abort", label: "Reject", scope: "once" },
	],
});

test("spawn args parse; task args carry the objective as task", () => {
	const spawn = parseSubagentSpawnArgs(JSON.stringify({ command_id: "c1", role: "general-purpose", objective: "do the thing" }));
	expect(spawn?.objective).toBe("do the thing");
	expect(spawn?.role).toBe("general-purpose");
	expect(buildOmpTaskArgs(spawn!)).toEqual({ task: "do the thing" });
	expect(parseSubagentSpawnArgs("not json")).toBeUndefined();
	expect(parseSubagentSpawnArgs(JSON.stringify({ role: "x" }))).toBeUndefined();
	expect(parseSubagentSpawnResult(JSON.stringify({ status: "accepted", subagent_id: "subagent-1" }))).toBe("subagent-1");
	expect(parseSubagentSpawnResult("garbage")).toBeUndefined();
});

test("deny choice prefers a once-scoped denial; child approval is a foreign turn", () => {
	const choices = [
		{ choiceId: "allow", decision: "approved", label: "Allow", scope: "once" },
		{ choiceId: "deny", decision: "denied", label: "Deny", scope: "once" },
	];
	expect(pickDenyChoice(choices)?.choiceId).toBe("deny");
	expect(pickDenyChoice([{ choiceId: "allow", decision: "approved", label: "A", scope: "once" }])).toBeUndefined();
	expect(isChildApproval("child-turn", "parent-turn")).toBe(true);
	expect(isChildApproval("parent-turn", "parent-turn")).toBe(false);
	expect(isChildApproval("", "parent-turn")).toBe(false);
});

test("redirect is default-on; PI_MUSE_DELEGATE_VIA_OMP=0 opts out", () => {
	expect(delegateRedirectEnabled({ PI_MUSE_DELEGATE_VIA_OMP: "1" })).toBe(true);
	expect(delegateRedirectEnabled({})).toBe(true);
	expect(delegateRedirectEnabled({ PI_MUSE_DELEGATE_VIA_OMP: "0" })).toBe(false);
});

test("delegate posture enables native spawns without exec-only flags", () => {
	expect(museHarnessArgs({ PI_MUSE_DELEGATE_VIA_OMP: "1" })).toEqual(["-c", 'run.subagent_delegation_mode="auto"']);
	expect(museHarnessArgs({})).toEqual(["-c", 'run.subagent_delegation_mode="auto"']);
	expect(museHarnessArgs({ PI_MUSE_DELEGATE_VIA_OMP: "0" })).toEqual(["-c", 'run.subagent_delegation_mode="off"', "-c", 'run.toolset=["web_search"]']);
});

test("child approval takes over: stop, interrupt, marker, no decide", async () => {
	const { requests, host } = recordingHost();
	const run = new TurnRun({ host, sessionId: "session-1", delegateViaOmp: true });
	run.turnId = "parent-turn";
	run.turnSubmitted = true;
	run.handleNotification("item/completed", spawnItem());
	run.handleNotification("approval/requested", childApproval());
	// Duplicate durable fold of the same approval must not double-act.
	run.handleNotification("approval/request", childApproval());
	await new Promise((resolve) => setTimeout(resolve, 0));
	const methods = requests.map((request) => request.method);
	expect(methods).toContain("subagent/stop");
	expect(methods).toContain("turn/interrupt");
	expect(methods).not.toContain("approval/decide");
	expect(requests.filter((request) => request.method === "subagent/stop")).toHaveLength(1);
	expect(requests.find((request) => request.method === "subagent/stop")?.params.subagentId).toBe("subagent-1");
	expect(run.delegateRedirect?.objective).toBe("do the thing");
	run.settle();
});

test("spawn without a child id resolves natively instead of taking over", async () => {
	const { requests, host } = recordingHost();
	const run = new TurnRun({ host, sessionId: "session-1", delegateViaOmp: true });
	run.turnId = "parent-turn";
	run.turnSubmitted = true;
	const spawn = spawnItem();
	(spawn.item as Frame).visibleOutput = JSON.stringify({ status: "accepted" });
	run.handleNotification("item/completed", spawn);
	run.handleNotification("approval/requested", childApproval());
	await new Promise((resolve) => setTimeout(resolve, 0));
	const decide = requests.find((request) => request.method === "approval/decide");
	expect(decide?.params.choiceId).toBe("abort");
	expect(requests.map((request) => request.method)).not.toContain("subagent/stop");
	expect(requests.map((request) => request.method)).not.toContain("turn/interrupt");
	expect(run.delegateRedirect).toBeUndefined();
	run.settle();
});

test("without the flag the same wire traffic runs natively", async () => {
	const { requests, host } = recordingHost();
	const run = new TurnRun({ host, sessionId: "session-1" });
	run.turnId = "parent-turn";
	run.turnSubmitted = true;
	run.handleNotification("item/completed", spawnItem());
	run.handleNotification("approval/requested", childApproval());
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(requests).toHaveLength(0);
	expect(run.delegateRedirect).toBeUndefined();
	run.settle();
});

test("long tool results survive for the next turn", () => {
	const payload = "R".repeat(2000);
	const seed = prepareMuseContext({
		messages: [
			{ role: "user", content: "CURRENT_TASK", timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "working" }], api: "x", provider: "x", model: "x", stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
			{ role: "toolResult", content: payload, toolName: "task", toolCallId: "t1", timestamp: 0 },
		],
	}, "/workspace").initialPrompt();
	expect(seed).toContain(payload);
});

test("delegate takeover emits an OMP task call and resumes after the result", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `
		let turns = 0;
		function onRequest(request) {
			if (request.method === "turn/interrupt") {
				reply(request, {turnId: request.params.turnId});
				notify("turn/completed", {sessionId: request.params.sessionId, turnId: request.params.turnId, terminal: "cancelled"});
				return true;
			}
			if (request.method !== "turn/start") return false;
			const params = request.params;
			turns++;
			reply(request, {turnId: params.commandId});
			if (turns === 1) {
				notify("item/completed", {sessionId: params.sessionId, item: {itemId: "spawn-1", kind: "toolCall", turnId: params.commandId, status: "completed", tool: "subagent_spawn", callId: "call_1",
					args: JSON.stringify({command_id: "c1", role: "general-purpose", objective: "OBJECTIVE_TEXT"}),
					visibleOutput: JSON.stringify({status: "accepted", subagent_id: "subagent-1"})}});
				notify("approval/requested", {sessionId: params.sessionId, approvalId: "a1", turnId: "child-turn", itemId: "i1", toolName: "bash", rawArgs: "{}",
					currentRequirementId: {approvalId: "a1", sourceIndex: 0},
					availableChoices: [{choiceId: "allow", decision: "approved", label: "A", scope: "once"}, {choiceId: "deny", decision: "denied", label: "D", scope: "once"}]});
			} else {
				notify("item/completed", {sessionId: params.sessionId, item: {itemId: "answer", kind: "agentMessage", turnId: params.commandId, status: "completed", text: "AFTER_REDIRECT"}});
				notify("turn/completed", {sessionId: params.sessionId, turnId: params.commandId, terminal: "completed"});
			}
			return true;
		}
	`);
	const result = await isolated(`
import assert from "node:assert/strict";
import {setAgentDir} from "@oh-my-pi/pi-utils";
import {streamMuse} from "./src/provider.ts";
import {shutdownHost} from "./src/msp.ts";
setAgentDir(process.env.TEST_DIR);
const model = {id: "muse-test", name: "Muse test", reasoning: true, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 100000, maxTokens: 10000, api: "muse-code-cli", provider: "muse-bridge", baseUrl: "http://localhost"};
const user = text => ({role: "user", content: text, timestamp: 0});
const invoke = (messages, state) => streamMuse(model, {systemPrompt: ["# Role\\nSEED_SYSTEM"], messages}, {sessionId: "omp-delegate", providerSessionState: state}, {workspace: process.env.TEST_DIR}).result();
const state = new Map();
const messages = [user("DELEGATE_ME")];
try {
	const first = await invoke(messages, state);
	assert.equal(first.stopReason, "toolUse", first.errorMessage);
	const call = first.content.find(part => part.type === "toolCall");
	assert.equal(call?.name, "task");
	assert.equal(call?.arguments?.task, "OBJECTIVE_TEXT");
	messages.push(first, {role: "toolResult", content: "OMP_RESULT_TEXT", toolName: "task", toolCallId: call.id, timestamp: 0});
	const second = await invoke(messages, state);
	assert.equal(second.stopReason, "stop", second.errorMessage);
	const text = second.content.filter(part => part.type === "text").map(part => part.text).join("");
	assert.match(text, /AFTER_REDIRECT/);
} finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable, PI_MUSE_DELEGATE_VIA_OMP: "1" });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("omp delegation sections survive the tool-doc strip", () => {
	const seed = prepareMuseContext({
		systemPrompt: ["# Delegation\nDELEGATE_VIA_TASK\n# Tools\nDROP_TOOL"],
		messages: [{ role: "user", content: "CURRENT_TASK", timestamp: 0 }],
	}, "/workspace").initialPrompt();
	expect(seed).toContain("DELEGATE_VIA_TASK");
	expect(seed).not.toContain("DROP_TOOL");
});
