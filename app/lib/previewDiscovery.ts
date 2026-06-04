export interface PreviewQuestion {
  previewUrl: string;
  qid: string;
  title: string;
  topic: string | null;
  type: string | null;
}

interface PreviewServerEnv {
  [key: string]: string | undefined;
  PL_PREVIEW_SERVER_URL?: string;
}

export function previewServerUrlFromEnv(env: PreviewServerEnv = process.env): string {
  const rawUrl = env.PL_PREVIEW_SERVER_URL?.trim() || 'http://127.0.0.1:4310';
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function previewUrlForQid(qid: string): string {
  return `/questions/${qid.split('/').map(encodeURIComponent).join('/')}?variant=1`;
}

function asQuestion(value: unknown): PreviewQuestion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.qid !== 'string') return null;

  return {
    previewUrl: typeof record.previewUrl === 'string' ? record.previewUrl : previewUrlForQid(record.qid),
    qid: record.qid,
    title: typeof record.title === 'string' ? record.title : record.qid,
    topic: typeof record.topic === 'string' ? record.topic : null,
    type: typeof record.type === 'string' ? record.type : null,
  };
}

export async function discoverPreviewQuestions(previewServerUrl: string): Promise<PreviewQuestion[]> {
  const response = await fetch(new URL('/api/questions', previewServerUrl), {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Question discovery failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as unknown;
  const items =
    Array.isArray(body) ||
    (typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      Array.isArray((body as Record<string, unknown>).questions))
      ? Array.isArray(body)
        ? body
        : ((body as Record<string, unknown>).questions as unknown[])
      : [];

  return items.map(asQuestion).filter((question): question is PreviewQuestion => question !== null);
}
