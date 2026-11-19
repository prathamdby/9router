// Devin executor — Connect-RPC request construction + OpenAI SSE output.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  encodeStringField,
  encodeVarintField,
  encodeBytesField,
  concatBytes,
  wrapConnectEnvelope,
  decodeProtoFields,
  encodeToolId,
} from "open-sse/utils/devinProtobuf.js";
import { DEVIN_TOOL_ID_PREFIX, DEVIN_SERVER_BASE, DEVIN_CHAT_PATH } from "open-sse/config/devin.js";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

const { DevinExecutor, __devinStateSizes, __devinSessionTurnIndex } = await import("open-sse/executors/devin.js");

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHAT_URL = DEVIN_SERVER_BASE + DEVIN_CHAT_PATH;

function streamOf(chunks) {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch instanceof Uint8Array ? ch : enc.encode(ch));
      c.close();
    },
  });
}

function upstreamResponse(frames) {
  return new Response(streamOf(frames), { status: 200 });
}

async function sseEvents(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => {
      const data = b.slice(5).trim();
      return data === "[DONE]" ? "[DONE]" : JSON.parse(data);
    });
}

const baseArgs = (body = {}, extra = {}) => ({
  model: "swe-2",
  body: {
    messages: [{ role: "user", content: "hi" }],
    ...body,
  },
  stream: true,
  credentials: { accessToken: "devin-session-token$abc" },
  providerSessionId: "conn-1",
  log: null,
  signal: undefined,
  ...extra,
});

