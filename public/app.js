const state = {
  currentQuestion: null,
  questions: [],
  variantSeed: '1',
};

const el = {
  backButton: document.querySelector('#backButton'),
  diagnostics: document.querySelector('#diagnostics'),
  listView: document.querySelector('#listView'),
  previewActions: document.querySelector('#previewActions'),
  previewFrame: document.querySelector('#previewFrame'),
  previewView: document.querySelector('#previewView'),
  questionList: document.querySelector('#questionList'),
  questionPath: document.querySelector('#questionPath'),
  questionTitle: document.querySelector('#questionTitle'),
  status: document.querySelector('#status'),
  variantButton: document.querySelector('#variantButton'),
  variantLabel: document.querySelector('#variantLabel'),
};

function setStatus(value) {
  el.status.textContent = value;
}

function setDiagnostics(items) {
  const diagnostics = items ?? [];
  if (diagnostics.length === 0) {
    el.diagnostics.classList.add('hidden');
    el.diagnostics.textContent = '';
    return;
  }

  el.diagnostics.textContent = diagnostics
    .map((item) => `${item.name ?? item.code ?? 'diagnostic'}: ${item.message ?? String(item)}`)
    .join('\n');
  el.diagnostics.classList.remove('hidden');
}

async function api(path, init) {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? body.diagnostics?.[0]?.message ?? `HTTP ${response.status}`);
  }
  return body;
}

function randomBase36Seed() {
  return Math.floor(Math.random() * 0xffffffff).toString(36);
}

function showList() {
  state.currentQuestion = null;
  el.previewFrame.removeAttribute('src');
  el.previewActions.classList.add('hidden');
  el.previewActions.classList.remove('flex');
  el.previewView.classList.add('hidden');
  el.listView.classList.remove('hidden');
  setDiagnostics([]);
  setStatus('Ready');
}

function showPreview(question) {
  state.currentQuestion = question;
  el.questionTitle.textContent = question.title;
  el.questionPath.textContent = question.qid;
  el.variantLabel.textContent = `seed ${state.variantSeed}`;
  el.listView.classList.add('hidden');
  el.previewView.classList.remove('hidden');
  el.previewActions.classList.remove('hidden');
  el.previewActions.classList.add('flex');
}

function renderQuestions() {
  const buttons = state.questions.map((question) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'grid w-full gap-1 bg-white px-4 py-3 text-left hover:bg-panel focus:outline-none focus:ring-2 focus:ring-emerald-700';

    const title = document.createElement('span');
    title.className = 'text-sm font-semibold text-ink';
    title.textContent = question.title;

    const meta = document.createElement('span');
    meta.className = 'text-xs text-muted';
    meta.textContent = question.qid;

    button.append(title, meta);
    button.addEventListener('click', () => {
      state.variantSeed = '1';
      showPreview(question);
      renderPreview();
    });
    return button;
  });

  el.questionList.replaceChildren(...buttons);
}

async function loadQuestions() {
  setStatus('Loading questions');
  const body = await api('/api/questions');
  state.questions = body.questions;
  renderQuestions();
  setStatus('Ready');
}

async function renderPreview() {
  if (!state.currentQuestion) return;

  setStatus('Rendering preview');
  el.variantButton.disabled = true;
  setDiagnostics([]);

  try {
    const body = await api('/api/preview', {
      body: JSON.stringify({
        qid: state.currentQuestion.qid,
        variantSeed: state.variantSeed,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    el.previewFrame.src = body.previewUrl;
    el.variantLabel.textContent = `seed ${body.variant?.seed ?? state.variantSeed}`;
    setDiagnostics(body.diagnostics);
    setStatus('Preview rendered');
  } catch (error) {
    setDiagnostics([{ name: 'PreviewError', message: error.message }]);
    setStatus('Preview failed');
  } finally {
    el.variantButton.disabled = false;
  }
}

el.backButton.addEventListener('click', showList);
el.variantButton.addEventListener('click', () => {
  state.variantSeed = randomBase36Seed();
  renderPreview();
});

loadQuestions().catch((error) => {
  setStatus('Startup failed');
  setDiagnostics([{ name: 'StartupError', message: error.message }]);
});
