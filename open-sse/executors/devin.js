// Native Devin executor — Connect-RPC protobuf over
// server.codeium.com /exa.api_server_pb.ApiServerService/GetChatMessage.
// Emits OpenAI-compatible SSE. Session tokens, request bytes and signatures
// are never logged or embedded in error messages.

import { createHash, randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  DEVIN_SERVER_BASE,
  DEVIN_CHAT_PATH,
  DEVIN_MODELS,
  DEVIN_DEFAULT_MAX_TOKENS,
  DEVIN_MAX_TOOL_CALLS,
  DEVIN_SOURCE_USER,
  DEVIN_SOURCE_ASSISTANT,
  DEVIN_SOURCE_TOOL,
  CONNECT_FLAG_DATA,
  CONNECT_FLAG_END_STREAM,
} from "../config/devin.js";
import {
  buildGetChatMessageRequest,
  wrapConnectEnvelope,
  createConnectFrameReader,
  parseChatFrame,
  parseResponseDimensionGroups,
  parseTrailerError,
  generateDevinSentryTrace,
  encodeToolId,
  decodeToolId,
  concatBytes,
} from "../utils/devinProtobuf.js";
import { resolveDevinModelUid } from "../utils/devinModels.js";
import { formatSessionToken } from "../shared/devinAuth.js";

const SIGNATURE_STORE_MAX = 2000;
const SIGNATURE_STORE_TTL_MS = 60 * 60 * 1000;
const SESSION_COUNTER_MAX = 5000;

// connectionId + encoded tool call id → {thinking, signature, signatureType, at}.
// Entries are scoped per connection so one account's signatures can never be
// reattached to another connection's conversation.
const signatureStore = new Map();
// sessionId → request ordinal (field 15.2)
const sessionTurnCounters = new Map();

function storeSetBound(map, key, value, max) {
  if (map.size >= max && !map.has(key)) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

function signatureStoreSet(owner, id, entry) {
  storeSetBound(signatureStore, `${owner}\u0000${id}`, { ...entry, at: Date.now() }, SIGNATURE_STORE_MAX);
}

function signatureStoreGet(owner, id) {
  const key = `${owner}\u0000${id}`;
  const entry = signatureStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SIGNATURE_STORE_TTL_MS) {
    signatureStore.delete(key);
    return null;
  }
  // Access refreshes recency — keep eviction true LRU, not insertion order.
  signatureStore.delete(key);
  signatureStore.set(key, entry);
  return entry;
}

function nextSessionTurnIndex(sessionId) {
  const n = sessionTurnCounters.get(sessionId) || 0;
  if (sessionTurnCounters.size >= SESSION_COUNTER_MAX && !sessionTurnCounters.has(sessionId)) {
    sessionTurnCounters.delete(sessionTurnCounters.keys().next().value);
  }
  sessionTurnCounters.delete(sessionId);
  sessionTurnCounters.set(sessionId, n + 1);
  return n;
}

// Test-only accessors for the module-level stores.
export function __devinStateSizes() {
  return { signatureStore: signatureStore.size, sessionTurnCounters: sessionTurnCounters.size };
}
export function __devinSessionTurnIndex(sessionId) {
  return nextSessionTurnIndex(sessionId);
}

function uuidFromHash(text) {
  const h = createHash("sha256").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function findCatalogModel(uid) {
  let best = null;
  for (const m of DEVIN_MODELS) {
    if (uid === m.id || uid.startsWith(m.id + "-") || uid.startsWith(m.id + "_")) {
      if (!best || m.id.length > best.id.length) best = m;
    }
  }
  return best;
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text")
      .map((p) => p.text || "")
      .join("");
  }
  return content == null ? "" : String(content);
}

