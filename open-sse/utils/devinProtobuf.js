// Devin Connect-RPC wire codec. Pure protobuf/framing helpers ported from
// CLIProxyAPI internal/runtime/executor/helps/devin_wire.go,
// internal/auth/devin/user_status.go and tool_call_ids.go.
// No network, no logging — binary payloads never leave this module.

import { gunzipSync } from "node:zlib";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  DEVIN_CLIENT_NAME,
  DEVIN_CLIENT_VERSION,
  DEVIN_FINGERPRINT_HEX_LEN,
  DEVIN_DEFAULT_MAX_TOKENS,
  DEVIN_TOOL_ID_PREFIX,
  CONNECT_FLAG_DATA,
  CONNECT_FLAG_COMPRESSED,
  CONNECT_FLAG_END_STREAM,
  CONNECT_MAX_FRAME_SIZE,
  CONNECT_MAX_DECOMPRESSED_SIZE,
} from "../config/devin.js";

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------- protobuf encoding ----------

export function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Uint8Array.from(out);
}

export function encodeTag(fieldNumber, wireType) {
  return encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

export function encodeBytesField(fieldNumber, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  return concatBytes(encodeTag(fieldNumber, WIRE_BYTES), encodeVarint(b.length), b);
}

export function encodeStringField(fieldNumber, str) {
  return encodeBytesField(fieldNumber, textEncoder.encode(String(str ?? "")));
}

export function encodeVarintField(fieldNumber, value) {
  return concatBytes(encodeTag(fieldNumber, WIRE_VARINT), encodeVarint(value));
}

export function encodeFixed64Field(fieldNumber, doubleValue) {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, doubleValue, true);
  return concatBytes(encodeTag(fieldNumber, WIRE_FIXED64), buf);
}

export function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------- protobuf decoding ----------

function consumeVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: result, size: i + 1 };
    shift += 7n;
  }
  return null;
}

function consumeTag(buf, pos) {
  const v = consumeVarint(buf, pos);
  if (!v) return null;
  return { field: Number(v.value >> 3n), wire: Number(v.value & 7n), size: v.size };
}

function fieldValueSize(buf, pos, wire) {
  switch (wire) {
    case WIRE_VARINT: {
      const v = consumeVarint(buf, pos);
      return v ? v.size : -1;
    }
    case WIRE_FIXED64:
      return pos + 8 <= buf.length ? 8 : -1;
    case WIRE_BYTES: {
      const len = consumeVarint(buf, pos);
      if (!len) return -1;
      const size = len.size + Number(len.value);
      return pos + size <= buf.length ? size : -1;
    }
    case WIRE_FIXED32:
      return pos + 4 <= buf.length ? 4 : -1;
    default:
      return -1;
  }
}

function* iterFields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const tag = consumeTag(buf, pos);
    if (!tag) return;
    pos += tag.size;
    const valueSize = fieldValueSize(buf, pos, tag.wire);
    if (valueSize < 0) return;
    let value;
    if (tag.wire === WIRE_VARINT) {
      value = consumeVarint(buf, pos).value;
    } else if (tag.wire === WIRE_BYTES) {
      const len = consumeVarint(buf, pos);
      value = buf.subarray(pos + len.size, pos + len.size + Number(len.value));
    } else if (tag.wire === WIRE_FIXED64 || tag.wire === WIRE_FIXED32) {
      value = buf.subarray(pos, pos + valueSize);
    }
    yield { field: tag.field, wire: tag.wire, value };
    pos += valueSize;
  }
}

// Decode a buffer into [{field, wire, value}] — varint values are BigInt,
// bytes/fixed values are Uint8Array. Mirrors iterFields; exported for tests
// and debugging round trips.
export function decodeProtoFields(buf) {
  return [...iterFields(buf instanceof Uint8Array ? buf : Uint8Array.from(buf || []))];
}

// ---------- fingerprints / traces ----------

