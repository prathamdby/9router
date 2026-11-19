// Devin protobuf / Connect-RPC codec tests — vectors ported from
// CLIProxyAPI internal/runtime/executor/helps/devin_wire.go semantics.
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  encodeVarint,
  encodeTag,
  encodeBytesField,
  encodeStringField,
  encodeVarintField,
  encodeFixed64Field,
  concatBytes,
  decodeProtoFields,
  buildClientMetadataBytes,
  buildGetChatMessageRequest,
  buildGetUserStatusRequest,
  wrapConnectEnvelope,
  createConnectFrameReader,
  parseChatFrame,
  parseResponseDimensionGroups,
  parseTrailerError,
  parseGetUserStatusResponse,
  generateDevinFingerprint,
  encodeToolId,
  decodeToolId,
  isPortableToolCallId,
} from "open-sse/utils/devinProtobuf.js";
import {
  DEVIN_TOOL_ID_PREFIX,
  DEVIN_FINGERPRINT_HEX_LEN,
  DEVIN_CLIENT_NAME,
  DEVIN_CLIENT_VERSION,
} from "open-sse/config/devin.js";

const dec = new TextDecoder();
const enc = new TextEncoder();
const fields = (buf) => decodeProtoFields(buf);
const bytesField = (list, n) => list.filter((f) => f.field === n && f.wire === 2).map((f) => f.value);
const varintField = (list, n) => list.filter((f) => f.field === n && f.wire === 0).map((f) => f.value);

describe("varint encoding", () => {
  it("encodes small values", () => {
    expect([...encodeVarint(0)]).toEqual([0]);
    expect([...encodeVarint(127)]).toEqual([127]);
    expect([...encodeVarint(128)]).toEqual([128, 1]);
    expect([...encodeVarint(300)]).toEqual([172, 2]);
  });
  it("is BigInt-safe beyond 32 bits", () => {
    // 2^33 = 8589934592
    const bytes = encodeVarint(8589934592n);
    expect([...bytes]).toEqual([128, 128, 128, 128, 32]);
    // max uint64
    const max = encodeVarint(0xffffffffffffffffn);
    expect(max.length).toBe(10);
    expect(max[9]).toBe(1);
  });
});

describe("client metadata", () => {
  it("encodes the documented field set", () => {
    const meta = fields(buildClientMetadataBytes("tok$abc"));
    const get = (n) => bytesField(meta, n).map((b) => dec.decode(b))[0];
    expect(get(1)).toBe(DEVIN_CLIENT_NAME);
    expect(get(2)).toBe(DEVIN_CLIENT_VERSION);
    expect(get(3)).toBe("tok$abc");
    expect(get(4)).toBe("en");
    expect(get(5)).toBeTruthy();
    expect(get(7)).toBe(DEVIN_CLIENT_VERSION);
    expect(get(12)).toBe(DEVIN_CLIENT_NAME);
    expect(get(31)).toHaveLength(DEVIN_FINGERPRINT_HEX_LEN);
    expect(get(31)).toMatch(/^[0-9a-f]+$/);
  });
});

