import { pixTironiTechAsaas } from './club-pricing';
import { env } from './env';

export const ASAAS_USER_AGENT = 'xnamai-club/1.0';
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

type AsaasList<T> = {
  hasMore?: boolean;
  data?: T[];
};

export function asaasAccountKeys() {
  const keys = [env.asaas.apiKey];
  if (pixTironiTechAsaas() && env.asaas.tironiTechApiKey && env.asaas.tironiTechApiKey !== env.asaas.apiKey) {
    keys.push(env.asaas.tironiTechApiKey);
  }
  return keys.filter((key) => key.length > 0);
}

export function asaasConfigured() {
  return asaasAccountKeys().length > 0;
}

export function asaasBaseUrl(apiKey = env.asaas.apiKey) {
  if (env.asaas.apiUrl) return env.asaas.apiUrl.replace(/\/$/, '');
  if (apiKey.startsWith('$aact_hmlg_')) return 'https://api-sandbox.asaas.com/v3';
  return 'https://api.asaas.com/v3';
}

async function asaasFetch<T>(method: 'GET' | 'POST' | 'DELETE', path: string, query: Record<string, string>, body: unknown, apiKey: string): Promise<T> {
  const url = new URL(path.replace(/^\//, ''), `${asaasBaseUrl(apiKey)}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: {
      access_token: apiKey,
      'User-Agent': ASAAS_USER_AGENT,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const description = await asaasErrorDescription(response);
    throw new Error(`Asaas respondeu ${response.status}: ${description}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function asaasGet<T>(path: string, query: Record<string, string> = {}, apiKey = env.asaas.apiKey) {
  return asaasFetch<T>('GET', path, query, undefined, apiKey);
}

export function asaasPost<T>(path: string, body: unknown, apiKey = env.asaas.apiKey) {
  return asaasFetch<T>('POST', path, {}, body, apiKey);
}

export function asaasDelete(path: string, apiKey = env.asaas.apiKey) {
  return asaasFetch<void>('DELETE', path, {}, undefined, apiKey);
}

async function asaasErrorDescription(response: Response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ description?: string }> };
    const descriptions = parsed.errors?.map((error) => error.description).filter(Boolean) ?? [];
    if (descriptions.length > 0) return descriptions.join('; ');
  } catch {
    // The body is not the documented errors array.
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300) || response.statusText;
}

export async function asaasList<T>(path: string, query: Record<string, string> = {}, apiKey = env.asaas.apiKey) {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_LIMIT;
    const result = await asaasGet<AsaasList<T>>(path, {
      ...query,
      limit: String(PAGE_LIMIT),
      offset: String(offset),
    }, apiKey);
    const data = Array.isArray(result.data) ? result.data : [];
    rows.push(...data);
    if (!result.hasMore || data.length === 0) break;
  }
  return rows;
}
