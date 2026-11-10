import { env } from './env';

export const ASAAS_USER_AGENT = 'xnamai-club/1.0';
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

type AsaasList<T> = {
  hasMore?: boolean;
  data?: T[];
};

export function asaasConfigured() {
  return env.asaas.apiKey.length > 0;
}

export function asaasBaseUrl() {
  if (env.asaas.apiUrl) return env.asaas.apiUrl.replace(/\/$/, '');
  if (env.asaas.apiKey.startsWith('$aact_hmlg_')) return 'https://api-sandbox.asaas.com/v3';
  return 'https://api.asaas.com/v3';
}

export async function asaasGet<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(path.replace(/^\//, ''), `${asaasBaseUrl()}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      access_token: env.asaas.apiKey,
      'User-Agent': ASAAS_USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const description = await asaasErrorDescription(response);
    throw new Error(`Asaas respondeu ${response.status}: ${description}`);
  }
  return response.json() as Promise<T>;
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

export async function asaasList<T>(path: string, query: Record<string, string> = {}) {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_LIMIT;
    const result = await asaasGet<AsaasList<T>>(path, {
      ...query,
      limit: String(PAGE_LIMIT),
      offset: String(offset),
    });
    const data = Array.isArray(result.data) ? result.data : [];
    rows.push(...data);
    if (!result.hasMore || data.length === 0) break;
  }
  return rows;
}