describe("buildGetChatMessageRequest", () => {
  const build = (over = {}) => buildGetChatMessageRequest({
    sessionToken: "tok",
    modelUid: "swe-2-high",
    systemPrompt: "sys",
    prompts: [
      { source: 1, content: "hello" },
      { source: 2, content: "hi", toolCalls: [{ id: "call:1", name: "fn", arguments: "{}" }] },
      { source: 4, content: "res", toolCallId: "call:1" },
      { source: 1, content: "again" },
    ],
    tools: [{ name: "fn", description: "does fn", parameters: "{\"type\":\"object\"}" }],
    temperature: 0.5,
    maxTokens: 4096,
    sessionId: "sess-1",
    cascadeId: "casc-1",
    turnIndex: 2,
    ...over,
  });

  it("encodes all top-level fields", () => {
    const top = fields(build());
    expect(bytesField(top, 1).length).toBe(1); // metadata
    expect(bytesField(top, 2).map((b) => dec.decode(b))).toEqual(["sys"]);
    expect(bytesField(top, 3).length).toBe(4); // prompts
    expect(varintField(top, 7)).toEqual([5n]);
    expect(bytesField(top, 8).length).toBe(1); // config
    expect(bytesField(top, 10).length).toBe(1); // tools
    expect(bytesField(top, 15).length).toBe(1);
    expect(bytesField(top, 16).map((b) => dec.decode(b))).toEqual(["casc-1"]);
    expect(varintField(top, 20)).toEqual([1n]);
    expect(bytesField(top, 21).map((b) => dec.decode(b))).toEqual(["swe-2-high"]);
  });

  it("encodes prompt subfields: source, content, toolCalls, toolCallId", () => {
    const prompts = bytesField(fields(build()), 3).map(fields);
    expect(varintField(prompts[0], 2)).toEqual([1n]);
    expect(bytesField(prompts[0], 3).map((b) => dec.decode(b))).toEqual(["hello"]);

    const tcSub = fields(bytesField(prompts[1], 6)[0]);
    expect(bytesField(tcSub, 1).map((b) => dec.decode(b))).toEqual(["call:1"]);
    expect(bytesField(tcSub, 2).map((b) => dec.decode(b))).toEqual(["fn"]);
    expect(varintField(prompts[1], 2)).toEqual([2n]);

    expect(varintField(prompts[2], 2)).toEqual([4n]);
    expect(bytesField(prompts[2], 7).map((b) => dec.decode(b))).toEqual(["call:1"]);
  });

  it("encodes images with default mime", () => {
    const req = build({
      prompts: [{ source: 1, content: "", images: [{ base64Data: "QUJD", mimeType: "" }] }],
    });
    const img = fields(bytesField(fields(bytesField(fields(req), 3)[0]), 10)[0]);
    expect(bytesField(img, 1).map((b) => dec.decode(b))).toEqual(["QUJD"]);
    expect(bytesField(img, 2).map((b) => dec.decode(b))).toEqual(["image/png"]);
  });

  it("field 15: turnIndex omitted at 0, present otherwise; 15.4=14 on user-turn boundary", () => {
    const f15 = (turnIndex, prompts) =>
      fields(bytesField(fields(build({ turnIndex, prompts })), 15)[0]);

    let m = f15(0, [{ source: 1, content: "x" }]);
    expect(varintField(m, 2)).toEqual([]);
    expect(varintField(m, 3)).toEqual([4n]);
    expect(varintField(m, 4)).toEqual([14n]);

    m = f15(3, [{ source: 1, content: "x" }]);
    expect(varintField(m, 2)).toEqual([3n]);
    expect(varintField(m, 4)).toEqual([14n]);

    // last prompt not user → no 15.4
    m = f15(1, [{ source: 1, content: "x" }, { source: 2, content: "y" }]);
    expect(varintField(m, 4)).toEqual([]);

    // consecutive user turns → not a boundary
    m = f15(1, [{ source: 1, content: "a" }, { source: 1, content: "b" }]);
    expect(varintField(m, 4)).toEqual([]);
  });

  it("field 8 config: maxTokens, temperature fixed64, fixed constants", () => {
    const cfg = fields(bytesField(fields(build()), 8)[0]);
    expect(varintField(cfg, 1)).toEqual([1n]);
    expect(varintField(cfg, 2)).toEqual([4096n]);
    expect(varintField(cfg, 3)).toEqual([400n]);
    expect(varintField(cfg, 7)).toEqual([40n]);
    const f64 = (n) => cfg.filter((f) => f.field === n && f.wire === 1)
      .map((f) => new DataView(f.value.buffer, f.value.byteOffset, 8).getFloat64(0, true))[0];
    expect(f64(5)).toBeCloseTo(0.5);
    expect(f64(8)).toBeCloseTo(Math.fround(0.95));
  });
});