describe("DevinExecutor", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("streams text deltas as OpenAI SSE with usage + [DONE]", async () => {
    const frames = [
      wrapConnectEnvelope(concatBytes(encodeStringField(3, "Hello"))),
      wrapConnectEnvelope(concatBytes(
        encodeStringField(3, " world"),
        encodeBytesField(7, concatBytes(encodeVarintField(2, 10), encodeVarintField(3, 2), encodeVarintField(5, 4))),
        encodeVarintField(5, 4),
      )),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ];
    fetchMock.mockResolvedValue(upstreamResponse(frames));

    const ex = new DevinExecutor();
    const { response } = await ex.execute(baseArgs());
    const events = await sseEvents(response);

    const texts = events.flatMap((e) => e.choices?.[0]?.delta?.content ? [e.choices[0].delta.content] : []);
    expect(texts.join("")).toBe("Hello world");
    expect(events[0].choices[0].delta.role).toBe("assistant");
    const last = events.filter((e) => e !== "[DONE]").at(-1);
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toMatchObject({
      prompt_tokens: 14, // 10 + 4 cached
      completion_tokens: 2,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 4 },
    });
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("streams thinking as reasoning_content", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(concatBytes(encodeStringField(9, "pondering"), encodeStringField(3, "done"))),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    const events = await sseEvents(response);
    expect(events[0].choices[0].delta.reasoning_content).toBe("pondering");
    expect(events.some((e) => e.choices?.[0]?.delta?.content === "done")).toBe(true);
  });

  it("streams tool calls with encoded ids and finishes tool_calls", async () => {
    const tc = concatBytes(
      encodeStringField(1, "call|n:1"),
      encodeStringField(2, "run_cmd"),
      encodeStringField(3, "{\"cmd\":"),
    );
    const tc2 = concatBytes(encodeStringField(1, "call|n:1"), encodeStringField(3, "\"ls\"}"));
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(concatBytes(encodeBytesField(6, tc))),
      wrapConnectEnvelope(concatBytes(encodeBytesField(6, tc2), encodeVarintField(5, 10))),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    const events = await sseEvents(response);
    const tcs = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);
    expect(tcs[0].index).toBe(0);
    expect(tcs[0].type).toBe("function");
    expect(tcs[0].id.startsWith(DEVIN_TOOL_ID_PREFIX)).toBe(true);
    expect(tcs[0].function.name).toBe("run_cmd");
    expect(tcs.map((t) => t.function?.arguments).filter(Boolean).join("")).toBe("{\"cmd\":\"ls\"}");
    const last = events.filter((e) => e !== "[DONE]").at(-1);
    expect(last.choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps stop reasons: 3→length, 11→content_filter", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(concatBytes(encodeStringField(3, "x"), encodeVarintField(5, 3))),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ]));
    let { response } = await new DevinExecutor().execute(baseArgs());
    let events = await sseEvents(response);
    expect(events.filter((e) => e !== "[DONE]").at(-1).choices[0].finish_reason).toBe("length");

    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(concatBytes(encodeVarintField(5, 11))),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ]));
    ({ response } = await new DevinExecutor().execute(baseArgs()));
    events = await sseEvents(response);
    expect(events.filter((e) => e !== "[DONE]").at(-1).choices[0].finish_reason).toBe("content_filter");
  });

  it("pre-output trailer error → HTTP error response with mapped status", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(enc.encode(JSON.stringify({ error: { code: "resource_exhausted", message: "quota gone" } })), 0x02),
    ]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.type).toBe("devin_error");
  });

  it("pre-output 401 trailer → HTTP 401 (auth failure path)", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(enc.encode(JSON.stringify({ error: { code: "unauthenticated", message: "bad token" } })), 0x02),
    ]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    expect(response.status).toBe(401);
  });

  it("inert usage frame before error trailer still yields HTTP 429, not SSE 200", async () => {
    // Chunk 1: data frame carrying only usage (field 7) — no content.
    // Chunk 2: end-stream trailer with resource_exhausted.
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(concatBytes(encodeBytesField(7, concatBytes(encodeVarintField(2, 10), encodeVarintField(3, 5))))),
      wrapConnectEnvelope(enc.encode(JSON.stringify({ error: { code: "resource_exhausted", message: "x" } })), 0x02),
    ]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    expect(response.status).toBe(429);
  });

  it("dimension groups fill only usage fields still at 0 (field 7 wins)", async () => {
    const f32 = (v) => { const b = new Uint8Array(5); b[0] = 0x15; new DataView(b.buffer).setFloat32(1, v, true); return b; };
    const dimMetric = (k, v) => encodeBytesField(2, concatBytes(encodeStringField(5, k), encodeBytesField(4, f32(v))));
    const dimGroup = (...ms) => encodeBytesField(28, concatBytes(encodeStringField(1, "Token Usage"), ...ms));
    // Field 7 carries prompt=10, completion=5, cached=2; dims claim 999/888/777.
    const frame = concatBytes(
      encodeStringField(3, "pong"),
      encodeBytesField(7, concatBytes(encodeVarintField(2, 10), encodeVarintField(3, 5), encodeVarintField(5, 2))),
      dimGroup(dimMetric("input_tokens", 999), dimMetric("output_tokens", 888), dimMetric("cached_input_tokens", 777)),
    );
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(frame),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    const events = await sseEvents(response);
    const usageEvent = events.find((e) => e.usage);
    expect(usageEvent.usage.prompt_tokens).toBe(12); // 10 + cached 2
    expect(usageEvent.usage.completion_tokens).toBe(5);
    expect(usageEvent.usage.prompt_tokens_details.cached_tokens).toBe(2);
  });

  it("dimension groups populate usage when field 7 is absent", async () => {
    const f32 = (v) => { const b = new Uint8Array(5); b[0] = 0x15; new DataView(b.buffer).setFloat32(1, v, true); return b; };
    const dimMetric = (k, v) => encodeBytesField(2, concatBytes(encodeStringField(5, k), encodeBytesField(4, f32(v))));
    const frame = concatBytes(
      encodeStringField(3, "pong"),
      encodeBytesField(28, concatBytes(encodeStringField(1, "Token Usage"),
        dimMetric("input_tokens", 999), dimMetric("output_tokens", 888), dimMetric("cached_input_tokens", 777))),
    );
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(frame),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    const events = await sseEvents(response);
    const usageEvent = events.find((e) => e.usage);
    expect(usageEvent.usage.prompt_tokens).toBe(1776); // 999 + cached 777
    expect(usageEvent.usage.completion_tokens).toBe(888);
  });

  it("mid-stream trailer error → error event then [DONE]", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(concatBytes(encodeStringField(3, "partial"))),
      wrapConnectEnvelope(enc.encode(JSON.stringify({ error: { code: "internal", message: "boom" } })), 0x02),
    ]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    const events = await sseEvents(response);
    expect(events.some((e) => e.choices?.[0]?.delta?.content === "partial")).toBe(true);
    const err = events.find((e) => e.error);
    expect(err.error.message).toContain("boom");
    expect(err.error.message).not.toContain("devin-session-token");
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("empty user turn → 400 without upstream call", async () => {
    const { response } = await new DevinExecutor().execute(baseArgs({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }],
    }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mid-history empty user turn is skipped; only the last user message must be non-empty", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]));
    const { response } = await new DevinExecutor().execute(baseArgs({
      messages: [
        { role: "user", content: "" },
        { role: "user", content: "go" },
      ],
    }));
    expect(response.status).toBe(200);
    const payload = fetchMock.mock.calls[0][1].body.subarray(5);
    const prompts = decodeProtoFields(payload).filter((f) => f.field === 3).map((f) => decodeProtoFields(f.value));
    expect(prompts).toHaveLength(1);
    expect(dec.decode(prompts[0].find((f) => f.field === 3).value)).toBe("go");
  });

  it("trailing empty user turn → 400", async () => {
    const { response } = await new DevinExecutor().execute(baseArgs({
      messages: [
        { role: "user", content: "go" },
        { role: "user", content: "" },
      ],
    }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("developer role folds into the system prompt like system", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]));
    await new DevinExecutor().execute(baseArgs({
      messages: [
        { role: "system", content: "sys" },
        { role: "developer", content: "dev note" },
        { role: "user", content: "hi" },
      ],
    }));
    const payload = fetchMock.mock.calls[0][1].body.subarray(5);
    const sysFields = decodeProtoFields(payload).filter((f) => f.field === 2 && f.wire === 2).map((f) => dec.decode(f.value));
    expect(sysFields).toEqual(["sys\n\ndev note"]);
  });

  it("builds the framed protobuf request: metadata, prompts, model uid, session", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]));
    await new DevinExecutor().execute(baseArgs({
      messages: [
        { role: "system", content: "be terse" },
        { role: "assistant", content: "ok", tool_calls: [{ id: "call:x", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call:x", content: "result" },
        { role: "tool", tool_call_id: "missing", content: "orphan result" },
        { role: "user", content: "go" },
      ],
      tools: [{ type: "function", function: { name: "f", description: "fn", parameters: { type: "object" } } }],
    }, { providerSessionId: "wire-sess" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CHAT_URL);
    const body = fetchMock.mock.calls[0][1].body;
    expect(body[0]).toBe(0); // data flag
    const payload = body.subarray(5);

    const top = decodeProtoFields(payload);
    const bytesF = (n) => top.filter((f) => f.field === n && f.wire === 2).map((f) => f.value);
    const varintF = (n) => top.filter((f) => f.field === n && f.wire === 0).map((f) => f.value);

    expect(bytesF(2).map((b) => dec.decode(b))).toEqual(["be terse"]);
    expect(bytesF(21).map((b) => dec.decode(b))).toEqual(["swe-2-high"]);
    expect(varintF(7)).toEqual([5n]);
    expect(varintF(20)).toEqual([1n]);

    const prompts = bytesF(3).map(decodeProtoFields);
    // assistant (source 2), matched tool result (source 4), orphan (source 1), user (source 1)
    const sources = prompts.map((p) => Number(p.find((f) => f.field === 2)?.value));
    expect(sources).toEqual([2, 4, 1, 1]);
    const orphan = prompts[2];
    expect(orphan.find((f) => f.field === 7)).toBeUndefined(); // no toolCallId on orphan
    const matched = prompts[1];
    expect(dec.decode(matched.find((f) => f.field === 7).value)).toBe("call:x");

    const f15 = decodeProtoFields(bytesF(15)[0]);
    expect(f15.find((f) => f.field === 3).value).toBe(4n);
    expect(f15.find((f) => f.field === 4).value).toBe(14n); // user-turn boundary
    const sessionId = dec.decode(f15.find((f) => f.field === 1).value);
    expect(dec.decode(bytesF(16)[0])).toBe(sessionId); // cascade = session
  });

  it("rejects invalid source-4 ordering: tool result before its call stays source 1", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]));
    await new DevinExecutor().execute(baseArgs({
      messages: [
        { role: "tool", tool_call_id: "call:y", content: "early result" },
        { role: "user", content: "go" },
      ],
    }));
    const payload = fetchMock.mock.calls[0][1].body.subarray(5);
    const prompts = decodeProtoFields(payload).filter((f) => f.field === 3).map((f) => decodeProtoFields(f.value));
    expect(Number(prompts[0].find((f) => f.field === 2).value)).toBe(1);
  });

  it("stable session ids + monotonic turn index per providerSessionId", async () => {
    const resp = () => upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]);
    fetchMock.mockResolvedValue(resp());
    const ex = new DevinExecutor();
    const sessOf = (call) => {
      const payload = call[1].body.subarray(5);
      const f15 = decodeProtoFields(decodeProtoFields(payload).find((f) => f.field === 15).value);
      return {
        session: dec.decode(f15.find((f) => f.field === 1).value),
        turn: Number(f15.find((f) => f.field === 2)?.value || 0n),
      };
    };
    await ex.execute(baseArgs({}, { providerSessionId: "sess-A" }));
    fetchMock.mockResolvedValue(resp());
    await ex.execute(baseArgs({}, { providerSessionId: "sess-A" }));
    const a = sessOf(fetchMock.mock.calls[0]);
    const b = sessOf(fetchMock.mock.calls[1]);
    expect(a.session).toBe(b.session);
    expect(a.turn).toBe(0);
    expect(b.turn).toBe(1);
  });

  it("empty completion → mid-stream error event", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]));
    const { response } = await new DevinExecutor().execute(baseArgs());
    const events = await sseEvents(response);
    expect(events.some((e) => e.error)).toBe(true);
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("reattaches stored thinking/signature when a tool call id round-trips", async () => {
    // First response: thinking + signature + a tool call → stored under the emitted id.
    const tc = concatBytes(encodeStringField(1, "sig|call"), encodeStringField(2, "fn"), encodeStringField(3, "{}"));
    fetchMock.mockResolvedValue(upstreamResponse([
      wrapConnectEnvelope(concatBytes(
        encodeStringField(9, "chain of thought"),
        encodeBytesField(10, Uint8Array.from([0xde, 0xad])),
        encodeStringField(21, "sig_type_x"),
        encodeBytesField(6, tc),
      )),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ]));
    const ex = new DevinExecutor();
    const { response } = await ex.execute(baseArgs({}, { providerSessionId: "sig-sess" }));
    const events = await sseEvents(response);
    const emittedId = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []).find((t) => t.id)?.id;
    expect(emittedId.startsWith(DEVIN_TOOL_ID_PREFIX)).toBe(true);

    // Second request echoes the encoded id back — executor must decode it and
    // reattach thinking (field 11), signature (12) and signatureType (18).
    fetchMock.mockResolvedValue(upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]));
    await ex.execute(baseArgs({
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: emittedId, function: { name: "fn", arguments: "{}" } }] },
        { role: "tool", tool_call_id: emittedId, content: "r" },
        { role: "user", content: "next" },
      ],
    }, { providerSessionId: "sig-sess" }));

    const payload = fetchMock.mock.calls[1][1].body.subarray(5);
    const prompts = decodeProtoFields(payload).filter((f) => f.field === 3).map((f) => decodeProtoFields(f.value));
    const assistant = prompts[0];
    expect(dec.decode(assistant.find((f) => f.field === 11).value)).toBe("chain of thought");
    expect([...assistant.find((f) => f.field === 12).value]).toEqual([0xde, 0xad]);
    expect(dec.decode(assistant.find((f) => f.field === 18).value)).toBe("sig_type_x");
    // tool call id decoded back to upstream form on the wire
    const tcSub = decodeProtoFields(assistant.find((f) => f.field === 6).value);
    expect(dec.decode(tcSub.find((f) => f.field === 1).value)).toBe("sig|call");
  });

  it("signature store is scoped per connectionId: A's sig never reattaches for B", async () => {
    const tc = concatBytes(encodeStringField(1, "sig|call"), encodeStringField(2, "fn"), encodeStringField(3, "{}"));
    const turn1 = () => upstreamResponse([
      wrapConnectEnvelope(concatBytes(
        encodeStringField(9, "chain of thought"),
        encodeBytesField(10, Uint8Array.from([0xde, 0xad])),
        encodeStringField(21, "sig_type_x"),
        encodeBytesField(6, tc),
      )),
      wrapConnectEnvelope(enc.encode("{}"), 0x02),
    ]);
    fetchMock.mockResolvedValue(turn1());
    const ex = new DevinExecutor();
    const credsA = { accessToken: "devin-session-token$a", connectionId: "conn-A" };
    const { response } = await ex.execute(baseArgs({}, { credentials: credsA, providerSessionId: "owner-sess" }));
    const events = await sseEvents(response);
    const emittedId = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []).find((t) => t.id)?.id;

    const history = (id) => ([
      { role: "assistant", content: "", tool_calls: [{ id, function: { name: "fn", arguments: "{}" } }] },
      { role: "tool", tool_call_id: id, content: "r" },
      { role: "user", content: "next" },
    ]);
    const okEnd = () => upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]);

    // Same connection → thinking/signature reattached.
    fetchMock.mockResolvedValue(okEnd());
    await ex.execute(baseArgs({ messages: history(emittedId) }, { credentials: credsA, providerSessionId: "owner-sess" }));
    const promptsA = decodeProtoFields(fetchMock.mock.calls[1][1].body.subarray(5))
      .filter((f) => f.field === 3).map((f) => decodeProtoFields(f.value));
    expect(dec.decode(promptsA[0].find((f) => f.field === 11).value)).toBe("chain of thought");
    expect([...promptsA[0].find((f) => f.field === 12).value]).toEqual([0xde, 0xad]);

    // Other connection, identical history → nothing reattached.
    fetchMock.mockResolvedValue(okEnd());
    const credsB = { accessToken: "devin-session-token$b", connectionId: "conn-B" };
    await ex.execute(baseArgs({ messages: history(emittedId) }, { credentials: credsB, providerSessionId: "owner-sess" }));
    const promptsB = decodeProtoFields(fetchMock.mock.calls[2][1].body.subarray(5))
      .filter((f) => f.field === 3).map((f) => decodeProtoFields(f.value));
    expect(promptsB[0].find((f) => f.field === 11)).toBeUndefined();
    expect(promptsB[0].find((f) => f.field === 12)).toBeUndefined();
  });

  it("execute without providerSessionId does not touch the turn counter map", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]));
    const before = __devinStateSizes().sessionTurnCounters;
    await new DevinExecutor().execute(baseArgs({}, { providerSessionId: null }));
    await new DevinExecutor().execute(baseArgs({}, { providerSessionId: undefined }));
    expect(__devinStateSizes().sessionTurnCounters).toBe(before);
  });

  it("turn counter is true LRU: a recently-used session survives eviction pressure", () => {
    for (let i = 0; i < 5000; i++) __devinSessionTurnIndex(`lru-fill-${i}`);
    __devinSessionTurnIndex("lru-active"); // insert at cap → evicts lru-fill-0
    for (let i = 5000; i < 5020; i++) __devinSessionTurnIndex(`lru-fill-${i}`);
    // "active" was touched last → still counted (1 = its second turn), not evicted.
    expect(__devinSessionTurnIndex("lru-active")).toBe(1);
    // Oldest entries were evicted and restart at 0.
    expect(__devinSessionTurnIndex("lru-fill-0")).toBe(0);
  });

  it("assistant tool_calls without a stored signature omit thinking", async () => {
    fetchMock.mockResolvedValue(upstreamResponse([wrapConnectEnvelope(enc.encode("{}"), 0x02)]));
    await new DevinExecutor().execute(baseArgs({
      messages: [
        { role: "assistant", content: "a", reasoning_content: "unsigned-think", tool_calls: [{ id: "nostore", function: { name: "f", arguments: "{}" } }] },
        { role: "user", content: "go" },
      ],
    }, { providerSessionId: "nosig-sess" }));
    const payload = fetchMock.mock.calls[0][1].body.subarray(5);
    const assistant = decodeProtoFields(decodeProtoFields(payload).filter((f) => f.field === 3)[0].value);
    expect(assistant.find((f) => f.field === 11)).toBeUndefined();
    expect(assistant.find((f) => f.field === 12)).toBeUndefined();
  });

  it("refreshCredentials is a no-op (permanent session token)", async () => {
    expect(await new DevinExecutor().refreshCredentials()).toBeNull();
  });
});
