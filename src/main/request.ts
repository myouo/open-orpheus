import type { AgentOptions } from "http";

import { parseSetCookie, stringifyCookie } from "cookie";
import got, { type Agents, type Got } from "got";
import { session } from "electron";

import { getCookies, setCookie } from "./cookie";

export type ProxyTypes = "none" | "ie" | "http" | "socks4" | "socks5";

export type ProxyServer = {
  Host: string;
  Port: string;
  UserName: string;
  Password: string;
};

export type ProxyConfiguration = {
  Type: ProxyTypes;
} & Partial<Record<ProxyTypes, ProxyServer>>;

const defaultHttpAgentOptions: AgentOptions = {
  keepAlive: true,
};

export function getProxyURL(proto: string, server: ProxyServer): URL {
  const url = new URL(`${proto}://${server.Host}:${server.Port}`);
  if (server.UserName || server.Password) {
    url.username = server.UserName;
    url.password = server.Password;
  }
  return url;
}

export async function getProxyAgent(
  config?: ProxyConfiguration
): Promise<Agents | undefined> {
  if (!config) return undefined;
  switch (config.Type) {
    case "none":
      return undefined;
    case "ie": {
      const ProxyAgent = (await import("proxy-agent")).ProxyAgent;
      const agent = new ProxyAgent(defaultHttpAgentOptions);
      return {
        http: agent,
        https: agent,
        http2: undefined,
      };
    }
    case "http": {
      const HttpProxyAgent = (await import("http-proxy-agent")).HttpProxyAgent;
      const cfg = config[config.Type]!;
      const agent = new HttpProxyAgent(
        getProxyURL(config.Type, cfg),
        defaultHttpAgentOptions
      );
      return {
        http: agent,
        https: agent,
        http2: undefined,
      };
    }
    case "socks4":
    case "socks5": {
      const SocksProxyAgent = (await import("socks-proxy-agent"))
        .SocksProxyAgent;
      const cfg = config[config.Type]!;
      const agent = new SocksProxyAgent(
        getProxyURL(config.Type, cfg),
        defaultHttpAgentOptions
      );
      return {
        http: agent,
        https: agent,
        http2: undefined,
      };
    }
  }
}

let client: Got = got.extend({
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

export function setProxy(agents: Agents | undefined) {
  client = client.extend({
    agent: agents,
  });
}

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
