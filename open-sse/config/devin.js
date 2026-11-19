// Devin (Cognition) constants — single source for every hardcoded value the
// native provider, OAuth flow, and quota probe use. Wire semantics ported from
// CLIProxyAPI internal/{runtime/executor/helps/devin_wire.go,auth/devin}.

export const DEVIN_APP_BASE = "https://app.devin.ai";
export const DEVIN_API_BASE = "https://api.devin.ai";
export const DEVIN_SERVER_BASE = "https://server.codeium.com";

export const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const DEVIN_AUTHORIZE_PATH = "/auth/cli/continue";
export const DEVIN_TOKEN_PATH = "/auth/cli/token";
export const DEVIN_SELF_PATH = "/v3/self";

export const DEVIN_CLIENT_NAME = "chisel";
export const DEVIN_CLIENT_VERSION = "3000.10.21";
export const DEVIN_FINGERPRINT_HEX_LEN = 732;
export const DEVIN_DEFAULT_MAX_TOKENS = 128000;
export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
export const DEVIN_MAX_TOOL_CALLS = 128;
export const DEVIN_TOOL_ID_PREFIX = "dv_tid_v1_";

// Connect-RPC envelope flags.
export const CONNECT_FLAG_DATA = 0x00;
export const CONNECT_FLAG_COMPRESSED = 0x01;
export const CONNECT_FLAG_END_STREAM = 0x02;
export const CONNECT_MAX_FRAME_SIZE = 16 * 1024 * 1024;
export const CONNECT_MAX_DECOMPRESSED_SIZE = 64 * 1024 * 1024;

// ChatMessagePrompt.source values on the wire.
export const DEVIN_SOURCE_USER = 1;
export const DEVIN_SOURCE_ASSISTANT = 2;
export const DEVIN_SOURCE_TOOL = 4;

// Effort levels accepted by Devin, in the canonical ordering used for clamping.
export const DEVIN_STANDARD_LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Model catalog ported from CLIProxyAPI internal/registry/models/devin_models.json.
// levels = thinking levels the upstream model accepts (absent = bare uid only).
export const DEVIN_MODELS = [
  { id: "swe-2", name: "SWE-2", contextLength: 262000, maxCompletionTokens: 64000, levels: ["medium", "high", "max"] },
  { id: "swe-2-flash", name: "SWE-2 Flash", contextLength: 262144, maxCompletionTokens: 64000, levels: ["medium", "high", "max"] },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-astra", name: "GPT-6 Astra", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-sol", name: "GPT-6 Sol", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-luna", name: "GPT-6 Luna", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["low", "medium", "high"] },
  { id: "kimi-k3-1-pro", name: "Kimi K3.1 Pro", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "max"] },
  { id: "glm-5-3", name: "GLM-5.3", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["low", "high", "max"] },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gemini-3-8-flash", name: "Gemini 3.8 Flash", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["low", "medium", "high"] },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5", name: "Claude Opus 5", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-5-fable", name: "Claude Fable 5", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gemini-3-5-flash", name: "Gemini 3.5 Flash", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["minimal", "low", "medium", "high"] },
  { id: "gemini-3-6-flash", name: "Gemini 3.6 Flash", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["minimal", "low", "medium", "high"] },
  { id: "gemini-3-7-flash", name: "Gemini 3.7 Flash", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["low", "medium", "high"] },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["low", "medium", "high"] },
  { id: "gpt-5-6-sol", name: "GPT-5.6 Sol", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5-6-terra", name: "GPT-5.6 Terra", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5-6-luna", name: "GPT-5.6 Luna", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-1-sol", name: "GPT-6.1 Sol", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-1-terra", name: "GPT-6.1 Terra", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "glm-5-2", name: "GLM-5.2", contextLength: 200000, maxCompletionTokens: 64000, levels: ["none", "max"] },
  { id: "glm-5-2-1m", name: "GLM-5.2 High 1M", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["none", "max"] },
  { id: "grok-4-6", name: "Grok 4.6", contextLength: 500000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh"] },
  { id: "grok-4-7", name: "Grok 4.7", contextLength: 500000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh"] },
  { id: "muse-wonder-1-0", name: "Muse Wonder", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "nemotron-3-5-super", name: "Nemotron 3.5 Super", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["none", "medium", "high"] },
  { id: "kimi-k3", name: "Kimi K3", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["low", "high", "max"] },
  { id: "glm-5-3-flash", name: "GLM-5.3 Flash", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["low", "high", "max"] },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["high", "max"] },
  { id: "deepseek-v4-1-flash-1017", name: "DeepSeek V4.1 Flash", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["none", "low", "high", "max"] },
  { id: "swe-1-7", name: "SWE-1.7", contextLength: 262000, maxCompletionTokens: 64000, levels: ["medium"] },
  { id: "swe-2-lightning", name: "SWE-2 Lightning", contextLength: 262144, maxCompletionTokens: 64000, levels: ["medium", "high", "max"] },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextLength: 200000, maxCompletionTokens: 64000 },
  { id: "claude-opus-4-6-1m", name: "Claude Opus 4.6 1M", contextLength: 1000000, maxCompletionTokens: 64000 },
  { id: "gpt-5-4", name: "GPT-5.4", contextLength: 272000, maxCompletionTokens: 64000, levels: ["none", "low", "medium", "high", "xhigh"] },
  { id: "gpt-5-5", name: "GPT-5.5", contextLength: 272000, maxCompletionTokens: 64000, levels: ["none", "low", "medium", "high", "xhigh"] },
  { id: "gpt-5-4-mini", name: "GPT-5.4 Mini", contextLength: 400000, maxCompletionTokens: 64000, levels: ["low", "medium", "high", "xhigh"] },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextLength: 200000, maxCompletionTokens: 64000 },
  { id: "claude-sonnet-4-6-1m", name: "Claude Sonnet 4.6 1M", contextLength: 1000000, maxCompletionTokens: 64000 },
  { id: "kimi-k2-6", name: "Kimi K2.6", contextLength: 262144, maxCompletionTokens: 64000 },
  { id: "kimi-k2-7", name: "Kimi K2.7", contextLength: 262144, maxCompletionTokens: 64000 },
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", contextLength: 1000000, maxCompletionTokens: 64000, levels: ["none", "medium", "high"] },
  { id: "swe-1-6", name: "SWE-1.6", contextLength: 200000, maxCompletionTokens: 64000 },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextLength: 1048576, maxCompletionTokens: 64000, levels: ["high", "max"] },
];
