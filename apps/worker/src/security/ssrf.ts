import dns from 'node:dns/promises';
import net from 'node:net';
import { isDisallowedHostLiteral } from '@musicflow/shared';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export function isPrivateOrReservedIp(ipRaw: string): boolean {
  const ip = ipRaw.trim().toLowerCase();
  if (!net.isIP(ip)) return true;

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) {
      return isPrivateOrReservedIpv4(mapped);
    }
  }

  if (net.isIPv4(ip)) {
    return isPrivateOrReservedIpv4(ip);
  }

  return isPrivateOrReservedIpv6(ip);
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;

  if (a === 0) return true; // "This" network 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // Loopback
  if (a === 169 && b === 254) return true; // Link-local / Cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC6598
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // Multicast & Reserved

  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
    return true; // Link-local fe80::/10
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) {
    return true; // Unique local fc00::/7
  }
  if (ip.startsWith('ff')) {
    return true; // Multicast ff00::/8
  }
  return false;
}

export async function validateOutboundUrl(
  rawUrl: string,
  options: { allowPrivateNetworkFetch?: boolean; allowedHosts?: Set<string> } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('URL inválida.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('Protocolo não permitido. Apenas HTTP e HTTPS são aceitos.');
  }

  if (url.username || url.password) {
    throw new SsrfBlockedError('URLs com credenciais embutidas não são permitidas.');
  }

  const hostname = url.hostname.toLowerCase();
  if (options.allowedHosts && !options.allowedHosts.has(hostname)) {
    throw new SsrfBlockedError(`Host não permitido para esta operação: ${hostname}`);
  }

  if (options.allowPrivateNetworkFetch) {
    return url;
  }

  if (isDisallowedHostLiteral(hostname)) {
    throw new SsrfBlockedError('Acesso a endereços locais ou privados bloqueado por segurança (SSRF).');
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new SsrfBlockedError('Endereço IP reservado ou privado bloqueado (SSRF).');
    }
    return url;
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await dns.lookup(hostname, { all: true });
  } catch {
    throw new SsrfBlockedError(`Não foi possível resolver o host ${hostname}.`);
  }

  if (!resolved.length) {
    throw new SsrfBlockedError(`Nenhum endereço DNS retornado para ${hostname}.`);
  }

  for (const entry of resolved) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new SsrfBlockedError(
        `Host ${hostname} resolveu para IP privado/reservado (${entry.address}) e foi bloqueado.`,
      );
    }
  }

  return url;
}

export interface SafeFetchOptions extends RequestInit {
  allowPrivateNetworkFetch?: boolean;
  allowedHosts?: Set<string>;
  maxRedirects?: number;
  timeoutMs?: number;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<Response> {
  const {
    allowPrivateNetworkFetch = false,
    allowedHosts,
    maxRedirects = 5,
    timeoutMs = 15_000,
    ...fetchInit
  } = options;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await validateOutboundUrl(currentUrl, {
      allowPrivateNetworkFetch,
      allowedHosts,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = fetchInit.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(validated.toString(), {
        ...fetchInit,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      const nextUrl = new URL(location, validated).toString();
      currentUrl = nextUrl;
      continue;
    }

    return response;
  }

  throw new SsrfBlockedError('Número máximo de redirecionamentos excedido.');
}