export function generateDevinFingerprint(seed = "") {
  if (!seed) return randomBytes(DEVIN_FINGERPRINT_HEX_LEN / 2).toString("hex");
  let out = "";
  let counter = 0;
  while (out.length < DEVIN_FINGERPRINT_HEX_LEN) {
    out += createHash("sha256").update(`${seed}-${counter}`).digest("hex");
    counter++;
  }
  return out.slice(0, DEVIN_FINGERPRINT_HEX_LEN);
}

export function generateDevinSentryTrace() {
  const b = randomBytes(24);
  return `${b.subarray(0, 16).toString("hex")}-${b.subarray(16, 24).toString("hex")}-1`;
}

// ---------- request encoders ----------

export function buildClientMetadataBytes(sessionToken, osName = "") {
  const os = osName || (process.platform === "win32" ? "windows" : process.platform);
  return concatBytes(
    encodeStringField(1, DEVIN_CLIENT_NAME),
    encodeStringField(2, DEVIN_CLIENT_VERSION),
    encodeStringField(3, sessionToken),
    encodeStringField(4, "en"),
    encodeStringField(5, os),
    encodeStringField(7, DEVIN_CLIENT_VERSION),
    encodeStringField(12, DEVIN_CLIENT_NAME),
    encodeStringField(31, generateDevinFingerprint()),
  );
}

// prompts: [{messageId, source, content, images:[{base64Data, mimeType}],
//            toolCalls:[{id, name, arguments}], toolCallId, thinking,
//            signature(Uint8Array), signatureType}]
// tools:   [{name, description, parameters(string|Uint8Array)}]
export function buildGetChatMessageRequest({
  sessionToken,
  modelUid,
  systemPrompt = "",
  prompts = [],
  tools = [],
  temperature = null,
  maxTokens = 0,
  sessionId = "",
  cascadeId = "",
  turnIndex = 0,
}) {
  if (!maxTokens || maxTokens <= 0) maxTokens = DEVIN_DEFAULT_MAX_TOKENS;
  if (!sessionId) sessionId = randomUUID();
  if (!cascadeId) cascadeId = sessionId;

  const parts = [encodeBytesField(1, buildClientMetadataBytes(sessionToken))];

  if (systemPrompt) parts.push(encodeStringField(2, systemPrompt));

  for (const p of prompts) {
    const pParts = [
      encodeStringField(1, p.messageId || randomUUID()),
      encodeVarintField(2, p.source > 0 ? p.source : 1),
      encodeStringField(3, p.content ?? ""),
    ];
    for (const tc of p.toolCalls || []) {
      const tcParts = [];
      if (tc.id) tcParts.push(encodeStringField(1, tc.id));
      if (tc.name) tcParts.push(encodeStringField(2, tc.name));
      if (tc.arguments) tcParts.push(encodeStringField(3, tc.arguments));
      pParts.push(encodeBytesField(6, concatBytes(...tcParts)));
    }
    if (p.toolCallId) pParts.push(encodeStringField(7, p.toolCallId));
    for (const img of p.images || []) {
      const data = String(img.base64Data || "").trim();
      if (!data) continue;
      const mime = String(img.mimeType || "").trim() || "image/png";
      pParts.push(encodeBytesField(10, concatBytes(encodeStringField(1, data), encodeStringField(2, mime))));
    }
    if (p.thinking) pParts.push(encodeStringField(11, p.thinking));
    if (p.signature && p.signature.length > 0) pParts.push(encodeBytesField(12, p.signature));
    if (p.signatureType) pParts.push(encodeStringField(18, p.signatureType));
    parts.push(encodeBytesField(3, concatBytes(...pParts)));
  }

  parts.push(encodeVarintField(7, 5));

  const tempVal = temperature == null ? 1.0 : temperature;
  const f8 = concatBytes(
    encodeVarintField(1, 1),
    encodeVarintField(2, maxTokens),
    encodeVarintField(3, 400),
    encodeFixed64Field(5, tempVal),
    encodeVarintField(7, 40),
    encodeFixed64Field(8, Math.fround(0.95)),
  );
  parts.push(encodeBytesField(8, f8));

  for (const tool of tools) {
    if (!tool || !tool.name) continue;
    const tParts = [encodeStringField(1, tool.name)];
    let desc = String(tool.description || "");
    // Upstream tool environment expects camelCase "taskId" (see Go reference).
    desc = desc.replaceAll("Takes a task_id parameter identifying the task", "Takes a taskId parameter identifying the task");
    if (desc) tParts.push(encodeStringField(2, desc));
    if (tool.parameters && tool.parameters.length > 0) {
      const params = typeof tool.parameters === "string" ? textEncoder.encode(tool.parameters) : tool.parameters;
      tParts.push(encodeBytesField(3, params));
    }
    parts.push(encodeBytesField(10, concatBytes(...tParts)));
  }

  const f15Parts = [encodeStringField(1, sessionId)];
  if (turnIndex > 0) f15Parts.push(encodeVarintField(2, turnIndex));
  f15Parts.push(encodeVarintField(3, 4));
  // Field 15.4=14 is emitted on user-turn boundaries.
  if (prompts.length > 0 && prompts[prompts.length - 1].source === 1) {
    if (turnIndex === 0 || prompts.length < 2 || prompts[prompts.length - 2].source !== 1) {
      f15Parts.push(encodeVarintField(4, 14));
    }
  }
  parts.push(encodeBytesField(15, concatBytes(...f15Parts)));

  parts.push(encodeStringField(16, cascadeId));
  parts.push(encodeVarintField(20, 1));
  parts.push(encodeStringField(21, modelUid));

  return concatBytes(...parts);
}

