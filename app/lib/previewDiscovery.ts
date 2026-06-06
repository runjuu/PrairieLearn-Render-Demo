import fs from 'node:fs/promises';
import path from 'node:path';

export interface PreviewQuestion {
  previewUrl: string;
  qid: string;
  title: string;
  topic: string | null;
  type: string | null;
}

interface PreviewServerEnv {
  [key: string]: string | undefined;
  PL_PREVIEW_COURSE_DIR?: string;
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

export function previewCourseDirFromEnv(env: PreviewServerEnv = process.env): string {
  const rawDir = env.PL_PREVIEW_COURSE_DIR?.trim() || path.join(process.cwd(), 'demo-course');
  return path.resolve(rawDir);
}

function previewUrlForQid(qid: string): string {
  return `/questions/${qid.split('/').map(encodeURIComponent).join('/')}?variant=1`;
}

export function isPreviewableQid(qid: string): boolean {
  const segments = qid.split('/');
  return (
    qid.length > 0 &&
    !qid.startsWith('/') &&
    !qid.includes('\\') &&
    !qid.includes('\0') &&
    !path.isAbsolute(qid) &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('/') &&
        !segment.includes('\\') &&
        !segment.includes('\0') &&
        !path.isAbsolute(segment),
    )
  );
}

function previewQuestionFromInfo(qid: string, info: Record<string, unknown>): PreviewQuestion {
  return {
    previewUrl: previewUrlForQid(qid),
    qid,
    title: typeof info.title === 'string' ? info.title : qid,
    topic: typeof info.topic === 'string' ? info.topic : null,
    type: typeof info.type === 'string' ? info.type : null,
  };
}

function invalidPreviewQuestion(qid: string): PreviewQuestion {
  return {
    previewUrl: previewUrlForQid(qid),
    qid,
    title: qid,
    topic: null,
    type: 'invalid-info-json',
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

async function discoverInfoDirs(rootDirectory: string, infoFile: string): Promise<string[]> {
  const results: string[] = [];

  async function readDirectoryEntries(directory: string) {
    try {
      return await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
      throw error;
    }
  }

  async function walk(relativeDir: string): Promise<void> {
    const entries = await readDirectoryEntries(path.join(rootDirectory, relativeDir));

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const subdirPath = path.join(relativeDir, entry.name);
          const infoPath = path.join(rootDirectory, subdirPath, infoFile);
          if (await pathExists(infoPath)) {
            results.push(subdirPath);
          } else {
            await walk(subdirPath);
          }
        }),
    );
  }

  await walk('');
  return results.sort();
}

async function readPreviewQuestion(questionsRoot: string, qidPath: string): Promise<PreviewQuestion> {
  const qid = qidPath.split(path.sep).join('/');
  const infoPath = path.join(questionsRoot, qidPath, 'info.json');

  try {
    const info = JSON.parse(await fs.readFile(infoPath, 'utf8')) as unknown;
    if (typeof info !== 'object' || info === null || Array.isArray(info)) {
      return invalidPreviewQuestion(qid);
    }
    return previewQuestionFromInfo(qid, info as Record<string, unknown>);
  } catch {
    return invalidPreviewQuestion(qid);
  }
}

export async function discoverPreviewQuestions(
  courseDir = previewCourseDirFromEnv(),
): Promise<PreviewQuestion[]> {
  const questionsRoot = path.join(courseDir, 'questions');
  const qidPaths = await discoverInfoDirs(questionsRoot, 'info.json');
  const questions = await Promise.all(
    qidPaths
      .filter((qidPath) => isPreviewableQid(qidPath.split(path.sep).join('/')))
      .map((qidPath) => readPreviewQuestion(questionsRoot, qidPath)),
  );
  return questions.sort((a, b) => a.qid.localeCompare(b.qid));
}
