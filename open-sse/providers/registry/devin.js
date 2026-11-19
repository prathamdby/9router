// Devin (Cognition) — native Connect-RPC protobuf provider.
// Chat = POST {base} Content-Type: application/connect+proto
//   Service: exa.api_server_pb.ApiServerService / GetChatMessage
// Auth = PKCE OAuth at app.devin.ai → permanent devin-session-token$ credential.
import { DEVIN_SERVER_BASE, DEVIN_CHAT_PATH, DEVIN_MODELS } from "../../config/devin.js";

export default {
  id: "devin",
  alias: "devin",
  display: {
    name: "Devin",
    icon: "smart_toy",
    color: "#317cff",
    textIcon: "DV",
    website: "https://devin.ai",
    notice: { signupUrl: "https://app.devin.ai" },
  },
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],

  transport: {
    baseUrl: DEVIN_SERVER_BASE + DEVIN_CHAT_PATH,
    format: "openai",
  },

  passthroughModels: true,

  models: DEVIN_MODELS.map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength })),

  features: {
    usage: true,
  },
};