export function buildGetUserStatusRequest(sessionToken) {
  return encodeBytesField(1, buildClientMetadataBytes(sessionToken));
}

// ---------- Connect framing ----------

export function wrapConnectEnvelope(payload, flag = CONNECT_FLAG_DATA) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

// Incremental reader over arbitrary transport chunks. push(chunk) returns
// [{flag, payload}] — payload already gunzipped for compressed frames.
export function createConnectFrameReader() {
  let buffer = new Uint8Array(0);
  return {
    push(chunk) {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
      const frames = [];
      for (;;) {
        if (buffer.length < 5) break;
        const flag = buffer[0];
        const valid = flag === CONNECT_FLAG_DATA || flag === CONNECT_FLAG_COMPRESSED
          || flag === CONNECT_FLAG_END_STREAM || flag === (CONNECT_FLAG_COMPRESSED | CONNECT_FLAG_END_STREAM);
        if (!valid) throw new Error(`invalid connect frame flag: 0x${flag.toString(16).padStart(2, "0")}`);
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1, false);
        if (length > CONNECT_MAX_FRAME_SIZE) {
          throw new Error(`connect frame length ${length} exceeds maximum limit (${CONNECT_MAX_FRAME_SIZE})`);
        }
        if (buffer.length < 5 + length) break;
        let payload = buffer.subarray(5, 5 + length);
        buffer = buffer.subarray(5 + length);
        if (flag & CONNECT_FLAG_COMPRESSED) {
          let decompressed;
          try {
            decompressed = gunzipSync(payload, { maxOutputLength: CONNECT_MAX_DECOMPRESSED_SIZE });
          } catch (e) {
            throw new Error(`decompress gzip connect frame: ${e.message}`);
          }
          payload = new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.length);
        } else {
          payload = payload.slice();
        }
        frames.push({ flag, payload });
      }
      return frames;
    },
    get pending() {
      return buffer.length;
    },
  };
}

// ---------- response parsers ----------