describe("Connect framing", () => {
  it("wraps payload with flag + big-endian length", () => {
    const env = wrapConnectEnvelope(Uint8Array.from([9, 9, 9]));
    expect(env[0]).toBe(0);
    expect(new DataView(env.buffer).getUint32(1, false)).toBe(3);
    expect([...env.subarray(5)]).toEqual([9, 9, 9]);
  });

  it("reader reassembles frames split across chunks", () => {
    const reader = createConnectFrameReader();
    const frame = wrapConnectEnvelope(enc.encode("hello"));
    const out = [];
    for (let i = 0; i < frame.length; i += 2) {
      out.push(...reader.push(frame.subarray(i, i + 2)));
    }
    expect(out).toHaveLength(1);
    expect(dec.decode(out[0].payload)).toBe("hello");
  });

  it("decompresses gzip frames", () => {
    const reader = createConnectFrameReader();
    const zipped = gzipSync(enc.encode("inflated"));
    const frame = wrapConnectEnvelope(zipped, 0x01);
    const out = reader.push(frame);
    expect(out[0].flag).toBe(1);
    expect(dec.decode(out[0].payload)).toBe("inflated");
  });

  it("accepts end-stream flag 0x02 and 0x03 (compressed+eos)", () => {
    const reader = createConnectFrameReader();
    const a = wrapConnectEnvelope(enc.encode("{}"), 0x02);
    const b = wrapConnectEnvelope(gzipSync(enc.encode("{}")), 0x03);
    const out = [...reader.push(a), ...reader.push(b)];
    expect(out.map((f) => f.flag)).toEqual([2, 3]);
  });

  it("rejects invalid flags and oversized frames", () => {
    const bad = createConnectFrameReader();
    expect(() => bad.push(wrapConnectEnvelope(enc.encode("x"), 0x7f))).toThrow(/invalid connect frame flag/);
    const big = createConnectFrameReader();
    const header = new Uint8Array(5);
    header[0] = 0;
    new DataView(header.buffer).setUint32(1, 17 * 1024 * 1024, false);
    expect(() => big.push(header)).toThrow(/exceeds maximum/);
  });
});

// Build a response frame payload using the encoder helpers.
function chatFrame(parts) {
  return concatBytes(...parts);
}

describe("parseChatFrame", () => {
  it("parses text, thinking, tool delta, usage, signature, ids", () => {
    const tc = concatBytes(
      encodeStringField(1, "call|9"),
      encodeStringField(2, "run"),
      encodeStringField(3, "{\"a\":"),
    );
    const usage = concatBytes(
      encodeVarintField(2, 100),
      encodeVarintField(3, 42),
      encodeVarintField(5, 60),
      encodeStringField(9, "swe-2"),
    );
    const frame = chatFrame([
      encodeStringField(1, "out-1"),
      encodeStringField(3, "Hello"),
      encodeStringField(3, " world"),
      encodeBytesField(6, tc),
      encodeBytesField(7, usage),
      encodeStringField(9, "think-"),
      encodeStringField(9, "ing"),
      encodeBytesField(10, Uint8Array.from([1, 2, 3])),
      encodeStringField(17, "msg-7"),
      encodeStringField(21, "claude_sig"),
      encodeVarintField(5, 10),
      encodeStringField(99, "unknown"),
    ]);
    const r = parseChatFrame(frame);
    expect(r.outputId).toBe("out-1");
    expect(r.contentText).toBe("Hello world");
    expect(r.thinkingText).toBe("think-ing");
    expect(r.toolCallDeltas).toHaveLength(1);
    expect(r.toolCallDeltas[0]).toMatchObject({ id: "call|9", name: "run", arguments: "{\"a\":" });
    expect(r.usage.promptTokens).toBe(100);
    expect(r.usage.completionTokens).toBe(42);
    expect(r.usage.cachedTokens).toBe(60);
    expect(r.usage.modelName).toBe("swe-2");
    expect([...r.deltaSignature]).toEqual([1, 2, 3]);
    expect(r.deltaSignatureType).toBe("claude_sig");
    expect(r.messageId).toBe("msg-7");
    expect(r.stopReason).toBe(10);
    expect(r.unknownFieldNumbers).toContain(99);
  });
});

