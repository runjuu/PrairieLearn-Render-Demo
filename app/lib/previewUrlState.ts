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
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  const value = bytes[0] * 0x100000000 + bytes[1];
  return value.toString(36);
}