function parseToolCallDelta(data) {
  const tc = { id: "", name: "", arguments: "", invalidJsonStr: "", invalidJsonErr: "", isCustomToolCall: false };
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_VARINT && f.field === 6) {
      tc.isCustomToolCall = f.value !== 0n;
    } else if (f.wire === WIRE_BYTES) {
      const s = textDecoder.decode(f.value);
      if (f.field === 1) tc.id = s;
      else if (f.field === 2) tc.name = s;
      else if (f.field === 3) tc.arguments = s;
      else if (f.field === 4) tc.invalidJsonStr = s;
      else if (f.field === 5) tc.invalidJsonErr = s;
    }
  }
  return tc;
}

function parseTimestampField(data) {
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_VARINT && f.field === 1) return Number(f.value);
  }
  return 0;
}

function parseHeaderField(data) {
  let key = "";
  let val = "";
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_BYTES && f.field === 1) key = textDecoder.decode(f.value);
    else if (f.wire === WIRE_BYTES && f.field === 2) val = textDecoder.decode(f.value);
  }
  return { key, val };
}

function isPrintableASCII(bytes) {
  for (const b of bytes) if (b < 0x20 || b > 0x7e) return false;
  return bytes.length > 0;
}

function parseUsageField(data) {
  const u = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, statusCode: 0, requestId: "", modelName: "", headers: null };
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_VARINT) {
      if (f.field === 2) u.promptTokens += Number(f.value);
      else if (f.field === 3) u.completionTokens = Number(f.value);
      else if (f.field === 4) u.cacheWriteTokens += Number(f.value);
      else if (f.field === 5) u.cachedTokens = Number(f.value);
      else if (f.field === 6) u.statusCode = Number(f.value);
    } else if (f.wire === WIRE_BYTES) {
      if (f.field === 8) {
        const { key, val } = parseHeaderField(f.value);
        if (key) {
          if (!u.headers) u.headers = {};
          u.headers[key] = val;
          const k = key.toLowerCase();
          if ((k === "x-request-id" || k === "request-id") && val) u.requestId = val;
        } else if (f.value.length > 0 && isPrintableASCII(f.value) && !u.requestId) {
          u.requestId = textDecoder.decode(f.value);
        }
      } else if (f.field === 9) {
        u.modelName = textDecoder.decode(f.value);
      }
    }
  }
  return u;
}

export function parseChatFrame(payload) {
  const res = {
    outputId: "",
    timestamp: 0,
    deltaTokens: 0,
    stopReason: 0,
    latency: 0,
    messageId: "",
    contentText: "",
    thinkingText: "",
    toolCallDeltas: [],
    deltaSignature: null,
    deltaSignatureType: "",
    usage: null,
    responseDimensionGroups: [],
    unknownFieldNumbers: [],
  };
  const textParts = [];
  const thinkingParts = [];
  const signatureParts = [];
  for (const f of iterFields(payload)) {
    if (f.wire === WIRE_VARINT) {
      if (f.field === 2) res.timestamp = Number(f.value);
      else if (f.field === 4) res.deltaTokens = Number(f.value);
      else if (f.field === 5) res.stopReason = Number(f.value);
    } else if (f.wire === WIRE_FIXED64 && f.field === 12) {
      res.latency = new DataView(f.value.buffer, f.value.byteOffset, f.value.length).getFloat64(0, true);
    } else if (f.wire === WIRE_BYTES) {
      switch (f.field) {
        case 1: res.outputId = textDecoder.decode(f.value); break;
        case 2: res.timestamp = parseTimestampField(f.value); break;
        case 3: textParts.push(textDecoder.decode(f.value)); break;
        case 6: res.toolCallDeltas.push(parseToolCallDelta(f.value)); break;
        case 7: res.usage = parseUsageField(f.value); break;
        case 9: thinkingParts.push(textDecoder.decode(f.value)); break;
        case 10: signatureParts.push(f.value); break;
        case 17: res.messageId = textDecoder.decode(f.value); break;
        case 21: res.deltaSignatureType = textDecoder.decode(f.value); break;
        case 28: res.responseDimensionGroups.push(f.value.slice()); break;
        default: res.unknownFieldNumbers.push(f.field);
      }
    }
  }
  res.contentText = textParts.join("");
  res.thinkingText = thinkingParts.join("");
  res.deltaSignature = signatureParts.length ? concatBytes(...signatureParts) : null;
  return res;
}

