import { PreviewSelector } from './PreviewSelector.tsx';
import {
  discoverPreviewQuestions,
  previewCourseDirFromEnv,
  previewServerUrlFromEnv,
  type PreviewQuestion,
} from './lib/previewDiscovery.ts';
import { previewSelectionFromSearchParams } from './lib/previewUrlState.ts';

export const dynamic = 'force-dynamic';

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Page({ searchParams }: { searchParams?: PageSearchParams }) {
  const previewCourseDir = previewCourseDirFromEnv();
  const previewServerUrl = previewServerUrlFromEnv();
  let questions: PreviewQuestion[] = [];
  let discoveryError: string | null = null;

  try {
    questions = await discoverPreviewQuestions(previewCourseDir);
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
  }

  const initialSelection = previewSelectionFromSearchParams({
    questions,
    searchParams: (await searchParams) ?? {},
  });

  return (
    <PreviewSelector
      discoveryError={discoveryError}
      initialSelection={initialSelection}
      previewServerUrl={previewServerUrl}
      questions={questions}
    />
  );
}
