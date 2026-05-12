import { randomInt } from "node:crypto";

import { OSVER, VERSION } from "../constants";
import { encodeAnonymousUsername } from "./crypto";
import { getADDeviceId, getDeviceId } from "./device";
import { getCookies, removeCookie, setCookie } from "./cookie";
import client from "./request";

const MUSIC_ORIGIN = "https://music.163.com";
// The upstream endpoint keeps the historical "anonimous" spelling.
const ANONYMOUS_API_URL = `${MUSIC_ORIGIN}/api/register/anonimous`;
const ANONYMOUS_ID = "NMUSIC";

type AnonymousSessionOptions = {
  force?: boolean;
  reason?: string;
};

let pendingAnonymousSession: Promise<boolean> | null = null;

function createRequestId() {
  return `${Date.now()}_${randomInt(1000).toString().padStart(4, "0")}`;
}

async function setBootstrapCookie(name: string, value: string) {
  if (!value) return;
  await setCookie(MUSIC_ORIGIN, {
    name,
    value,
    domain: ".music.163.com",
    path: "/",
  });
}

async function setBootstrapCookies() {
  const deviceId = getDeviceId();
  const clientSign = getADDeviceId();

  await Promise.all([
    setBootstrapCookie("os", "pc"),
    setBootstrapCookie("appver", VERSION),
    setBootstrapCookie("channel", "netease"),
    setBootstrapCookie("deviceId", deviceId),
    setBootstrapCookie("clientSign", clientSign),
    setBootstrapCookie("osver", OSVER),
  ]);
}

export async function getMusicAuthState() {
  const cookies = await getCookies(MUSIC_ORIGIN);
  return {
    hasUser: Boolean(cookies.MUSIC_U),
    hasAnonymous: Boolean(cookies.MUSIC_A),
  };
}

async function registerAnonymousSession(options: AnonymousSessionOptions) {
  const authState = await getMusicAuthState();
  if (authState.hasUser) return true;
  if (authState.hasAnonymous && !options.force) return true;

  const deviceId = getDeviceId();
  if (!deviceId) {
    console.warn("[anonymous] Cannot register anonymous session: no device ID");
    return false;
  }

  if (options.force && authState.hasAnonymous) {
    await removeCookie(MUSIC_ORIGIN, "MUSIC_A");
  }

  await setBootstrapCookies();

  const response = await client.post(ANONYMOUS_API_URL, {
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${MUSIC_ORIGIN}/`,
      "X-Request-ID": createRequestId(),
    },
    body: new URLSearchParams({
      username: encodeAnonymousUsername(ANONYMOUS_ID),
    }).toString(),
    retry: {
      limit: 0,
    },
    throwHttpErrors: false,
    timeout: {
      request: 8000,
    },
  });

  const nextAuthState = await getMusicAuthState();
  if (nextAuthState.hasAnonymous) {
    if (options.reason) {
      console.info(
        `[anonymous] Registered anonymous session: ${options.reason}`
      );
    }
    return true;
  }

  console.warn(
    `[anonymous] Anonymous session registration failed: HTTP ${response.statusCode}`
  );
  return false;
}

export async function ensureAnonymousSession(
  options: AnonymousSessionOptions = {}
) {
  if (pendingAnonymousSession) return pendingAnonymousSession;

  pendingAnonymousSession = registerAnonymousSession(options)
    .catch((error) => {
      console.warn("[anonymous] Anonymous session registration failed:", error);
      return false;
    })
    .finally(() => {
      pendingAnonymousSession = null;
    });

  return pendingAnonymousSession;
}

export function isMusicApiUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith("music.163.com") &&
      (parsed.pathname.startsWith("/eapi/") ||
        parsed.pathname.startsWith("/api/"))
    );
  } catch {
    return false;
  }
}
