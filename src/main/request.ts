import { parseSetCookie, stringifyCookie } from "cookie";
import got from "got";
import { session } from "electron";

import { getCookies, setCookie } from "./cookie";

const client = got.extend({
  headers: {
    // We get User-Agent from Electron, so make sure this module is only imported after app ready.
    "User-Agent": session.defaultSession.getUserAgent(),
    Origin: "orpheus://orpheus",
  },
  cookieJar: {
    getCookieString: async (url: string) => {
      return stringifyCookie(await getCookies(url));
    },
    setCookie: async (rawCookie: string, url: string) => {
      await setCookie(url, parseSetCookie(rawCookie));
    },
  },
});

export default client;

export function setupRequestInterceptors() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    async (details, callback) => {
      const url = new URL(details.url);

      // Generic Cookie Injection
      if (url.protocol === "https:" && url.hostname.endsWith("music.163.com")) {
        const cookies = stringifyCookie(
          await getCookies("https://" + url.hostname)
        );
        details.requestHeaders["Cookie"] = cookies;
      }

      callback({ requestHeaders: details.requestHeaders });
    }
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    details.responseHeaders = details.responseHeaders ?? {};

    // Custom skin
    if (details.url.startsWith("https://music.163.com/api/nos/token/alloc")) {
      details.responseHeaders["Access-Control-Allow-Origin"] = [
        "orpheus://orpheus",
      ];
      details.responseHeaders["Access-Control-Allow-Credentials"] = ["true"];
    }

    callback({ responseHeaders: details.responseHeaders });
  });
}
