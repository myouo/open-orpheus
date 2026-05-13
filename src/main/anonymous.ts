import { randomInt } from "node:crypto";
import type { SetCookie } from "cookie";

import { OSVER, VERSION } from "../constants";
import { encodeAnonymousUsername } from "./crypto";
import { getADDeviceId, getDeviceId } from "./device";
import { getCookies, getFullCookies, removeCookie, setCookie } from "./cookie";
import client from "./request";

const MUSIC_ORIGIN = "https://music.163.com";
// The upstream endpoint keeps the historical "anonimous" spelling.
const ANONYMOUS_API_URL = `${MUSIC_ORIGIN}/api/register/anonimous`;

type AnonymousSessionOptions = {
  force?: boolean;
  reason?: string;
};

type StoredCookie = Awaited<ReturnType<typeof getFullCookies>>[number];

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

export async function bootstrapMusicRequestCookies() {
  const authState = await getMusicAuthState();
  if (authState.hasUser) return;

  await setBootstrapCookies();
}

export async function getMusicAuthState() {
  const cookies = await getCookies(MUSIC_ORIGIN);
  return {
    hasUser: Boolean(cookies.MUSIC_U),
    hasAnonymous: Boolean(cookies.MUSIC_A),
  };
}

function parseRegisterResponseCode(responseBody: Buffer<ArrayBufferLike>) {
  try {
    const body = JSON.parse(responseBody.toString());
    return body?.code;
  } catch {
    return undefined;
  }
}

function isSuccessfulRegisterResponse(responseBody: Buffer<ArrayBufferLike>) {
  return parseRegisterResponseCode(responseBody) === 200;
}

async function getAnonymousCookie() {
  const cookies = await getFullCookies(MUSIC_ORIGIN);
  return cookies.find((cookie) => cookie.name === "MUSIC_A");
}

function toSetCookieSameSite(
  sameSite: StoredCookie["sameSite"]
): SetCookie["sameSite"] | undefined {
  switch (sameSite) {
    case "no_restriction":
      return "none";
    case "lax":
    case "strict":
      return sameSite;
    case "unspecified":
    default:
      return undefined;
  }
}

async function restoreAnonymousCookie(cookie: StoredCookie | undefined) {
  if (!cookie) return;

  try {
    await setCookie(MUSIC_ORIGIN, {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      expires: cookie.expirationDate
        ? new Date(cookie.expirationDate * 1000)
        : undefined,
      sameSite: toSetCookieSameSite(cookie.sameSite),
    });
  } catch (error) {
    console.warn(
      `[anonymous] Failed to restore previous anonymous session: ${(error as Error)?.message || String(error)}`
    );
  }
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

  const previousAnonymousCookie =
    options.force && authState.hasAnonymous
      ? await getAnonymousCookie()
      : undefined;

  if (options.force && authState.hasAnonymous) {
    await removeCookie(MUSIC_ORIGIN, "MUSIC_A");
  }

  await setBootstrapCookies();

  const response = await (async () => {
    try {
      return await client.post(ANONYMOUS_API_URL, {
        headers: {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `${MUSIC_ORIGIN}/`,
          "X-Request-ID": createRequestId(),
        },
        body: new URLSearchParams({
          username: encodeAnonymousUsername(deviceId),
        }).toString(),
        retry: {
          limit: 0,
        },
        throwHttpErrors: false,
        timeout: {
          request: 8000,
        },
      });
    } catch (error) {
      await restoreAnonymousCookie(previousAnonymousCookie);
      throw error;
    }
  })();

  const responseBody = Buffer.from(response.rawBody);
  if (!isSuccessfulRegisterResponse(responseBody)) {
    await restoreAnonymousCookie(previousAnonymousCookie);
    console.warn(
      `[anonymous] Anonymous session registration failed: HTTP ${response.statusCode}, code ${String(parseRegisterResponseCode(responseBody) ?? "unknown")}`
    );
    return false;
  }

  const nextAuthState = await getMusicAuthState();
  if (nextAuthState.hasAnonymous) {
    if (options.reason) {
      console.info(
        `[anonymous] Registered anonymous session: ${options.reason}`
      );
    }
    return true;
  }

  await restoreAnonymousCookie(previousAnonymousCookie);
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
      console.warn(
        `[anonymous] Anonymous session registration failed: ${(error as Error)?.message || String(error)}`
      );
      return false;
    })
    .finally(() => {
      pendingAnonymousSession = null;
    });

  return pendingAnonymousSession;
}

export function isAnonymousRegistrationUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith("music.163.com") &&
      (parsed.pathname === "/api/register/anonimous" ||
        parsed.pathname === "/eapi/register/anonimous")
    );
  } catch {
    return false;
  }
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
