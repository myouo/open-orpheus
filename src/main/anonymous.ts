import { randomInt } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SetCookie } from "cookie";

import { CORE_VERSION, OSVER } from "../constants";
import { deserialData, encodeAnonymousUsername, serialData } from "./crypto";
import {
  forgetSuccessfulDeviceId,
  getADDeviceId,
  getDeviceId,
  refreshDeviceId,
  rememberSuccessfulDeviceId,
  useDeviceId,
} from "./device";
import { getCookies, getFullCookies, removeCookie, setCookie } from "./cookie";
import { data as dataDir } from "./folders";
import client from "./request";

const MUSIC_ORIGIN = "https://music.163.com";
const INTERFACE_PC_ORIGIN = "https://interfacepc.music.163.com";
// The upstream endpoint keeps the historical "anonimous" spelling.
const ANONYMOUS_API_PATH = "/api/register/anonimous";
const ANONYMOUS_EAPI_URL = `${INTERFACE_PC_ORIGIN}/eapi/register/anonimous`;
const MAX_ANONYMOUS_REGISTRATION_ATTEMPTS = 10;
const ANONYMOUS_SESSION_VERSION = 2;
const ANONYMOUS_AUTH_COOKIE_NAME = "MUSIC_A";
const anonymousSessionFilePath = join(dataDir, "anonymous_session.json");
const ANONYMOUS_SESSION_COOKIE_NAMES = new Set([
  ANONYMOUS_AUTH_COOKIE_NAME,
  "__csrf",
]);

type AnonymousSessionOptions = {
  force?: boolean;
  reason?: string;
};

type StoredCookie = Awaited<ReturnType<typeof getFullCookies>>[number];
type PersistedAnonymousCookie = Pick<
  StoredCookie,
  | "name"
  | "value"
  | "domain"
  | "path"
  | "httpOnly"
  | "secure"
  | "expirationDate"
  | "sameSite"
>;
type PersistedAnonymousSession = {
  version?: number;
  deviceId?: string;
  cookies?: PersistedAnonymousCookie[];
};
type AnonymousRegistrationResponse = Awaited<
  ReturnType<typeof postAnonymousRegistration>
>;

let pendingAnonymousSession: Promise<boolean> | null = null;

function createRequestId() {
  return `${Date.now()}_${randomInt(1000).toString().padStart(4, "0")}`;
}

function isExpiredCookie(cookie: Pick<StoredCookie, "expirationDate">) {
  return Boolean(
    cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000 + 60
  );
}

function isAnonymousSessionCookie(
  cookie: Pick<StoredCookie, "name" | "value" | "expirationDate">
) {
  return Boolean(
    ANONYMOUS_SESSION_COOKIE_NAMES.has(cookie.name) &&
    cookie.value &&
    !isExpiredCookie(cookie)
  );
}

function hasAnonymousAuthCookie(
  cookies: ReadonlyArray<Pick<StoredCookie, "name">>
) {
  return cookies.some((cookie) => cookie.name === ANONYMOUS_AUTH_COOKIE_NAME);
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
    setBootstrapCookie("appver", CORE_VERSION),
    setBootstrapCookie("channel", "netease"),
    setBootstrapCookie("deviceId", deviceId),
    setBootstrapCookie("clientSign", clientSign),
    setBootstrapCookie("osver", OSVER),
    setBootstrapCookie("mode", "System Product Name"),
  ]);
}

export async function bootstrapMusicRequestCookies() {
  const authState = await getMusicAuthState();
  if (authState.hasUser) return;

  if (!authState.hasAnonymous) {
    await restorePersistedAnonymousSession();
  } else {
    await persistAnonymousSessionCookies();
  }

  await setBootstrapCookies();
}

export async function getMusicAuthState() {
  const cookies = await getCookies(MUSIC_ORIGIN);
  return {
    hasUser: Boolean(cookies.MUSIC_U),
    hasAnonymous: Boolean(cookies[ANONYMOUS_AUTH_COOKIE_NAME]),
  };
}

