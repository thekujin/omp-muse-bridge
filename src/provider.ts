import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getMuseCatalog, hasLiveMuseCatalog, setLiveMuseCatalog, type MuseCatalog, type MuseCatalogModel } from "./catalog.ts";
import { runMuse } from "./runtime.ts";
import { buildOmpTaskArgs, HostUnavailableError, listMuseCatalog, type MuseTodoEntry, MuseSessionUnusableError, runMuseTurn, shutdownHost, steerActiveMuseRuns, uuidv7 } from "./msp.ts";
import { contextCheckpoint, prepareMuseContext, type MusePromptContext } from "./context.ts";
import { registerMusePlanDisplay } from "./plan.ts";
import { readMuseSession, writeMuseSession, type StoredMuseSession } from "./session-store.ts";
import type { MuseUsage } from "./contracts.ts";
import { museUsageProvider } from "./usage.ts";

const MUSE_API = "muse-code-cli" as Api;
const ALIAS_ID = "muse-spark";

/**
 * Meta Model API list prices ($/1M tokens) applied when the catalog row has no
 * cost (`cost: null` → all-zero). Sources: Meta developer pricing page via
 * TechCrunch/betanews (wonder $4/$20/$0.20), Meta list prices via orcarouter
 * (spark $1.25/$4.25/$0.15) and codersera (spark-contributor $0.10/$0.20/$0.002).
 * Wonder-contributor has no published distinct rate, so it inherits wonder.
 */
const KNOWN_API_COSTS: Record<string, MuseCatalogModel["cost"]> = {
	"muse-wonder-1.0": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	"muse-spark-1.3": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
	"muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
};

/** Keep live/catalog rates when present; fill all-zero costs from the known API card. */
function costFor(id: string, model: MuseCatalogModel) {
	const cost = model.cost;
	if (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0) return cost;
	return KNOWN_API_COSTS[id] ?? KNOWN_API_COSTS[model.id] ?? cost;
}