function messageImages(content) {
  const images = [];
  if (!Array.isArray(content)) return images;
  for (const part of content) {
    if (!part || part.type !== "image_url") continue;
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (typeof url !== "string" || !url.startsWith("data:")) continue; // non-data URLs dropped
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!match || !match[3]) continue;
    images.push({ base64Data: match[3], mimeType: match[1] || "image/png" });
  }
  return images;
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function devinErrorResponse(status, message, code) {
  return new Response(JSON.stringify({ error: { message, type: "devin_error", code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class DevinExecutor extends BaseExecutor {
  constructor() {
    super("devin", PROVIDERS.devin || { baseUrl: DEVIN_SERVER_BASE + DEVIN_CHAT_PATH });
  }

  getBaseUrls() {
    return [DEVIN_SERVER_BASE + DEVIN_CHAT_PATH];
  }

  buildHeaders(credentials, stream = true) {
    const sessionToken = formatSessionToken(credentials?.accessToken || credentials?.apiKey || "");
    return {
      Authorization: `Basic ${sessionToken}-${sessionToken}`,
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      Accept: "*/*",
      "Sentry-Trace": generateDevinSentryTrace(),
    };
  }

  async refreshCredentials() {
    // Devin session tokens are permanent — nothing to refresh.
    return null;
  }

  // OpenAI messages → Devin prompt list + system prompt.
  mapMessages(messages, owner = "") {
    let systemPrompt = "";
    const prompts = [];
    const pendingToolIds = new Set();

    // An empty user turn is only fatal when it is the trailing user message;
    // mid-history empties are skipped (Go reference does the same).
    let lastUserIndex = -1;
    const msgList = messages || [];
    for (let i = msgList.length - 1; i >= 0; i--) {
      if (msgList[i]?.role === "user") { lastUserIndex = i; break; }
    }

    for (let i = 0; i < msgList.length; i++) {
      const msg = msgList[i];
      if (!msg || typeof msg !== "object") continue;
      const role = msg.role;
      if (role === "system" || role === "developer") {
        const text = messageContentText(msg.content);
        if (text) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
        continue;
      }
      if (role === "user") {
        const content = messageContentText(msg.content);
        const images = messageImages(msg.content);
        if (!content && images.length === 0) {
          if (i === lastUserIndex) return { emptyUserTurn: true, systemPrompt, prompts };
          continue;
        }
        prompts.push({ source: DEVIN_SOURCE_USER, content, images });
        continue;
      }
      if (role === "assistant") {
        const content = messageContentText(msg.content);
        const toolCalls = [];
        for (const tc of msg.tool_calls || []) {
          const fn = tc?.function || {};
          const decodedId = decodeToolId(tc?.id || "");
          toolCalls.push({
            id: decodedId,
            name: fn.name || "",
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? ""),
          });
          if (decodedId) pendingToolIds.add(decodedId);
        }

        // Signature reattach: a stored entry under any of this assistant's
        // tool call ids supplies thinking + signature + signatureType.
        let thinking = "";
        let signature = null;
        let signatureType = "";
        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            // The store is keyed by the *emitted* (encoded) id.
            const stored = signatureStoreGet(owner, encodeToolId(tc.id));
            if (stored) {
              thinking = stored.thinking || "";
              signature = stored.signature || null;
              signatureType = stored.signatureType || "";
              break;
            }
          }
        } else {
          // No tool calls → reasoning_content may be sent unsigned.
          thinking = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
        }

        prompts.push({ source: DEVIN_SOURCE_ASSISTANT, content, thinking, signature, signatureType, toolCalls });
        continue;
      }
      if (role === "tool") {
        const content = messageContentText(msg.content);
        const decodedId = decodeToolId(msg.tool_call_id || "");
        if (decodedId && pendingToolIds.has(decodedId)) {
          pendingToolIds.delete(decodedId);
          prompts.push({ source: DEVIN_SOURCE_TOOL, content, toolCallId: decodedId });
        } else {
          // Orphan tool result → downgrade to a user prompt.
          prompts.push({ source: DEVIN_SOURCE_USER, content });
        }
      }
    }
    return { emptyUserTurn: false, systemPrompt, prompts };
  }

  async execute({ model, body, stream, credentials, signal, log, upstreamExtraHeaders, proxyOptions = null, providerSessionId = null, providerOverrides = null }) {
    const sessionToken = formatSessionToken(credentials?.accessToken || credentials?.apiKey || "");
    const url = this.getBaseUrls()[0];
    const headers = this.buildHeaders(credentials);
    if (upstreamExtraHeaders) Object.assign(headers, upstreamExtraHeaders);
    if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);

    const b = body || {};
    const thinkingLevel = b.reasoning_effort ?? (typeof b.reasoning === "object" ? b.reasoning?.effort : "") ?? "";
    const budgetTokens = Number(b.thinking?.budget_tokens) || 0;
    const modelUid = resolveDevinModelUid(model, thinkingLevel, budgetTokens);

    const owner = credentials?.connectionId || "";
    const mapped = this.mapMessages(b.messages, owner);
    if (mapped.emptyUserTurn) {
      return {
        response: devinErrorResponse(400, "Devin request rejected: last user turn produced no text or image content", "invalid_request"),
        url,
        headers,
        transformedBody: { model: modelUid, prompts: 0 },
      };
    }

    const tools = [];
    for (const tool of b.tools || []) {
      if (!tool || tool.type !== "function" || !tool.function?.name) continue;
      const fn = tool.function;
      tools.push({
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters ? JSON.stringify(fn.parameters) : "",
      });
    }

    const catalog = findCatalogModel(modelUid);
    const requestedMax = b.max_completion_tokens || b.max_tokens || catalog?.maxCompletionTokens || DEVIN_DEFAULT_MAX_TOKENS;
    const maxTokens = catalog?.maxCompletionTokens ? Math.min(requestedMax, catalog.maxCompletionTokens) : requestedMax;
    const temperature = b.temperature ?? 1;

    // Stable session identity from providerSessionId preserves upstream prompt caching.
    const sessionId = uuidFromHash(`devin:${providerSessionId || randomUUID()}`);
    const cascadeId = sessionId;
    // Without a stable session id there is nothing to count turns against —
    // leave the counter map untouched.
    const turnIndex = providerSessionId ? nextSessionTurnIndex(sessionId) : 0;

    const protoPayload = buildGetChatMessageRequest({
      sessionToken,
      modelUid,
      systemPrompt: mapped.systemPrompt,
      prompts: mapped.prompts,
      tools,
      temperature,
      maxTokens,
      sessionId,
      cascadeId,
      turnIndex,
    });
    const framed = wrapConnectEnvelope(protoPayload, CONNECT_FLAG_DATA);

    log?.debug?.("DEVIN", `Devin → ${modelUid} (${mapped.prompts.length} prompts, ${tools.length} tools, turn ${turnIndex})`);

    const upstream = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: framed,
      signal,
    }, proxyOptions);

    const safeBody = { model: modelUid, prompts: mapped.prompts.length, tools: tools.length };

    if (!upstream.ok) {
      return { response: upstream, url, headers, transformedBody: safeBody };
    }

    // Pre-output gate: keep reading until a content-bearing frame (thinking,
    // content, or tool-call delta) or the end-stream frame arrives, so a
    // Connect error trailer behind inert frames can still surface as a normal
    // HTTP response instead of an empty SSE 200.
    const reader = upstream.body.getReader();
    const frameReader = createConnectFrameReader();
    const bufferedFrames = [];
    let sawContentFrame = false;
    let sawEndStream = false;
    try {
      while (!sawContentFrame && !sawEndStream) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        for (const f of frameReader.push(value)) {
          bufferedFrames.push(f);
          if (f.flag & CONNECT_FLAG_END_STREAM) {
            sawEndStream = true;
          } else if (!sawContentFrame) {
            try {
              const p = parseChatFrame(f.payload);
              if (p.contentText || p.thinkingText || p.toolCallDeltas.length) sawContentFrame = true;
            } catch { /* malformed data frames are skipped downstream too */ }
          }
        }
      }
    } catch (e) {
      reader.cancel().catch(() => {});
      return {
        response: devinErrorResponse(502, `devin stream decode error: ${e.message}`, "stream_decode_error"),
        url,
        headers,
        transformedBody: safeBody,
      };
    }

    for (const f of bufferedFrames) {
      if (f.flag & CONNECT_FLAG_END_STREAM) {
        const err = parseTrailerError(f.payload);
        if (err) {
          reader.cancel().catch(() => {});
          return {
            response: devinErrorResponse(err.status, err.message, err.code || err.status),
            url,
            headers,
            transformedBody: safeBody,
          };
        }
      }
    }

    const response = this.transformToSSE({ upstream, reader, frameReader, bufferedFrames, model, owner });
    return { response, url, headers, transformedBody: safeBody };
  }

  transformToSSE({ upstream, reader, frameReader, bufferedFrames, model, owner = "" }) {
    const responseId = `chatcmpl-devin-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const push = (obj) => controller.enqueue(encoder.encode(sseChunk(obj)));
        const chunk = (delta, finishReason = null, usage = null) => {
          const c = {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          };
          if (usage) c.usage = usage;
          push(c);
        };
        const errorEvent = (message) => {
          push({ error: { message, type: "devin_error" } });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };

        let roleSent = false;
        let sawOutput = false;
        let streamDone = false;
        let stopReason = 0;
        const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
        let respThinking = "";
        let respSignature = null;
        let respSignatureType = "";
        const toolBuilders = []; // {id, emitted}
        const emittedToolIds = [];

        const emitDelta = (delta) => {
          if (!roleSent) {
            chunk({ role: "assistant", ...delta });
            roleSent = true;
          } else {
            chunk(delta);
          }
        };

        const processFrame = (frame) => {
          let parsed;
          try {
            parsed = parseChatFrame(frame.payload);
          } catch {
            return;
          }
          if (parsed.thinkingText) {
            respThinking += parsed.thinkingText;
            sawOutput = true;
            emitDelta({ reasoning_content: parsed.thinkingText });
          }
          if (parsed.contentText) {
            sawOutput = true;
            emitDelta({ content: parsed.contentText });
          }
          if (parsed.deltaSignature) {
            respSignature = respSignature ? concatBytes(respSignature, parsed.deltaSignature) : parsed.deltaSignature;
          }
          if (parsed.deltaSignatureType) respSignatureType = parsed.deltaSignatureType;
          for (const tc of parsed.toolCallDeltas) {
            let builder = null;
            if (tc.id) {
              builder = toolBuilders.find((t) => t.id === tc.id) || null;
            }
            if (!builder) {
              if (tc.id) {
                if (toolBuilders.length >= DEVIN_MAX_TOOL_CALLS) continue;
                builder = { id: tc.id, emitted: false };
                toolBuilders.push(builder);
              } else {
                builder = toolBuilders[toolBuilders.length - 1] || null;
              }
            }
            if (!builder) continue;
            const index = toolBuilders.indexOf(builder);
            const argsText = tc.arguments || tc.invalidJsonStr || "";
            const toolDelta = { index };
            if (!builder.emitted) {
              builder.emitted = true;
              const encodedId = encodeToolId(builder.id || tc.id || "");
              emittedToolIds.push(encodedId);
              toolDelta.id = encodedId;
              toolDelta.type = "function";
              toolDelta.function = { name: tc.name || "", arguments: argsText };
            } else if (argsText) {
              toolDelta.function = { arguments: argsText };
            } else {
              continue;
            }
            sawOutput = true;
            emitDelta({ tool_calls: [toolDelta] });
          }
          if (parsed.usage) {
            if (parsed.usage.promptTokens) usage.promptTokens = parsed.usage.promptTokens;
            if (parsed.usage.completionTokens) usage.completionTokens = parsed.usage.completionTokens;
            if (parsed.usage.cachedTokens) usage.cachedTokens = parsed.usage.cachedTokens;
            if (parsed.usage.cacheWriteTokens) usage.cacheWriteTokens = parsed.usage.cacheWriteTokens;
          }
          if (parsed.responseDimensionGroups.length) {
            const dims = parseResponseDimensionGroups(...parsed.responseDimensionGroups);
            if (dims.found) {
              // Dimension groups only fill fields the usage field (7) left at 0.
              if (!usage.promptTokens) usage.promptTokens = dims.promptTokens;
              if (!usage.completionTokens) usage.completionTokens = dims.completionTokens;
              if (!usage.cachedTokens) usage.cachedTokens = dims.cachedTokens;
            }
          }
          if (parsed.stopReason) stopReason = parsed.stopReason;
        };

        try {
          for (const f of bufferedFrames) {
            if (f.flag & CONNECT_FLAG_END_STREAM) {
              streamDone = true;
              const err = parseTrailerError(f.payload);
              if (err) return errorEvent(err.message);
              continue;
            }
            processFrame(f);
          }

          if (!streamDone) {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value || !value.length) continue;
              for (const f of frameReader.push(value)) {
                if (f.flag & CONNECT_FLAG_END_STREAM) {
                  streamDone = true;
                  const err = parseTrailerError(f.payload);
                  if (err) return errorEvent(err.message);
                  continue;
                }
                processFrame(f);
              }
            }
          }

          if (!streamDone) {
            return errorEvent("devin stream ended without an end-stream frame");
          }
          if (!sawOutput && stopReason !== 11) {
            return errorEvent("devin upstream returned an empty completion");
          }

          // Persist signature context under every emitted (encoded) tool call id.
          if (respSignature || respThinking) {
            for (const id of emittedToolIds) {
              signatureStoreSet(owner, id, { thinking: respThinking, signature: respSignature, signatureType: respSignatureType });
            }
          }

          const finishReason = toolBuilders.length > 0
            ? "tool_calls"
            : stopReason === 1 || stopReason === 3
              ? "length"
              : stopReason === 11
                ? "content_filter"
                : "stop";

          const promptTokens = usage.promptTokens + usage.cachedTokens + usage.cacheWriteTokens;
          const completionTokens = usage.completionTokens;
          chunk({}, finishReason, {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            prompt_tokens_details: { cached_tokens: usage.cachedTokens },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (e) {
          if (e?.name === "AbortError") {
            try { controller.close(); } catch {}
            return;
          }
          return errorEvent(`devin stream error: ${e.message}`);
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      },
      cancel() {
        try { reader.cancel(); } catch {}
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}
