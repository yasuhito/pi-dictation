import {
  BridgeProtocolFailure,
  request,
  type BridgeProtocolResponse,
  type JsonObject,
} from "../lib/bridge-protocol.mjs";

const payload: JsonObject = { probe: [true, null, 3] };
const pending: Promise<BridgeProtocolResponse> = request({
  endpoint: { type: "unix", path: "/private/listener.sock" },
  credential: { id: "77777777-7777-4777-8777-777777777777", secret: new Uint8Array(32) },
  requestId: "88888888-8888-4888-8888-888888888888",
  operation: "health",
  payload,
  timing: {
    connect: { kind: "absolute", at: Date.now() + 1000 },
    challenge: { kind: "no-progress", timeoutMs: 1000 },
    requestWrite: { kind: "no-progress", timeoutMs: 1000 },
    response: { kind: "absolute", at: Date.now() + 1000 },
  },
  signal: new AbortController().signal,
});

void pending;
void new BridgeProtocolFailure("transport", "connect");