describe("parseResponseDimensionGroups", () => {
  const metric = (key, val) => {
    const f32 = new Uint8Array(4);
    new DataView(f32.buffer).setFloat32(0, val, true);
    return encodeBytesField(2, concatBytes(
      encodeBytesField(4, concatBytes(encodeTag(2, 5), f32)),
      encodeBytesField(5, enc.encode(key)),
    ));
  };
  it("extracts token usage metrics", () => {
    const group = concatBytes(
      encodeStringField(1, "Token Usage"),
      metric("input_tokens", 1234),
      metric("output_tokens", 55),
      metric("cached_input_tokens", 900),
    );
    const r = parseResponseDimensionGroups(group);
    expect(r).toEqual({ promptTokens: 1234, completionTokens: 55, cachedTokens: 900, found: true });
  });
  it("ignores non-usage groups", () => {
    const group = concatBytes(encodeStringField(1, "Other"), metric("input_tokens", 1));
    expect(parseResponseDimensionGroups(group).found).toBe(false);
  });
});

describe("parseTrailerError", () => {
  const trailer = (code, message) => enc.encode(JSON.stringify({ error: { code, message } }));
  it("returns null for empty/blank/no-error payloads", () => {
    expect(parseTrailerError(enc.encode(""))).toBeNull();
    expect(parseTrailerError(enc.encode("{}"))).toBeNull();
    expect(parseTrailerError(enc.encode("not json"))).toBeNull();
    expect(parseTrailerError(enc.encode('{"x":1}'))).toBeNull();
  });
  it("maps connect codes to HTTP statuses", () => {
    expect(parseTrailerError(trailer("resource_exhausted", "quota")).status).toBe(429);
    expect(parseTrailerError(trailer("unauthenticated", "bad")).status).toBe(401);
    expect(parseTrailerError(trailer("permission_denied", "high demand")).status).toBe(429);
    expect(parseTrailerError(trailer("permission_denied", "nope")).status).toBe(403);
    expect(parseTrailerError(trailer("invalid_argument", "internal error")).status).toBe(502);
    expect(parseTrailerError(trailer("invalid_argument", "bad input")).status).toBe(400);
    expect(parseTrailerError(trailer("unavailable", "down")).status).toBe(503);
    expect(parseTrailerError(trailer("deadline_exceeded", "slow")).status).toBe(504);
    expect(parseTrailerError(trailer("canceled", "abort")).status).toBe(499);
    expect(parseTrailerError(trailer("failed_precondition", "acu exhausted")).status).toBe(429);
    expect(parseTrailerError(trailer("failed_precondition", "other")).status).toBe(400);
    expect(parseTrailerError(trailer("data_loss", "oops")).status).toBe(502);
  });
});

