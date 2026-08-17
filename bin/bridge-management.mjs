import { randomUUID } from "node:crypto";
import { BridgeProtocolFailure, request as sharedRequest } from "../lib/bridge-protocol.mjs";

const MANAGEMENT_PHASE_TIMEOUT_MS = 5000;
const PERMISSION_VALUES = ["authorized", "denied", "restricted", "not-determined", "unknown"];
const productionBridgeProtocol = { request: sharedRequest };

export class CliError extends Error {}

function exactObject(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function managementSecret(credential) {
  const value = credential?.secret;
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CliError("Refusing invalid bridge credential.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.length !== 32) {
    throw new CliError("Refusing invalid bridge credential.");
  }
  return decoded;
}

const MALFORMED_CAUSE_MESSAGES = {
  ERR_BRIDGE_TRAILING_BYTES: "The companion sent trailing protocol bytes.",
  ERR_BRIDGE_FRAME_LENGTH: "The companion sent an invalid protocol frame.",
  ERR_BRIDGE_ENCODING: "The companion sent malformed authenticated protocol data.",
  ERR_BRIDGE_PAYLOAD: "The companion sent malformed authenticated protocol data.",
  ERR_BRIDGE_VERSION_DATA: "The companion returned invalid authenticated version data.",
};

function causeMessage(failure) {
  return failure.cause instanceof Error ? MALFORMED_CAUSE_MESSAGES[failure.cause.code] : undefined;
}

function managementFailure(error) {
  if (!(error instanceof BridgeProtocolFailure)) return error;
  // Management exchanges pass a signal that is never aborted, so `cancelled` can only mean an
  // expired management budget observed as an abort by the shared seam.
  if (error.kind === "deadline" || error.kind === "cancelled") {
    return new CliError("Authenticated health request timed out.");
  }
  const protocolMessage = causeMessage(error);
  if (protocolMessage !== undefined) return new CliError(protocolMessage);
  if (error.kind === "authentication") return new CliError("The companion response could not be authenticated.");
  if (error.kind === "transport") {
    return new CliError(error.stage === "connect" || error.stage === "request-write"
      ? "The companion Unix socket is unavailable."
      : "The companion closed an incomplete health response.");
  }
  if (error.stage === "connect") return new CliError("The companion Unix socket is unavailable.");
  if (error.stage === "request-write") return new CliError("Refusing invalid bridge credential.");
  // Strict JSON and UTF-8 faults in a frame keep a native decoding cause; shape faults carry none.
  if (error.cause instanceof Error) return new CliError("The companion sent malformed protocol data.");
  return new CliError(error.stage === "challenge"
    ? "The companion sent an invalid authentication challenge."
    : "The companion returned an invalid authenticated response.");
}

export async function companionRequestAt(
  endpoint, credential, operation, fixedRequestId, protocol = productionBridgeProtocol,
) {
  const secret = managementSecret(credential);
  const startedAt = Date.now();
  let response;
  try {
    response = await protocol.request({
      endpoint,
      credential: { id: credential.id, secret },
      requestId: fixedRequestId || randomUUID(),
      operation,
      payload: {},
      timing: {
        // Connecting and reading the challenge share one five-second budget, as the single
        // challenge-phase timer did; the response phase starts its own budget after the request.
        connect: { kind: "absolute", at: startedAt + MANAGEMENT_PHASE_TIMEOUT_MS },
        challenge: { kind: "absolute", at: startedAt + MANAGEMENT_PHASE_TIMEOUT_MS },
        requestWrite: { kind: "phase", timeoutMs: MANAGEMENT_PHASE_TIMEOUT_MS },
        response: { kind: "phase", timeoutMs: MANAGEMENT_PHASE_TIMEOUT_MS },
      },
      signal: new AbortController().signal,
    });
  } catch (error) {
    throw managementFailure(error);
  }
  if (response.status === "version-mismatch") {
    throw new CliError(`Authenticated protocol mismatch: Pi uses version ${response.payload.clientVersion}; companion uses version ${response.payload.companionVersion}.`);
  }
  if (response.status !== "ok") {
    const error = new CliError(`The companion rejected ${operation} with authenticated status ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response.payload;
}

export async function healthAt(endpoint, credential, protocol = productionBridgeProtocol) {
  const health = await companionRequestAt(endpoint, credential, "health", undefined, protocol);
  if (!exactObject(health, ["permission", "defaultInputAvailable"]) ||
      !PERMISSION_VALUES.includes(health.permission) ||
      typeof health.defaultInputAvailable !== "boolean") {
    throw new CliError("The companion returned invalid health data.");
  }
  return health;
}
