import type { AskPayload, CellLabel, ClientMessage, Quad, ServerMessage, SessionSnapshot } from '@vistactoe/shared';

const FPS = 5;
const WIDTH = 640;
const HEIGHT = 480;
/** Grace period before a stale cell marker disappears — bridges brief hand occlusions. */
const GEOMETRY_TTL_MS = 1500;
const CLEAR_LOG_KEY = 'vistactoe.clearLogOnNewGame';
const ROTATE_VIEW_KEY = 'vistactoe.rotateView';

const video = document.getElementById('video') as HTMLVideoElement;
const statusEl = document.getElementById('status')!;
const boardEl = document.getElementById('board')!;
const askEl = document.getElementById('ask')!;
const askQuestionEl = document.getElementById('ask-question')!;
const askOptionsEl = document.getElementById('ask-options')!;
const logEl = document.getElementById('log')!;
const newGameBtn = document.getElementById('new-game') as HTMLButtonElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const octx = overlay.getContext('2d')!;
const clearLogCheckbox = document.getElementById('clear-log') as HTMLInputElement;
const rotateViewCheckbox = document.getElementById('rotate-view') as HTMLInputElement;
const cameraFrame = document.querySelector('.camera-frame')!;

const capture = document.createElement('canvas');
capture.width = WIDTH;
capture.height = HEIGHT;
const ctx = capture.getContext('2d', { willReadFrequently: true })!;

const PHASE_TEXT: Record<SessionSnapshot['phase'], string> = {
  no_paper: '📄 Show me the paper',
  no_grid: '✏️ Draw a 3×3 grid',
  human_turn: '🫵 Your turn',
  awaiting_agent_mark: '🤖 Waiting for you to draw my move',
  awaiting_answer: '❓ Please answer the question',
  game_over: '🏁 Game over — fresh grid for another round',
  corrupted: '⚠️ Board unreadable — fresh grid please',
};

let ws: WebSocket;
let snapshot: SessionSnapshot | null = null;
let lastCellQuads: Quad[] | null = null;
let lastCellQuadsAt = 0;
/** Log entries appended since the previous snapshot — spared when a new game clears the log. */
let logSinceSnapshot = 0;

function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.onopen = () => setStatus('connected — waiting for the board');
  ws.onclose = () => {
    setStatus('disconnected — retrying…');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (event) => handleMessage(JSON.parse(event.data as string) as ServerMessage);
}

function send(message: ClientMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'snapshot': {
      const prev = snapshot;
      snapshot = message.snapshot;
      if (clearLogCheckbox.checked && prev && message.snapshot.gameNumber > prev.gameNumber) {
        // Keep the entries logged since the previous snapshot: they are this
        // batch's "New game" announcements, which arrive BEFORE the snapshot
        // that bumps gameNumber. appendLog prepends, so they are the first
        // children — trim everything older from the tail.
        while (logEl.children.length > logSinceSnapshot) logEl.lastChild?.remove();
      }
      logSinceSnapshot = 0;
      renderSnapshot(message.snapshot);
      renderOverlay();
      break;
    }
    case 'say':
      appendLog(message.category, message.text);
      speak(message.text, message.category);
      break;
    case 'ask':
      showAsk(message.ask);
      break;
    case 'geometry':
      if (message.geometry.cellQuads) {
        lastCellQuads = message.geometry.cellQuads;
        lastCellQuadsAt = Date.now();
      }
      renderOverlay();
      break;
  }
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function renderSnapshot(snap: SessionSnapshot): void {
  setStatus(PHASE_TEXT[snap.phase]);
  boardEl.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const value = snap.board[i];
    cell.textContent = value ?? '';
    if (value) cell.classList.add(value === snap.humanSymbol ? 'human' : 'agent');
    if (snap.pendingAgentCell === i) {
      cell.classList.add('pending');
      cell.textContent = snap.agentSymbol;
    }
    boardEl.appendChild(cell);
  }
  if (snap.phase !== 'awaiting_answer') askEl.classList.add('hidden');
}

function appendLog(category: string, text: string): void {
  const item = document.createElement('li');
  item.className = `cat-${category}`;
  item.textContent = text;
  logEl.prepend(item);
  logSinceSnapshot++;
  while (logEl.children.length > 30) logEl.lastChild?.remove();
}

/** Camera-feed overlay: paper placement guide, or the cell awaiting the agent's mark. */
function renderOverlay(): void {
  octx.clearRect(0, 0, WIDTH, HEIGHT);
  if (!snapshot) return;
  if (snapshot.phase === 'no_paper') {
    // Static placement guide — generously above the detector's minimum paper area.
    octx.strokeStyle = '#4da3ff';
    octx.lineWidth = 3;
    octx.setLineDash([12, 8]);
    octx.strokeRect(WIDTH * 0.175, HEIGHT * 0.175, WIDTH * 0.65, HEIGHT * 0.65);
    octx.setLineDash([]);
    return;
  }
  const cell = snapshot.pendingAgentCell;
  if (cell === null || !lastCellQuads || Date.now() - lastCellQuadsAt > GEOMETRY_TTL_MS) return;
  const q = lastCellQuads[cell]!;
  octx.beginPath();
  octx.moveTo(q[0].x, q[0].y);
  for (const p of [q[1], q[2], q[3]]) octx.lineTo(p.x, p.y);
  octx.closePath();
  octx.fillStyle = 'rgba(255, 61, 61, 0.25)';
  octx.fill();
  octx.strokeStyle = '#ff3d3d';
  octx.lineWidth = 3;
  octx.stroke();
}

