export interface PreviewSelection {
  qid: string;
  variant: string;
}

type PreviewSearchParams = Record<string, string | string[] | undefined>;

function firstSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function previewSelectionFromSearchParams({
  questions,
  searchParams,
}: {
  questions: Array<{ qid: string }>;
  searchParams: PreviewSearchParams;
}): PreviewSelection {
  const qid = firstSearchParam(searchParams.qid) ?? '';
  const variant = firstSearchParam(searchParams.variant) || '1';

  if (!questions.some((question) => question.qid === qid)) return { qid: '', variant: '1' };
  return { qid, variant };
}

export function directPreviewUrlForSelection({
  previewServerUrl,
  previewUrl,
  variant,
}: {
  previewServerUrl: string;
  previewUrl: string;
  variant: string;
}): string {
  const url = new URL(previewUrl, previewServerUrl);
  url.searchParams.set('variant', variant);
  return url.toString();
}

export function appSearchForSelection({
  existingSearch,
  qid,
  variant,
}: {
  existingSearch: string;
  qid: string;
  variant: string;
}): string {
  const params = new URLSearchParams(existingSearch);
  params.set('qid', qid);
  params.set('variant', variant);
  const next = params.toString();
  return next ? `?${next}` : '';
}

export function randomBase36Variant(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  const value = bytes[0] === 0 ? 1 : bytes[0];
  return value.toString(36);
}
