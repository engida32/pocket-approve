import { bearerToken, tokensEqual } from "./auth.mjs";

function publicDevice(device) {
  const { tokenHash, ...rest } = device;
  return rest;
}

export function createAuthenticator({ devices, allowLegacyToken = false, legacyToken = null } = {}) {
  if (!devices || typeof devices.findActive !== "function") {
    throw new TypeError("devices.findActive is required");
  }
  async function authenticate(request) {
    const token = bearerToken(request);
    if (!token) return null;
    const device = await devices.findActive(token);
    if (device) {
      if (typeof devices.touch === "function") {
        try {
          await devices.touch(device.id);
        } catch {}
      }
      return { device: publicDevice(device) };
    }
    if (allowLegacyToken && typeof legacyToken === "string" && tokensEqual(token, legacyToken)) {
      return { legacy: true };
    }
    return null;
  }
  return { authenticate };
}

export function expectedOrigin(config) {
  if (config.mode === "lan") {
    const derived = config.publicOrigin;
    if (typeof derived === "string" && derived.length > 0) return derived;
    return `https://${config.host}:${config.httpsPort}`;
  }
  return config.publicOrigin;
}

export function originAllowed(request, config) {
  const origin = request?.headers?.origin;
  if (!origin) return false;
  return origin === expectedOrigin(config);
}
