import dns from "node:dns";

import { RequestError } from "got";
import type { Method } from "got";

import { registerCallHandler } from "../calls";
import { deserialData } from "../crypto";
import client from "../request";

let globalFailCount = 0;
let globalSucCount = 0;

export type NetworkFetchRequest = {
  url: string;
  method: Method;
  headers: Record<string, string>;
  body: string;
  retryCount: number;
  isDecrypt?: boolean;
};

export type NetworkFetchResponse = {
  code: number;
  error: string;
} & Partial<{
  globalFailCount: number;
  globalSucCount: number;
  headers: Record<string, string>;
  retryTimes: number;
  status: number;
  blob: string;
}>;

async function fetchRequest(request: NetworkFetchRequest, retryCount: number) {
  return await client(request.url, {
    method: request.method,
    headers: {
      ...request.headers,
    },
    body: request.body || undefined,
    throwHttpErrors: false,
    retry: {
      limit: retryCount,
      backoffLimit: 10000,
    },
    hooks: {
      beforeRetry: [
        () => {
          globalFailCount++;
        },
      ],
    },
  });
}

async function responseToNetworkFetchResponse(
  request: NetworkFetchRequest,
  response: Awaited<ReturnType<typeof fetchRequest>>,
  retryCount: number
): Promise<NetworkFetchResponse> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    } else if (value !== undefined) {
      headers[key] = value;
    }
  }

  const responseBody = Buffer.from(response.rawBody);
  const blob = request.isDecrypt
    ? deserialData(
        responseBody.buffer.slice(
          responseBody.byteOffset,
          responseBody.byteOffset + responseBody.byteLength
        )
      )
    : responseBody.toString();

  globalSucCount++;

  return {
    code: 0,
    blob,
    error: "",
    globalFailCount,
    globalSucCount,
    headers,
    retryTimes: retryCount - response.retryCount - 1,
    status: response.statusCode,
  };
}

async function shouldRetryAfterAnonymousRegistration(
  request: NetworkFetchRequest,
  response: Awaited<ReturnType<typeof fetchRequest>>
) {
  const { isAnonymousRegistrationUrl, isMusicApiUrl } =
    await import("../anonymous");
  if (!isMusicApiUrl(request.url)) return false;
  if (isAnonymousRegistrationUrl(request.url)) return false;
  if (response.statusCode === 400) return true;

  try {
    const responseBody = Buffer.from(response.rawBody);
    const blob = request.isDecrypt
      ? deserialData(
          responseBody.buffer.slice(
            responseBody.byteOffset,
            responseBody.byteOffset + responseBody.byteLength
          )
        )
      : responseBody.toString();
    return JSON.parse(blob).code === 400;
  } catch {
    return false;
  }
}

function describeRequestUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "music API request";
  }
}

registerCallHandler<[NetworkFetchRequest], [NetworkFetchResponse]>(
  "network.fetch",
  async (_, request): Promise<[NetworkFetchResponse]> => {
    const retryCount = request.retryCount ?? 1;

    try {
      let response = await fetchRequest(request, retryCount);
      if (await shouldRetryAfterAnonymousRegistration(request, response)) {
        const { ensureAnonymousSession } = await import("../anonymous");
        const registered = await ensureAnonymousSession({
          force: true,
          reason: `400 from ${describeRequestUrl(request.url)}`,
        });
        if (registered) {
          response = await fetchRequest(request, retryCount);
        }
      }

      return [
        await responseToNetworkFetchResponse(request, response, retryCount),
      ];
    } catch (error) {
      globalFailCount++;
      const retryTimes =
        error instanceof RequestError && error.request
          ? retryCount - error.request.retryCount - 1
          : 0;

      return [
        {
          code: 28,
          error:
            (error as Error)?.message ||
            (error ? String(error) : "Unknown error"),
          status: 0,
          blob: "",
          headers: {},
          retryTimes,
        },
      ];
    }
  }
);

registerCallHandler<
  [],
  [
    {
      dnsInvalid: boolean;
      firstDNS: string;
      inProxy: boolean;
      restricted: boolean;
      unreachable: boolean;
    },
  ]
>("network.getEnv", () => [
  {
    dnsInvalid: false,
    firstDNS: dns.getServers()[0] || "",
    inProxy: false,
    restricted: false,
    unreachable: false,
  },
]);
