import { PreviewSelector } from './PreviewSelector.tsx';
import {
  discoverPreviewQuestions,
  previewServerUrlFromEnv,
  type PreviewQuestion,
} from './lib/previewDiscovery.ts';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const previewServerUrl = previewServerUrlFromEnv();
  let questions: PreviewQuestion[] = [];
  let discoveryError: string | null = null;

  try {
    questions = await discoverPreviewQuestions(previewServerUrl);
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
  }

  return (
    <PreviewSelector
      discoveryError={discoveryError}
      previewServerUrl={previewServerUrl}
      questions={questions}
    />
  );
}