function modelDefinition(model: MuseCatalogModel, id = model.id, name = model.name) {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: { off: "off", xhigh: "xhigh", max: "max" },
		input: ["text"] as Array<"text" | "image">,
		cost: costFor(id, model),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/** Picker entries for a catalog: the alias tracks Muse's default row. */
function museProviderModels(catalog: MuseCatalog) {
	const defaultModel = catalog.models.find((model) => model.id === catalog.defaultId) ?? catalog.models[0];
	const models = [modelDefinition(defaultModel, ALIAS_ID, `Muse default (${defaultModel.id})`),
		...catalog.models.filter((model) => model.id !== ALIAS_ID && !model.id.endsWith("-contributor"))
			.map((model) => modelDefinition(model))];
	return models.flatMap((model) => [
		model,
		{ ...model, id: `${model.id}-contributor`, name: `${model.name} (contributor)`, cost: KNOWN_API_COSTS[`${model.id}-contributor`] ?? model.cost },
	]);
}

/**
 * OMP `fetchDynamicModels`: Muse's live `model/list`. The on-disk cache stands in only when that listing fails; with
 * no cache the listing error is rethrown rather than replaced by invented models.
 */
export async function discoverMuseModels(sandboxed: boolean) {
	let catalog: MuseCatalog;
	try {
		catalog = await listMuseCatalog(sandboxed);
		setLiveMuseCatalog(catalog);
	} catch (error) {
		try {
			catalog = getMuseCatalog();
		} catch {
			throw error;
		}
	}
	return museProviderModels(catalog);
}

interface MuseProviderSessionState extends Omit<StoredMuseSession, "updatedAt"> {
	ompSessionId: string;
	busy: boolean;
	closed: boolean;
	close(): void;
	/** Held across an OMP tool loop after a delegate takeover: re-entry starts one fresh host turn. */
	awaitingOmpResult?: boolean;
	/** Delegation already running as an OMP `task`: matching respawns are stopped, never re-emitted. */
	pendingDelegate?: { objective: string; toolCallId: string };
}

export interface MuseStreamSettings {
	sandboxed?: boolean;
	workspace?: string;
	onDiagnostic?: (message: string) => void;
	onTodoSnapshot?: (entries: MuseTodoEntry[]) => void;
}

async function persistSession(state: MuseProviderSessionState, diagnostic?: (message: string) => void): Promise<void> {
	if (state.closed) return;
	try {
		await writeMuseSession(state.ompSessionId, {
			sessionId: state.sessionId,
			initialized: state.initialized,
			checkpoint: state.checkpoint,
			systemPrompt: state.systemPrompt,
			contributor: state.contributor,
		});
	} catch (error) {
		diagnostic?.(`Muse session continuity could not be saved: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Reuse a backend only when its owner, instructions and committed OMP history still match. */
async function museSessionState(
	options: SimpleStreamOptions | undefined,
	prepared: MusePromptContext,
	contributor: boolean,
	diagnostic?: (message: string) => void,
): Promise<MuseProviderSessionState | undefined> {
	if (!options?.sessionId || !options.providerSessionState) return undefined;
	let state = options.providerSessionState.get(MUSE_API) as MuseProviderSessionState | undefined;
	if (state && (state.closed || state.ompSessionId !== options.sessionId)) {
		options.providerSessionState.delete(MUSE_API);
		state = undefined;
	}
	if (state?.busy) {
		// OMP tool loop after a delegate takeover: attach for one fresh host turn carrying the task result.
		if (state.awaitingOmpResult) {
			state.awaitingOmpResult = false;
			state.sessionId = uuidv7();
			state.initialized = false;
			state.contributor = contributor;
			state.systemPrompt = prepared.systemPrompt;
			state.checkpoint = undefined;
			await persistSession(state, diagnostic);
			return state;
		}
		throw new Error("This OMP session already has an active Muse request");
	}
	if (!state) {
		state = {
			ompSessionId: options.sessionId,
			sessionId: uuidv7(),
			initialized: false,
			checkpoint: prepared.checkpoint,
			systemPrompt: prepared.systemPrompt,
			contributor,
			busy: true,
			closed: false,
			close() { this.closed = true; },
		};
		options.providerSessionState.set(MUSE_API, state);
		try {
			const remembered = await readMuseSession(options.sessionId);
			// Legacy records name no mode, so their mode stays unknown and never matches the current model.
			if (remembered) Object.assign(state, remembered, { contributor: remembered.contributor });
		} catch (error) {
			diagnostic?.(`Muse session continuity could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		state.busy = true;
	}
	const modeChanged = state.contributor !== contributor;
	if (modeChanged || state.checkpoint !== prepared.checkpoint || state.systemPrompt !== prepared.systemPrompt) {
		state.sessionId = uuidv7();
		state.initialized = false;
		diagnostic?.(modeChanged
			? "Muse mode changed; seeding a new Muse session from the current conversation"
			: "OMP context changed; seeding a new Muse session from the current conversation");
	}
	state.contributor = contributor;
	state.systemPrompt = prepared.systemPrompt;
	// An interrupted process must not leave a checkpoint claiming unfinished work was committed.
	state.checkpoint = undefined;
	await persistSession(state, diagnostic);
	return state;
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Adapt a Muse-owned run to OMP's assistant stream without exposing native tool calls. */
export function streamMuse(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	settings: MuseStreamSettings = {},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyMessage(model);
	const startedAt = performance.now();
	const markFirstToken = () => { output.ttft ??= performance.now() - startedAt; };
	const recordDuration = () => { output.duration = performance.now() - startedAt; };
	const diagnostic = settings.onDiagnostic;
	const contributor = model.id.endsWith("-contributor");

	void (async () => {
		let sessionState: MuseProviderSessionState | undefined;
		// Release before publishing a terminal; later continuations must not unlock a successor's request.
		const releaseSession = () => {
			if (!sessionState) return;
			sessionState.busy = false;
			sessionState = undefined;
		};
		let openBlock: { type: "text" | "thinking"; index: number; itemId?: string } | undefined;
		const itemBlocks = new Map<string, number[]>();

		const closeOpenBlock = () => {
			const current = openBlock;
			if (!current) return;
			const block = output.content[current.index];
			if (current.type === "text" && block?.type === "text") {
				stream.push({ type: "text_end", contentIndex: current.index, content: block.text, partial: output });
			} else if (current.type === "thinking" && block?.type === "thinking") {
				stream.push({ type: "thinking_end", contentIndex: current.index, content: block.thinking, partial: output });
			}
			openBlock = undefined;
		};

		const pushTextDelta = (delta: string, itemId = "exec") => {
			if (!delta) return;
			if (openBlock?.type !== "text" || openBlock.itemId !== itemId) {
				closeOpenBlock();
				const index = output.content.length;
				output.content.push({ type: "text", text: "" });
				openBlock = { type: "text", index, itemId };
				const indices = itemBlocks.get(itemId) ?? [];
				indices.push(index);
				itemBlocks.set(itemId, indices);
				stream.push({ type: "text_start", contentIndex: index, partial: output });
			}
			const block = output.content[openBlock.index];
			if (block.type !== "text") return;
			block.text += delta;
			stream.push({ type: "text_delta", contentIndex: openBlock.index, delta, partial: output });
		};

		const replaceTextBlocks = (indices: number[], text: string) => {
			closeOpenBlock();
			for (let position = 0; position < indices.length; position++) {
				const index = indices[position];
				const block = output.content[index];
				if (block.type !== "text") continue;
				block.text = position === 0 ? text : "";
				stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			}
		};

		const reconcileItem = (itemId: string, text: string) => {
			const indices = itemBlocks.get(itemId) ?? [];
			const partial = indices.map((index) => {
				const block = output.content[index];
				return block.type === "text" ? block.text : "";
			}).join("");
			if (partial === text) return;
			if (text.startsWith(partial)) pushTextDelta(text.slice(partial.length), itemId);
			else replaceTextBlocks(indices, text);
		};

		const reconcileFinalText = (text: string) => {
			const indices: number[] = [];
			let partial = "";
			for (let index = 0; index < output.content.length; index++) {
				const block = output.content[index];
				if (block.type !== "text") continue;
				indices.push(index);
				partial += block.text;
			}
			if (partial === text) return;
			if (text.startsWith(partial)) pushTextDelta(text.slice(partial.length), "terminal");
			else replaceTextBlocks(indices, text);
		};

		const pushThinkingDelta = (delta: string) => {
			if (!delta) return;
			if (openBlock?.type !== "thinking") {
				closeOpenBlock();
				const index = output.content.length;
				output.content.push({ type: "thinking", thinking: "" });
				openBlock = { type: "thinking", index };
				stream.push({ type: "thinking_start", contentIndex: index, partial: output });
			}
			const block = output.content[openBlock.index];
			if (block.type !== "thinking") return;
			block.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: openBlock.index, delta, partial: output });
		};

		const setUsage = (usage: MuseUsage) => {
			output.usage.input = usage.input;
			output.usage.output = usage.output;
			output.usage.cacheRead = usage.cacheRead;
			output.usage.cacheWrite = usage.cacheWrite;
			output.usage.totalTokens = usage.totalTokens;
			calculateCost(model, output.usage);
			if (Number.isFinite(usage.cost) && usage.cost > 0) {
				output.usage.cost.total = usage.cost;
			}
			if (usage.contextTokens !== undefined) {
				output.contextSnapshot = { promptTokens: usage.contextTokens, nonMessageTokens: 0 };
			}
		};

		const finish = async () => {
			closeOpenBlock();
			recordDuration();
			output.stopReason = "stop";
			if (sessionState) {
				sessionState.initialized = true;
				sessionState.checkpoint = contextCheckpoint(context.messages, context.messages.length, output);
				// The tool result was consumed by a clean turn: the delegation is no longer in flight.
				sessionState.pendingDelegate = undefined;
				await persistSession(sessionState, diagnostic);
			}
			releaseSession();
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		};

		try {
			stream.push({ type: "start", partial: output });
			if (options?.signal?.aborted) throw new Error("Muse turn was interrupted");
			// Execution resolves model IDs against Muse's live list; the local cache is used only when that listing fails.
			if (!hasLiveMuseCatalog()) {
				try {
					setLiveMuseCatalog(await listMuseCatalog(settings.sandboxed === true));
				} catch (error) {
					diagnostic?.(`Muse model/list unavailable; resolving models from the local cache (${error instanceof Error ? error.message : String(error)})`);
				}
			}
			const workspace = settings.workspace ?? process.cwd();
			const prepared = prepareMuseContext(context, workspace);
			sessionState = await museSessionState(options, prepared, contributor, diagnostic);
			const thinkingLevel = options?.disableReasoning ? "off" : options?.reasoning;
			if (sessionState) {
				try {
					const runTurn = () => runMuseTurn({
						sessionId: sessionState!.sessionId,
						resumeExisting: sessionState!.initialized,
						prompt: prepared.task,
						initialPrompt: prepared.initialPrompt,
						modelId: model.id,
						workspace,
						thinkingLevel,
						sandboxed: settings.sandboxed === true,
						signal: options?.signal,
						onTextDelta: (delta, itemId) => { if (delta) markFirstToken(); pushTextDelta(delta, itemId); },
						onTextSnapshot: (itemId, text) => { if (text) markFirstToken(); reconcileItem(itemId, text); },
						onReasoningDelta: options?.hideThinkingSummary ? undefined : (delta) => { if (delta) markFirstToken(); pushThinkingDelta(delta); },
						onActivityDelta: pushThinkingDelta,
						onTodoSnapshot: settings.onTodoSnapshot,
						activeDelegateObjective: sessionState!.pendingDelegate?.objective,
					});
					let outcome: Awaited<ReturnType<typeof runMuseTurn>>;
					try {
						outcome = await runTurn();
					} catch (error) {
						if (!(error instanceof MuseSessionUnusableError)) throw error;
						diagnostic?.(`${error.message}; seeding a replacement Muse session`);
						sessionState.sessionId = uuidv7();
						sessionState.initialized = false;
						await persistSession(sessionState, diagnostic);
						outcome = await runTurn();
					}
					for (const message of outcome.diagnostics) diagnostic?.(message);
					reconcileFinalText(outcome.output || (outcome.errorMessage ? "" : "(no output from Muse)"));
					setUsage(outcome.usage);
					if (outcome.delegateRedirect) {
						closeOpenBlock();
						recordDuration();
						const taskIndex = output.content.length;
						const toolCallId = uuidv7();
						const taskCall = { type: "toolCall" as const, id: toolCallId, name: "task", arguments: buildOmpTaskArgs(outcome.delegateRedirect) };
						output.content.push(taskCall);
						output.stopReason = "toolUse";
						stream.push({ type: "toolcall_start", contentIndex: taskIndex, partial: output });
						stream.push({ type: "toolcall_end", contentIndex: taskIndex, toolCall: taskCall, partial: output });
						// Hold the OMP session across the tool loop; re-entry starts one fresh host turn.
						// The objective stays in flight so a Muse retry is stopped, never a second task.
						sessionState.sessionId = uuidv7();
						sessionState.initialized = false;
						sessionState.awaitingOmpResult = true;
						sessionState.pendingDelegate = { objective: outcome.delegateRedirect.objective, toolCallId };
						await persistSession(sessionState, diagnostic);
						sessionState = undefined;
						stream.push({ type: "done", reason: "toolUse", message: output });
						stream.end();
						return;
					}
					if (outcome.errorMessage) {
						if (outcome.aborted) output.stopReason = "aborted";
						throw new Error(outcome.errorMessage);
					}
					if (outcome.duplicateSuppressed) {
						// The OMP task still runs: keep the objective in flight so the
						// next retry is stopped too, never a second task.
						closeOpenBlock();
						recordDuration();
						output.stopReason = "stop";
						if (sessionState) {
							sessionState.initialized = true;
							sessionState.checkpoint = contextCheckpoint(context.messages, context.messages.length, output);
							await persistSession(sessionState, diagnostic);
						}
						releaseSession();
						stream.push({ type: "done", reason: "stop", message: output });
						stream.end();
						return;
					}
					await finish();
					return;
				} catch (error) {
					if (!(error instanceof HostUnavailableError) || options?.signal?.aborted) throw error;
					diagnostic?.(`Muse host unavailable (${error.message}); using exec fallback`);
					pushThinkingDelta("Host unavailable; using exec fallback without live activity, steering or todo updates.\n");
				}
			}
			if (options?.signal?.aborted) throw new Error("Muse turn was interrupted");
			const result = await runMuse({
				prompt: sessionState?.initialized ? prepared.task : prepared.initialPrompt(),
				cwd: workspace,
				model: model.id,
				thinkingLevel,
				yolo: settings.sandboxed !== true,
				signal: options?.signal,
				sessionId: sessionState?.sessionId,
				onTextDelta: (delta) => { if (delta) markFirstToken(); pushTextDelta(delta); },
			});
			for (const message of result.diagnostics) diagnostic?.(message);
			reconcileFinalText(result.output);
			setUsage(result.usage);
			if (result.exitCode !== 0) throw new Error(result.errorMessage || `Muse exited with code ${result.exitCode}`);
			if (sessionState && result.sessionId) sessionState.sessionId = result.sessionId;
			await finish();
		} catch (error) {
			recordDuration();
			closeOpenBlock();
			output.stopReason = output.stopReason === "aborted" || options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			releaseSession();
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			releaseSession();
		}
	})();
	return stream;
}

function sandboxedFromEnvironment(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_MUSE_SANDBOXED?.trim() ?? "");
}