describe("user status", () => {
  it("request carries metadata in field 1", () => {
    const req = fields(buildGetUserStatusRequest("tok$1"));
    const meta = fields(bytesField(req, 1)[0]);
    expect(bytesField(meta, 3).map((b) => dec.decode(b))).toEqual(["tok$1"]);
  });

  it("parses a hand-built response", () => {
    const org = concatBytes(encodeStringField(4, "org-1"), encodeStringField(8, "Acme"));
    const planInfo = concatBytes(encodeStringField(2, "core"), encodeBytesField(33, org));
    const ts = (sec) => encodeVarintField(1, sec);
    const planStatus = concatBytes(
      encodeBytesField(1, planInfo),
      encodeBytesField(2, ts(1700000000)),
      encodeBytesField(3, ts(1800000000)),
      encodeVarintField(14, 80),
      encodeVarintField(15, 55),
      encodeVarintField(17, 1700001000),
      encodeVarintField(18, 1700002000),
    );
    const userStatus = concatBytes(
      encodeStringField(3, "devuser"),
      encodeStringField(5, "team-9"),
      encodeStringField(7, "u@x.io"),
      encodeBytesField(13, planStatus),
      encodeStringField(36, "uid-1"),
    );
    const resp = encodeBytesField(1, userStatus);
    const s = parseGetUserStatusResponse(resp);
    expect(s.userName).toBe("devuser");
    expect(s.teamId).toBe("team-9");
    expect(s.email).toBe("u@x.io");
    expect(s.userId).toBe("uid-1");
    expect(s.plan).toBe("core");
    expect(s.orgId).toBe("org-1");
    expect(s.orgName).toBe("Acme");
    expect(s.dailyQuotaRemainingPercent).toBe(80);
    expect(s.weeklyQuotaRemainingPercent).toBe(55);
    expect(new Date(s.dailyQuotaResetAt).getTime()).toBe(1700001000 * 1000);
    expect(new Date(s.weeklyQuotaResetAt).getTime()).toBe(1700002000 * 1000);
    expect(new Date(s.planStart).getTime()).toBe(1700000000 * 1000);
    expect(new Date(s.planEnd).getTime()).toBe(1800000000 * 1000);
  });
});

describe("tool call id codec", () => {
  it("preserves portable ids", () => {
    expect(encodeToolId("call_abc-123")).toBe("call_abc-123");
    expect(encodeToolId("")).toBe("");
    expect(isPortableToolCallId("aZ9_-")).toBe(true);
    expect(isPortableToolCallId("a|b")).toBe(false);
  });
  it("encodes non-portable ids once with the dv_tid_v1_ prefix", () => {
    const encoded = encodeToolId("call|x:y");
    expect(encoded.startsWith(DEVIN_TOOL_ID_PREFIX)).toBe(true);
    // not double-encoded
    expect(encodeToolId(encoded)).not.toBe(encoded);
    expect(decodeToolId(encoded)).toBe("call|x:y");
  });
  it("decodes exactly one canonical layer", () => {
    const inner = encodeToolId("x|y");
    const outer = encodeToolId(inner);
    expect(decodeToolId(outer)).toBe(inner);
  });
  it("leaves malformed/prefixed-but-invalid ids unchanged", () => {
    expect(decodeToolId("plain")).toBe("plain");
    expect(decodeToolId(`${DEVIN_TOOL_ID_PREFIX}!!`)).toBe(`${DEVIN_TOOL_ID_PREFIX}!!`);
    expect(decodeToolId(DEVIN_TOOL_ID_PREFIX)).toBe(DEVIN_TOOL_ID_PREFIX);
    // valid b64 of a non-utf8 blob fails the round-trip check → unchanged
    const junk = DEVIN_TOOL_ID_PREFIX + Buffer.from([0xff, 0xfe]).toString("base64url");
    expect(decodeToolId(junk)).toBe(junk);
  });
  it("encodes ids that already carry the prefix (collision namespace)", () => {
    const native = `${DEVIN_TOOL_ID_PREFIX}native`;
    const encoded = encodeToolId(native);
    expect(encoded).not.toBe(native);
    expect(decodeToolId(encoded)).toBe(native);
  });
});

describe("fingerprint", () => {
  it("random fingerprints are 732 hex chars", () => {
    expect(generateDevinFingerprint()).toMatch(/^[0-9a-f]{732}$/);
  });
  it("seeded fingerprints are deterministic", () => {
    expect(generateDevinFingerprint("seed")).toBe(generateDevinFingerprint("seed"));
    expect(generateDevinFingerprint("a")).not.toBe(generateDevinFingerprint("b"));
  });
});
