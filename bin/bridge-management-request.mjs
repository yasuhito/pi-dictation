import { randomUUID } from "node:crypto";
import {
  BridgeProtocolFailure,
  request as sharedRequest,
} from "../lib/bridge-protocol.mjs";

const REQUEST_TIMEOUT_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class BridgeManagementRequestError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BridgeManagementRequestError";
  }
}

function invalidCredential() {
  return new BridgeManagementRequestError("Refusing invalid bridge credential.");
}

function credentialForRequest(credential) {
  if (!credential || typeof credential.id !== "string" || !UUID.test(credential.id) ||
      typeof credential.secret !== "string" || credential.secret.length === 0 || credential.secret.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(credential.secret)) {
    throw invalidCredential();
  }
  const secret = Buffer.from(credential.secret, "base64");
  if (secret.length !== 32 || secret.toString("base64") !== credential.secret) throw invalidCredential();
  return { id: credential.id, secret };
}

function protocolFailure(error) {
  if (!(error instanceof BridgeProtocolFailure)) return error;
  if (error.kind === "deadline") {
    return new BridgeManagementRequestError("Authenticated health request timed out.", { cause: error });
  }
  if (error.kind === "cancelled") {
    return new BridgeManagementRequestError("Authenticated health request was cancelled.", { cause: error });
  }
  const code = error.cause instanceof Error && "code" in error.cause ? error.cause.code : undefined;
  if (code === "ERR_BRIDGE_TRAILING_BYTES") {
    return new BridgeManagementRequestError("The companion sent trailing protocol bytes.", { cause: error });
  }
  if (code === "ERR_BRIDGE_INVALID_FRAME") {
    return new BridgeManagementRequestError("The companion sent an invalid protocol frame.", { cause: error });
  }
  if (code === "ERR_BRIDGE_MALFORMED_PROTOCOL_DATA") {
    return new BridgeManagementRequestError("The companion sent malformed protocol data.", { cause: error });
  }
  if (code === "ERR_BRIDGE_INVALID_CHALLENGE") {
    return new BridgeManagementRequestError("The companion sent an invalid authentication challenge.", { cause: error });
  }
  if (code === "ERR_BRIDGE_INVALID_RESPONSE") {
    return new BridgeManagementRequestError("The companion returned an invalid authenticated response.", { cause: error });
  }
  if (code === "ERR_BRIDGE_INVALID_VERSION_DATA") {
    return new BridgeManagementRequestError("The companion returned invalid authenticated version data.", { cause: error });
  }
  if (code === "ERR_BRIDGE_NONCANONICAL_AUTHENTICATION" || error.kind === "malformed") {
    return new BridgeManagementRequestError("The companion sent malformed authenticated protocol data.", { cause: error });
  }
  if (error.kind === "authentication") {
    return new BridgeManagementRequestError("The companion response could not be authenticated.", { cause: error });
  }
  if (error.kind === "transport" && code === "ERR_BRIDGE_UNEXPECTED_EOF") {
    return new BridgeManagementRequestError("The companion closed an incomplete health response.", { cause: error });
  }
  if (error.kind === "transport") {
    return new BridgeManagementRequestError("The companion Unix socket is unavailable.", { cause: error });
  }
  return error;
}

function exactObject(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export async function companionRequestAt(endpoint, credential, operation, fixedRequestId, request = sharedRequest) {
  const requestCredential = credentialForRequest(credential);
  const challengeDeadline = Date.now() + REQUEST_TIMEOUT_MS;
  let response;
  try {
    response = await request({
      endpoint,
      credential: requestCredential,
      requestId: fixedRequestId || randomUUID(),
      operation,
      payload: {},
      timing: {
        connect: { kind: "absolute", at: challengeDeadline },
        challenge: { kind: "absolute", at: challengeDeadline },
        requestWrite: { kind: "no-progress", timeoutMs: REQUEST_TIMEOUT_MS },
        response: { kind: "no-progress", timeoutMs: REQUEST_TIMEOUT_MS },
      },
      signal: new AbortController().signal,
    });
  } catch (error) {
    throw protocolFailure(error);
  }
  if (response.status === "version-mismatch") {
    if (!exactObject(response.payload, ["clientVersion", "companionVersion"]) ||
        !Number.isSafeInteger(response.payload.clientVersion) || !Number.isSafeInteger(response.payload.companionVersion)) {
      throw new BridgeManagementRequestError("The companion returned invalid authenticated version data.");
    }
    throw new BridgeManagementRequestError(
      `Authenticated protocol mismatch: Pi uses version ${response.payload.clientVersion}; companion uses version ${response.payload.companionVersion}.`,
    );
  }
  if (response.status !== "ok") {
    const error = new BridgeManagementRequestError(
      `The companion rejected ${operation} with authenticated status ${response.status}.`,
    );
    error.status = response.status;
    throw error;
  }
  return response.payload;
}