// Field 28 groups → {promptTokens, completionTokens, cachedTokens, found}.
export function parseResponseDimensionGroups(...groups) {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let found = false;
  for (let gBytes of groups) {
    if (!gBytes || gBytes.length === 0) continue;
    // Outer envelope may carry tag 28 — unwrap to inner group bytes.
    const first = consumeTag(gBytes, 0);
    if (first && first.field === 28 && first.wire === WIRE_BYTES) {
      const len = consumeVarint(gBytes, first.size);
      if (len) gBytes = gBytes.subarray(first.size + len.size, first.size + len.size + Number(len.value));
    }
    let title = "";
    const metrics = [];
    for (const f of iterFields(gBytes)) {
      if (f.wire !== WIRE_BYTES) continue;
      if (f.field === 1) {
        title = textDecoder.decode(f.value);
      } else if (f.field === 2) {
        let mKey = "";
        let mVal = 0;
        for (const mf of iterFields(f.value)) {
          if (mf.wire !== WIRE_BYTES) continue;
          if (mf.field === 5) {
            mKey = textDecoder.decode(mf.value);
          } else if (mf.field === 4) {
            for (const df of iterFields(mf.value)) {
              if (df.wire === WIRE_FIXED32 && df.field === 2) {
                mVal = new DataView(df.value.buffer, df.value.byteOffset, df.value.length).getFloat32(0, true);
              }
            }
          }
        }
        if (mKey) metrics.push({ key: mKey, val: mVal });
      }
    }
    if (title.toLowerCase() === "token usage") {
      for (const m of metrics) {
        if (m.key === "input_tokens") { promptTokens = Math.trunc(m.val); found = true; }
        else if (m.key === "output_tokens") { completionTokens = Math.trunc(m.val); found = true; }
        else if (m.key === "cached_input_tokens") { cachedTokens = Math.trunc(m.val); found = true; }
      }
      if (found) return { promptTokens, completionTokens, cachedTokens, found: true };
    }
  }
  return { promptTokens, completionTokens, cachedTokens, found };
}

// Connect EOS trailer JSON → {status, code, message} or null.
export function parseTrailerError(payload) {
  const trimmed = textDecoder.decode(payload).trim();
  if (!trimmed || trimmed === "{}") return null;
  let trailer;
  try {
    trailer = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const err = trailer && trailer.error;
  if (!err || typeof err !== "object") return null;

  const code = String(err.code || "");
  const message = String(err.message || "");
  const codeLower = code.toLowerCase();
  const msgLower = message.toLowerCase();

  let status = 502;
  switch (codeLower) {
    case "invalid_argument":
      status = msgLower.includes("internal error") ? 502 : 400;
      break;
    case "internal":
      status = 502;
      break;
    case "unauthenticated":
      status = 401;
      break;
    case "permission_denied":
      status = msgLower.includes("high demand") ? 429 : 403;
      break;
    case "resource_exhausted":
      status = 429;
      break;
    case "unavailable":
      status = 503;
      break;
    case "canceled":
      status = 499;
      break;
    case "deadline_exceeded":
      status = 504;
      break;
    case "failed_precondition":
      status = /quota|credit|acu|exhausted|limit/.test(msgLower) ? 429 : 400;
      break;
  }
  return { status, code, message: `devin upstream error (${code}): ${message}` };
}

// ---------- user status ----------

function parseSecondsSubfield(data) {
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_VARINT && f.field === 1) return Number(f.value);
  }
  return 0;
}