/** Register the provider and route interactive steering only to Muse-owned runs. */
export function registerMuseProvider(pi: ExtensionAPI): void {
	const plans = registerMusePlanDisplay(pi);
	pi.registerFlag("muse-sandboxed", {
		description: "Run Muse with its sandbox enabled and approval prompts disabled",
		type: "boolean",
		default: false,
	});
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || ctx.model?.provider !== "muse-bridge") return;
		// Commands and explicit OMP queue markers retain OMP's parsing semantics.
		const trimmed = event.text.trimStart();
		if (trimmed.startsWith("/") || trimmed.startsWith("->") || trimmed.startsWith("=>")) return;
		if (!event.text.trim() && !(event.images?.length ?? 0)) return;
		const thinkingLevel = pi.getThinkingLevel();
		if (await steerActiveMuseRuns(event.text, event.images, thinkingLevel === "inherit" ? undefined : thinkingLevel)) {
			// Persist the echo without starting an OMP continuation while Muse owns the turn.
			pi.sendMessage({ customType: "muse-steer", content: event.text, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
			ctx.ui.notify("steered Muse", "info");
			return { handled: true };
		}
	});
	pi.registerMessageRenderer("muse-steer", (message) => {
		const content = message.content;
		const text = typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
		const lines = text.split("\n");
		return { render: () => [`↳ steered Muse: ${lines[0] ?? ""}`, ...lines.slice(1).map((line) => `  ${line}`)] };
	});
	pi.on("session_shutdown", () => shutdownHost());
	pi.on("session_stop", async (_event, ctx) => {
		if (ctx.model?.provider !== "muse-bridge") return;
		try {
			const usage = ctx.modelRegistry.authStorage;
			await usage.invalidateUsageCache("muse-bridge");
			await usage.fetchUsageReports();
		} catch {
			// Usage refresh must not fail a completed turn.
		}
	});
	pi.registerProvider("muse-bridge", {
		baseUrl: "http://localhost",
		apiKey: "muse-bridge-local",
		api: MUSE_API,
		usage: museUsageProvider,
		fetchDynamicModels: () => discoverMuseModels(pi.getFlag("muse-sandboxed") === true || sandboxedFromEnvironment()),
		streamSimple: (model, context, options) => streamMuse(model, context, options, {
			sandboxed: pi.getFlag("muse-sandboxed") === true || sandboxedFromEnvironment(),
			onDiagnostic: (message) => pi.logger.warn("omp-muse-bridge diagnostic", { message }),
			onTodoSnapshot: plans.forTurn(),
		}),
	});
}
