'use client';

import { useMemo, useState } from 'react';

import type { PreviewQuestion } from './lib/previewDiscovery.ts';
import {
  appSearchForSelection,
  directPreviewUrlForSelection,
  type PreviewSelection,
  randomBase36Variant,
} from './lib/previewUrlState.ts';

interface PreviewSelectorProps {
  discoveryError: string | null;
  initialSelection: PreviewSelection;
  previewServerUrl: string;
  questions: PreviewQuestion[];
}

function displayMeta(question: PreviewQuestion) {
  return [question.topic, question.type].filter(Boolean).join(' · ');
}

function replaceSelectionUrl(qid: string, variant: string) {
  const nextSearch = appSearchForSelection({
    existingSearch: window.location.search,
    qid,
    variant,
  });
  window.history.replaceState(null, '', `${window.location.pathname}${nextSearch}`);
}

export function PreviewSelector({
  discoveryError,
  initialSelection,
  previewServerUrl,
  questions,
}: PreviewSelectorProps) {
  const [filter, setFilter] = useState('');
  const [selection, setSelection] = useState(() => initialSelection);
  const [refreshKey, setRefreshKey] = useState(0);

  const filteredQuestions = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return questions;
    return questions.filter((question) =>
      [question.title, question.qid, question.topic, question.type]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [filter, questions]);

  const selectedQuestion = questions.find((question) => question.qid === selection.qid) ?? null;
  const previewUrl = selectedQuestion
    ? directPreviewUrlForSelection({
        previewServerUrl,
        previewUrl: selectedQuestion.previewUrl,
        variant: selection.variant,
      })
    : '';

  function selectQuestion(qid: string) {
    const variant = '1';
    setSelection({ qid, variant });
    setRefreshKey((current) => current + 1);
    replaceSelectionUrl(qid, variant);
  }

  function newVariant() {
    if (!selectedQuestion) return;
    const variant = randomBase36Variant();
    setSelection({ qid: selectedQuestion.qid, variant });
    setRefreshKey((current) => current + 1);
    replaceSelectionUrl(selectedQuestion.qid, variant);
  }

  return (
    <main className="app-shell">
      <aside className="question-pane" aria-label="Discovered questions">
        <header className="pane-header">
          <div>
            <h1>PrairieLearn Preview</h1>
            <p>{previewServerUrl}</p>
          </div>
        </header>

        {discoveryError ? (
          <section className="error-panel" role="status">
            <h2>Connection error</h2>
            <p>{discoveryError}</p>
          </section>
        ) : (
          <>
            <label className="search-field">
              <span>Search questions</span>
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
              />
            </label>
            <div className="question-count">
              {filteredQuestions.length} of {questions.length} questions
            </div>
            <div className="question-list">
              {filteredQuestions.map((question) => (
                <button
                  className={question.qid === selectedQuestion?.qid ? 'question-row selected' : 'question-row'}
                  key={question.qid}
                  onClick={() => selectQuestion(question.qid)}
                  type="button"
                >
                  <span className="question-title">{question.title}</span>
                  <span className="question-qid">{question.qid}</span>
                  {displayMeta(question) ? <span className="question-meta">{displayMeta(question)}</span> : null}
                </button>
              ))}
            </div>
          </>
        )}
      </aside>

      <section className="preview-pane" aria-label="Selected Question-Panel Preview">
        <header className="preview-header">
          <div>
            <h2>{selectedQuestion?.title ?? 'No question selected'}</h2>
            <p>{selectedQuestion ? `${selectedQuestion.qid} · variant ${selection.variant}` : 'Selection pending'}</p>
          </div>
          <div className="preview-actions">
            <button disabled={!selectedQuestion} onClick={newVariant} type="button">
              New Variant
            </button>
            <button
              disabled={!selectedQuestion}
              onClick={() => setRefreshKey((current) => current + 1)}
              type="button"
            >
              Refresh
            </button>
          </div>
        </header>

        {selectedQuestion ? (
          <iframe
            key={`${previewUrl}:${refreshKey}`}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin"
            src={previewUrl}
            title="PrairieLearn question preview"
          />
        ) : (
          <div className="empty-preview" />
        )}
      </section>
    </main>
  );
}