function parseRegisterResponseBody(responseBody: Buffer<ArrayBufferLike>) {
  try {
    return JSON.parse(responseBody.toString());
  } catch {
    try {
      return JSON.parse(deserialData(responseBody.toString()));
    } catch {
      return undefined;
    }
  }
}

function parseRegisterResponseCode(responseBody: Buffer<ArrayBufferLike>) {
  return parseRegisterResponseBody(responseBody)?.code;
}

async function getAnonymousCookie() {
  const cookies = await getFullCookies(MUSIC_ORIGIN);
  return cookies.find((cookie) => cookie.name === ANONYMOUS_AUTH_COOKIE_NAME);
}

async function getAnonymousSessionCookies() {
  const cookies = await getFullCookies(MUSIC_ORIGIN);
  return cookies.filter(isAnonymousSessionCookie);
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

async function setStoredCookie(
  cookie: PersistedAnonymousCookie | StoredCookie | undefined
) {
  if (!cookie) return;

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
}

async function restoreAnonymousCookie(cookie: StoredCookie | undefined) {
  try {
    await setStoredCookie(cookie);
  } catch (error) {
    console.warn(
      `[anonymous] Failed to restore previous anonymous session: ${(error as Error)?.message || String(error)}`
    );
  }
}

async function persistAnonymousSessionCookies() {
  const cookies = await getAnonymousSessionCookies();
  if (!hasAnonymousAuthCookie(cookies)) return;

  const persisted: PersistedAnonymousSession = {
    version: ANONYMOUS_SESSION_VERSION,
    deviceId: getDeviceId(),
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      expirationDate: cookie.expirationDate,
      sameSite: cookie.sameSite,
    })),
  };

  try {
    await writeFile(
      anonymousSessionFilePath,
      JSON.stringify(persisted, null, 2),
      "utf-8"
    );
  } catch (error) {
    console.warn(
      `[anonymous] Failed to persist anonymous session: ${(error as Error)?.message || String(error)}`
    );
  }
}

async function forgetPersistedAnonymousSession() {
  try {
    await unlink(anonymousSessionFilePath);
  } catch {
    // It is fine if there is no persisted anonymous session yet.
  }
}

async function restorePersistedAnonymousSession() {
  let persisted: PersistedAnonymousSession;
  try {
    persisted = JSON.parse(await readFile(anonymousSessionFilePath, "utf-8"));
  } catch {
    return false;
  }

  if (persisted.version !== ANONYMOUS_SESSION_VERSION) return false;

  const cookies = (persisted.cookies ?? []).filter(isAnonymousSessionCookie);
  if (!hasAnonymousAuthCookie(cookies)) {
    await forgetPersistedAnonymousSession();
    return false;
  }
  if (!persisted.deviceId || !(await useDeviceId(persisted.deviceId))) {
    await forgetPersistedAnonymousSession();
    return false;
  }

  try {
    await Promise.all(cookies.map(setStoredCookie));
  } catch (error) {
    console.warn(
      `[anonymous] Failed to restore persisted anonymous session: ${(error as Error)?.message || String(error)}`
    );
    return false;
  }

  const authState = await getMusicAuthState();
  if (authState.hasAnonymous) {
    await rememberSuccessfulDeviceId(persisted.deviceId);
    console.info("[anonymous] Restored persisted anonymous session");
    return true;
  }

  await forgetPersistedAnonymousSession();
  return false;
}

