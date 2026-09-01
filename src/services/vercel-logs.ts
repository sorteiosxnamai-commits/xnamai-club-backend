type VercelDeployment = {
  uid: string;
  name?: string;
  url?: string;
  state?: string;
  readyState?: string;
  target?: string | null;
  createdAt?: number;
  ready?: number;
};

export type VercelLogEntry = {
  id: string;
  at: string;
  level: string;
  source: string;
  message: string;
};

export type VercelLogsPayload = {
  configured: boolean;
  message?: string;
  project: {
    id: string;
    name: string;
    teamId: string | null;
  };
  deployment: {
    id: string;
    url: string | null;
    state: string;
    target: string | null;
    createdAt: string | null;
  } | null;
  logs: VercelLogEntry[];
};

type VercelConfig = {
  token: string;
  projectId: string;
  projectName: string;
  teamId: string | null;
};

function readConfig(): VercelConfig | null {
  const token = process.env.VERCEL_TOKEN?.trim();
  if (!token) return null;
  return {
    token,
    projectId: (process.env.VERCEL_FRONTEND_PROJECT_ID || process.env.VERCEL_PROJECT_ID || '').trim(),
    projectName: (process.env.VERCEL_FRONTEND_PROJECT_NAME || 'xnamai-club-frontend').trim(),
    teamId: (process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID || '').trim() || null,
  };
}

function teamQuery(teamId: string | null) {
  return teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
}

async function vercelFetch<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 280);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message || parsed.message || detail;
    } catch {
      // keep raw body
    }
    throw new Error(detail || `Vercel API ${response.status}`);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return parseNdjson(text) as T;
  }
}

function parseNdjson(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function resolveProject(config: VercelConfig) {
  if (config.projectId) {
    return { id: config.projectId, name: config.projectName };
  }

  const search = encodeURIComponent(config.projectName);
  const data = await vercelFetch<{ projects?: Array<{ id: string; name: string }> }>(
    `/v9/projects?search=${search}&limit=10${teamQuery(config.teamId)}`,
    config.token,
  );
  const match = (data.projects || []).find((project) => project.name === config.projectName)
    || (data.projects || [])[0];
  if (!match) {
    throw new Error(`Projeto Vercel "${config.projectName}" n?o encontrado. Defina VERCEL_FRONTEND_PROJECT_ID.`);
  }
  return { id: match.id, name: match.name };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickTime(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value > 1e12 ? value : value * 1000).toISOString();
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function normalizeLog(raw: unknown, index: number): VercelLogEntry | null {
  const event = asRecord(raw);
  const payload = asRecord(event.payload);
  const info = asRecord(payload.info);
  const message = pickString(
    event.text,
    event.message,
    payload.text,
    payload.message,
    typeof payload.data === 'string' ? payload.data : '',
    info.name,
    event.type,
  );
  if (!message) return null;
  const level = pickString(event.level, event.serial, payload.level, event.type, 'info').toLowerCase();
  return {
    id: pickString(event.id, payload.id, String(index)),
    at: pickTime(event.timestamp, event.date, event.created, payload.date, payload.created),
    level: level.includes('error') || level === 'stderr' ? 'error' : level.includes('warn') ? 'warn' : 'info',
    source: pickString(event.source, payload.source, info.type, event.type, 'vercel'),
    message,
  };
}

export async function fetchFrontendVercelLogs(limit = 150): Promise<VercelLogsPayload> {
  const config = readConfig();
  if (!config) {
    return {
      configured: false,
      message: 'Defina VERCEL_TOKEN no backend (e, se poss?vel, VERCEL_FRONTEND_PROJECT_ID e VERCEL_TEAM_ID) para carregar os logs do frontend.',
      project: { id: '', name: 'xnamai-club-frontend', teamId: null },
      deployment: null,
      logs: [],
    };
  }

  const project = await resolveProject(config);
  const deployments = await vercelFetch<{ deployments?: VercelDeployment[] }>(
    `/v6/deployments?projectId=${encodeURIComponent(project.id)}&limit=5${teamQuery(config.teamId)}`,
    config.token,
  );
  const deployment = (deployments.deployments || []).find((item) => item.target === 'production')
    || (deployments.deployments || [])[0]
    || null;

  if (!deployment) {
    return {
      configured: true,
      project: { id: project.id, name: project.name, teamId: config.teamId },
      deployment: null,
      logs: [],
      message: 'Nenhum deploy do frontend foi encontrado neste projeto Vercel.',
    };
  }

  const events = await vercelFetch<unknown>(
    `/v3/deployments/${encodeURIComponent(deployment.uid)}/events?direction=backward&limit=${Math.min(Math.max(limit, 20), 400)}&builds=1${teamQuery(config.teamId)}`,
    config.token,
  );
  const eventList = Array.isArray(events)
    ? events
    : Array.isArray((events as { events?: unknown[] })?.events)
      ? (events as { events: unknown[] }).events
      : null;
  const rows = eventList ?? parseNdjson(typeof events === 'string' ? events : JSON.stringify(events));
  const logs = rows.map(normalizeLog).filter((entry): entry is VercelLogEntry => Boolean(entry)).slice(0, limit);

  return {
    configured: true,
    project: { id: project.id, name: project.name, teamId: config.teamId },
    deployment: {
      id: deployment.uid,
      url: deployment.url ? `https://${deployment.url}` : null,
      state: deployment.readyState || deployment.state || 'UNKNOWN',
      target: deployment.target || null,
      createdAt: deployment.createdAt ? new Date(deployment.createdAt).toISOString() : null,
    },
    logs,
  };
}