function parsePlanInfoOrg(data, status) {
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_BYTES && f.field === 4) status.orgId = textDecoder.decode(f.value);
    else if (f.wire === WIRE_BYTES && f.field === 8) status.orgName = textDecoder.decode(f.value);
  }
}

function parsePlanInfo(data, status) {
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_BYTES && f.field === 2) status.plan = textDecoder.decode(f.value);
    else if (f.wire === WIRE_BYTES && f.field === 33) parsePlanInfoOrg(f.value, status);
  }
}

function parsePlanStatus(data, status) {
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_BYTES) {
      if (f.field === 1) parsePlanInfo(f.value, status);
      else if (f.field === 2) {
        const sec = parseSecondsSubfield(f.value);
        if (sec > 0) status.planStart = new Date(sec * 1000).toISOString();
      } else if (f.field === 3) {
        const sec = parseSecondsSubfield(f.value);
        if (sec > 0) status.planEnd = new Date(sec * 1000).toISOString();
      }
    } else if (f.wire === WIRE_VARINT) {
      if (f.field === 14) status.dailyQuotaRemainingPercent = Number(f.value);
      else if (f.field === 15) status.weeklyQuotaRemainingPercent = Number(f.value);
      else if (f.field === 17 && f.value > 0n) status.dailyQuotaResetAt = new Date(Number(f.value) * 1000).toISOString();
      else if (f.field === 18 && f.value > 0n) status.weeklyQuotaResetAt = new Date(Number(f.value) * 1000).toISOString();
    }
  }
}

export function parseGetUserStatusResponse(data) {
  const status = {
    email: "",
    userName: "",
    userId: "",
    teamId: "",
    orgId: "",
    orgName: "",
    plan: "",
    // proto3 omits 0 on the wire, so "absent" must stay distinguishable from
    // "0 remaining" — null means the server never reported the quota.
    dailyQuotaRemainingPercent: null,
    weeklyQuotaRemainingPercent: null,
    dailyQuotaResetAt: "",
    weeklyQuotaResetAt: "",
    planStart: "",
    planEnd: "",
  };
  for (const f of iterFields(data)) {
    if (f.wire === WIRE_BYTES && f.field === 1) {
      for (const uf of iterFields(f.value)) {
        if (uf.wire !== WIRE_BYTES) continue;
        if (uf.field === 3) status.userName = textDecoder.decode(uf.value);
        else if (uf.field === 5) status.teamId = textDecoder.decode(uf.value);
        else if (uf.field === 7) status.email = textDecoder.decode(uf.value);
        else if (uf.field === 13) parsePlanStatus(uf.value, status);
        else if (uf.field === 36) status.userId = textDecoder.decode(uf.value);
      }
    }
  }
  return status;
}

// ---------- tool call id codec ----------

const PORTABLE_TOOL_ID = /^[A-Za-z0-9_-]+$/;

function base64UrlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}

function base64UrlDecode(str) {
  try {
    return Buffer.from(str, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function isPortableToolCallId(id) {
  return typeof id === "string" && id.length > 0 && PORTABLE_TOOL_ID.test(id);
}

// Reserve a namespace so native IDs cannot collide with encoded IDs. Empty
// deltas remain empty until upstream supplies the call ID.
export function encodeToolId(id) {
  if (!id || (isPortableToolCallId(id) && !id.startsWith(DEVIN_TOOL_ID_PREFIX))) return id;
  return DEVIN_TOOL_ID_PREFIX + base64UrlEncode(id);
}

// Remove exactly one canonical encoding layer. Ordinary legal IDs, malformed
// encodings and arbitrary base64-looking IDs stay intact.
export function decodeToolId(id) {
  if (typeof id !== "string" || !id.startsWith(DEVIN_TOOL_ID_PREFIX)) return id;
  const decoded = base64UrlDecode(id.slice(DEVIN_TOOL_ID_PREFIX.length));
  if (!decoded) return id;
  if (encodeToolId(decoded) !== id) return id;
  return decoded;
}