async function postAnonymousRegistration(deviceId: string) {
  return await client.post(ANONYMOUS_EAPI_URL, {
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${MUSIC_ORIGIN}/`,
      "X-Request-ID": createRequestId(),
    },
    body: new URLSearchParams({
      params: serialData(ANONYMOUS_API_PATH, {
        username: encodeAnonymousUsername(deviceId),
      }),
    }).toString(),
    retry: {
      limit: 0,
    },
    throwHttpErrors: false,
    timeout: {
      request: 5000,
    },
  });
}

function logRegistrationResponse(
  response: AnonymousRegistrationResponse,
  responseCode: number | undefined,
  attempt: number
) {
  console.info("[anonymous] Registration response", {
    attempt,
    httpStatus: response.statusCode,
    responseCode: responseCode ?? null,
    responseBodyLength: response.rawBody.length,
  });
}

async function registerAnonymousSession(options: AnonymousSessionOptions) {
  let authState = await getMusicAuthState();
  if (!authState.hasUser && !authState.hasAnonymous) {
    await restorePersistedAnonymousSession();
    authState = await getMusicAuthState();
  }

  if (authState.hasUser) return true;
  if (authState.hasAnonymous && !options.force) {
    await persistAnonymousSessionCookies();
    return true;
  }

  const previousAnonymousCookie =
    options.force && authState.hasAnonymous
      ? await getAnonymousCookie()
      : undefined;

  if (options.force && authState.hasAnonymous) {
    await removeCookie(MUSIC_ORIGIN, ANONYMOUS_AUTH_COOKIE_NAME);
    await forgetPersistedAnonymousSession();
  }

  await setBootstrapCookies();

  for (
    let attempt = 1;
    attempt <= MAX_ANONYMOUS_REGISTRATION_ATTEMPTS;
    attempt++
  ) {
    const currentDeviceId = getDeviceId();
    if (!currentDeviceId) {
      console.warn(
        "[anonymous] Cannot register anonymous session: no device ID"
      );
      return false;
    }

    console.info("[anonymous] Registration attempt", {
      reason: options.reason ?? null,
      attempt,
      maxAttempts: MAX_ANONYMOUS_REGISTRATION_ATTEMPTS,
      deviceId: currentDeviceId,
    });

    let response: AnonymousRegistrationResponse;
    try {
      response = await postAnonymousRegistration(currentDeviceId);
    } catch (error) {
      await restoreAnonymousCookie(previousAnonymousCookie);
      throw error;
    }

    const responseBody = Buffer.from(response.rawBody);
    const responseCode = parseRegisterResponseCode(responseBody);
    logRegistrationResponse(response, responseCode, attempt);

    if (responseCode === 200) {
      const nextAuthState = await getMusicAuthState();
      if (nextAuthState.hasAnonymous) {
        await rememberSuccessfulDeviceId(currentDeviceId);
        await persistAnonymousSessionCookies();
        if (options.reason) {
          console.info(
            `[anonymous] Registered anonymous session: ${options.reason} (attempt ${attempt}/${MAX_ANONYMOUS_REGISTRATION_ATTEMPTS})`
          );
        }
        return true;
      }

      await restoreAnonymousCookie(previousAnonymousCookie);
      console.warn(
        `[anonymous] Anonymous session registration failed: HTTP ${response.statusCode}, missing MUSIC_A`
      );
      return false;
    }

    if (responseCode === 400 && attempt < MAX_ANONYMOUS_REGISTRATION_ATTEMPTS) {
      console.warn(
        `[anonymous] Anonymous session registration got code 400, retrying with a new device identity (${attempt}/${MAX_ANONYMOUS_REGISTRATION_ATTEMPTS})`
      );
      await forgetSuccessfulDeviceId(currentDeviceId);
      await refreshDeviceId("anonymous registration returned code 400", {
        rotateDeviceId: true,
      });
      await setBootstrapCookies();
      continue;
    }

    await restoreAnonymousCookie(previousAnonymousCookie);
    console.warn(
      `[anonymous] Anonymous session registration failed: HTTP ${response.statusCode}, code ${String(responseCode ?? "unknown")}`
    );
    return false;
  }

  await restoreAnonymousCookie(previousAnonymousCookie);
  console.warn("[anonymous] Anonymous session registration attempts exhausted");
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
