import { type LookupAddress, lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { GenerationValidationError } from "./errors.js";
import type { GenerationMediaFetch } from "./types.js";

const MAX_REDIRECTS = 5;

/** True only for globally routable unicast addresses; private, loopback, link-local, CGNAT and similar ranges are not public. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.process(address).range() === "unicast";
}

class NonPublicHostError extends Error {
  constructor(readonly hostname: string) {
    super(`${hostname} does not resolve to a public address`);
    this.name = "NonPublicHostError";
  }
}

// 连接时检查 DNS 解析出的全部地址，任何一个不是公网地址就拒绝连接，连接使用的正是检查过的地址。
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address))) {
      return callback(new NonPublicHostError(hostname), "", 0);
    }
    if (options.all) return callback(null, addresses);
    const [first] = addresses as [LookupAddress];
    return callback(null, first.address, first.family);
  });
};

const publicAgent = new Agent({ connect: { lookup: publicLookup } });

function assertPublicUrl(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GenerationValidationError(`Media URL must use http or https: ${url.protocol}`);
  }
  // 地址直接写成 IP 时不会经过 DNS 解析，连接前单独检查
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new GenerationValidationError(`Media URL must point to a public host: ${url.hostname}`);
  }
}

function nonPublicHost(error: unknown): NonPublicHostError | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof NonPublicHostError) return current;
  }
  return undefined;
}

/**
 * Fetches reference media from public hosts only. Every hop of a redirect chain is checked, and connections use the
 * DNS answer that passed the check.
 */
export const publicMediaFetch: GenerationMediaFetch = async (rawUrl, init) => {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertPublicUrl(url);
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(url, { ...init, redirect: "manual", dispatcher: publicAgent });
    } catch (error) {
      const blocked = nonPublicHost(error);
      if (blocked) throw new GenerationValidationError(`Media URL must point to a public host: ${blocked.hostname}`);
      throw error;
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new GenerationValidationError(`Media URL redirects more than ${MAX_REDIRECTS} times: ${rawUrl}`);
};
