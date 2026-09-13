import type { AskPayload, CellLabel, ClientMessage, ServerMessage, SessionSnapshot } from '@vistactoe/shared';

const FPS = 5;
const WIDTH = 640;
const HEIGHT = 480;

const video = document.getElementById('video') as HTMLVideoElement;
const statusEl = document.getElementById('status')!;
const boardEl = document.getElementById('board')!;
const askEl = document.getElementById('ask')!;
const askQuestionEl = document.getElementById('ask-question')!;
const askOptionsEl = document.getElementById('ask-options')!;
const logEl = document.getElementById('log')!;
const newGameBtn = document.getElementById('new-game') as HTMLButtonElement;

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
    case 'snapshot':
      snapshot = message.snapshot;
      renderSnapshot(message.snapshot);
      break;
    case 'say':
      appendLog(message.category, message.text);
      speak(message.text, message.category);
      break;
    case 'ask':
      showAsk(message.ask);
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
  while (logEl.children.length > 30) logEl.lastChild?.remove();
}

function speak(text: string, category: string): void {
  if (category === 'info') return;
  // Prompts repeat and stack — keep only the freshest utterance.
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  speechSynthesis.speak(utterance);
}

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

async function startCamera(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: WIDTH }, height: { ideal: HEIGHT }, facingMode: 'environment' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  setInterval(() => {
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