// Chrome kills in-flight speech whose utterance gets garbage-collected, and
// silently drops a speak() issued in the same tick as cancel() — both wedge
// the queue after a few utterances. Hold a reference and defer the speak.
let currentUtterance: SpeechSynthesisUtterance | null = null;
// After a (re)load Chrome mutes speech until the page is touched; hold the
// last blocked line and replay it on the first gesture.
let pendingSpeech: string | null = null;

function speak(text: string, category: string, retry = false): void {
  if (category === 'info') return;
  // Prompts repeat and stack — keep only the freshest utterance.
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  let started = false;
  utterance.onstart = () => {
    started = true;
  };
  utterance.onend = () => {
    if (currentUtterance === utterance) currentUtterance = null;
  };
  utterance.onerror = (event) => {
    if (currentUtterance === utterance) currentUtterance = null;
    if (event.error === 'interrupted' || event.error === 'canceled') return; // superseded — expected
    if (event.error === 'not-allowed') {
      pendingSpeech = text;
      appendLog('warning', '🔇 voice blocked by the browser — click anywhere once to enable');
    } else {
      appendLog('warning', `🔇 speech failed: ${event.error}`);
    }
  };
  currentUtterance = utterance;
  setTimeout(() => {
    if (currentUtterance !== utterance) return; // a fresher say superseded this one
    // Only when actually paused — resume() on an idle engine mutes macOS Chrome.
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.speak(utterance);
    // Watchdog: no start and no error either — the engine ate it silently.
    setTimeout(() => {
      if (started || currentUtterance !== utterance) return;
      appendLog(
        'warning',
        `🔇 speech stuck (speaking=${speechSynthesis.speaking} paused=${speechSynthesis.paused} pending=${speechSynthesis.pending} voices=${speechSynthesis.getVoices().length})${retry ? ' — restart the browser to reset its speech engine' : ', resetting…'}`,
      );
      speechSynthesis.cancel();
      if (!retry) speak(text, category, true);
    }, 2500);
  }, 60);
}

window.addEventListener('pointerdown', () => {
  if (!pendingSpeech) return;
  const text = pendingSpeech;
  pendingSpeech = null;
  speak(text, 'replay');
});

function showAsk(ask: AskPayload): void {
  askQuestionEl.textContent = ask.question;
  askOptionsEl.innerHTML = '';
  for (const option of ask.options) {
    const button = document.createElement('button');
    button.textContent = option === 'empty' ? 'Nothing' : option;
    button.onclick = () => {
      send({ type: 'answer', askId: ask.id, label: option as CellLabel });
      askEl.classList.add('hidden');
    };
    askOptionsEl.appendChild(button);
  }
  askEl.classList.remove('hidden');
}

newGameBtn.onclick = () => send({ type: 'control', action: 'new_game' });

// Absent key = checked, so the default is a tidy log.
clearLogCheckbox.checked = localStorage.getItem(CLEAR_LOG_KEY) !== 'false';
clearLogCheckbox.onchange = () => localStorage.setItem(CLEAR_LOG_KEY, String(clearLogCheckbox.checked));

// For players sitting opposite the camera. Display-only: video + overlay
// rotate as one (alignment preserved) and the board widget follows; the
// frames sent to the server are untouched.
function applyRotation(): void {
  cameraFrame.classList.toggle('rotated', rotateViewCheckbox.checked);
  boardEl.classList.toggle('rotated', rotateViewCheckbox.checked);
}
rotateViewCheckbox.checked = localStorage.getItem(ROTATE_VIEW_KEY) === 'true';
rotateViewCheckbox.onchange = () => {
  localStorage.setItem(ROTATE_VIEW_KEY, String(rotateViewCheckbox.checked));
  applyRotation();
};
applyRotation();

async function startCamera(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: WIDTH }, height: { ideal: HEIGHT }, facingMode: 'environment' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  setInterval(() => {
    // The steady clock that expires the marker TTL even when the socket goes quiet.
    renderOverlay();
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_000_000) return;
    ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);
    const dataUrl = capture.toDataURL('image/jpeg', 0.7);
    send({ type: 'frame', jpegBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), capturedAt: Date.now() });
  }, 1000 / FPS);
}

connect();
startCamera().catch((err: unknown) => {
  setStatus(`camera error: ${err instanceof Error ? err.message : String(err)}`);
});
