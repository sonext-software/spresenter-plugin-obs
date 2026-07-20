// OBS Studio plugin — logic thread (headless, background:true).
//
// Talks to OBS through the obs-websocket v5 API using the SDK's generic
// primitives: `spresenter.net` (WebSocket; the host owns the socket) and
// `spresenter.crypto.sha256Base64` (auth handshake). It registers an
// "OBS Studio" category plus action nodes AND triggers in the automation editor.
//
// The connection is single and persistent: action nodes just send requests over
// the already-open connection, and OBS events are turned into triggers.
// Connection config (host/port/password) comes from the UI panel and is
// persisted via `spresenter.storage`.
//
// NOTE: user-facing strings (node/trigger names, labels, hints) are kept in
// pt-BR to match the app's UI; code comments are in English.

interface ObsSettings {
  host: string;
  port: number;
  password: string;
  autoConnect: boolean;
}

const DEFAULTS: ObsSettings = {
  host: '127.0.0.1',
  port: 4455,
  password: '',
  autoConnect: true,
};

type ConnState = 'disconnected' | 'connecting' | 'connected' | 'error';

let settings: ObsSettings = { ...DEFAULTS };
let connId: string | null = null;
let identified = false;
let connecting = false;
let closedByUs = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let state: ConnState = 'disconnected';
let lastError = '';

let reqSeq = 0;
const pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

const REQUEST_TIMEOUT_MS = 10_000;
const CONNECT_WAIT_MS = 8_000;
const RECONNECT_DELAY_MS = 5_000;

// ── State / UI ───────────────────────────────────────────────────────────────

function setState(next: ConnState, detail = '') {
  state = next;
  if (next === 'error') lastError = detail;
  spresenter.ui.postMessage({ type: 'status', status: next, detail: detail || lastError });
}

function pushSettings() {
  // Never return the plaintext password to the UI; only signal whether one is set.
  spresenter.ui.postMessage({
    type: 'settings',
    settings: { host: settings.host, port: settings.port, hasPassword: !!settings.password, autoConnect: settings.autoConnect },
    status: state,
    detail: lastError,
  });
}

async function loadSettings() {
  const saved = await spresenter.storage.get<Partial<ObsSettings>>('settings');
  if (saved && typeof saved === 'object') settings = { ...DEFAULTS, ...saved };
}

function wsUrl() {
  return `ws://${settings.host}:${settings.port}`;
}

// ── obs-websocket v5 connection ──────────────────────────────────────────────

async function connect() {
  if (connecting || identified) return;
  closedByUs = false;
  connecting = true;
  setState('connecting');

  try {
    connId = await spresenter.net.wsOpen(wsUrl());
  } catch (e) {
    connecting = false;
    setState('error', errMsg(e));
    scheduleReconnect();
    return;
  }

  const id = connId;
  // Registered synchronously right after the await (no frame arrives first).
  spresenter.net.on(id, 'message', (e) => {
    onMessage(e.data).catch((err) => console.error('OBS onMessage:', err));
  });
  spresenter.net.on(id, 'close', () => onClose());
  spresenter.net.on(id, 'error', (e) => setState('error', e.message || 'socket error'));
}

async function onMessage(raw?: string) {
  if (!raw) return;
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.op) {
    case 0: {
      // Hello → Identify (with auth if the server requires a password).
      const d = msg.d || {};
      const identify: any = { rpcVersion: 1 };
      if (d.authentication && d.authentication.challenge && d.authentication.salt) {
        const { challenge, salt } = d.authentication;
        const secret = await spresenter.crypto.sha256Base64(settings.password + salt);
        identify.authentication = await spresenter.crypto.sha256Base64(secret + challenge);
      }
      sendRaw({ op: 1, d: identify });
      return;
    }
    case 2: {
      // Identified.
      identified = true;
      connecting = false;
      setState('connected');
      return;
    }
    case 5: {
      // Event: turn selected OBS events into automation triggers.
      const d = msg.d || {};
      onObsEvent(String(d.eventType ?? ''), d.eventData || {});
      return;
    }
    case 7: {
      // RequestResponse.
      const d = msg.d || {};
      const p = pending.get(d.requestId);
      if (!p) return;
      pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (d.requestStatus && d.requestStatus.result) {
        p.resolve(d.responseData ?? {});
      } else {
        const c = d.requestStatus || {};
        p.reject(new Error(c.comment || `OBS rejected the request (code ${c.code ?? '?'})`));
      }
      return;
    }
    default:
      return;
  }
}

function sendRaw(obj: any) {
  if (!connId) throw new Error('Not connected to OBS.');
  return spresenter.net.wsSend(connId, JSON.stringify(obj));
}

function onClose() {
  identified = false;
  connecting = false;
  connId = null;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('OBS connection was closed.'));
  }
  pending.clear();
  if (state !== 'error') setState('disconnected');
  if (!closedByUs) scheduleReconnect();
}

function scheduleReconnect() {
  if (!settings.autoConnect || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function disconnect() {
  closedByUs = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (connId) spresenter.net.wsClose(connId);
  connId = null;
  identified = false;
  connecting = false;
  setState('disconnected');
}

function waitUntilIdentified(timeoutMs: number): Promise<void> {
  if (identified) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let waited = 0;
    const step = 100;
    const iv = setInterval(() => {
      if (identified) {
        clearInterval(iv);
        resolve();
      } else if ((waited += step) >= timeoutMs) {
        clearInterval(iv);
        reject(new Error(lastError || 'Could not connect to OBS.'));
      }
    }, step);
  });
}

/** Send an obs-websocket request and resolve with its responseData. Connects
 *  on demand if needed. */
async function request(requestType: string, requestData?: any): Promise<any> {
  if (!identified) {
    await connect();
    await waitUntilIdentified(CONNECT_WAIT_MS);
  }
  const requestId = `r${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timed out waiting for "${requestType}" from OBS.`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
    try {
      sendRaw({ op: 6, d: { requestType, requestId, requestData: requestData ?? {} } });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(e as Error);
    }
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── OBS events → automation triggers ─────────────────────────────────────────

// Maps an OBS eventType to a plugin trigger id + a payload projection. Only the
// non-high-volume events we care about; obs-websocket delivers them by default
// (no eventSubscriptions needed in Identify).
const EVENT_MAP: Record<string, { trigger: string; payload: (e: any) => Record<string, unknown> }> = {
  CurrentProgramSceneChanged: { trigger: 'program-scene-changed', payload: (e) => ({ sceneName: e.sceneName }) },
  CurrentPreviewSceneChanged: { trigger: 'preview-scene-changed', payload: (e) => ({ sceneName: e.sceneName }) },
  RecordStateChanged: { trigger: 'record-state-changed', payload: (e) => ({ active: !!e.outputActive, state: e.outputState }) },
  StreamStateChanged: { trigger: 'stream-state-changed', payload: (e) => ({ active: !!e.outputActive, state: e.outputState }) },
  ReplayBufferStateChanged: { trigger: 'replay-buffer-state-changed', payload: (e) => ({ active: !!e.outputActive, state: e.outputState }) },
};

function onObsEvent(eventType: string, eventData: any) {
  const entry = EVENT_MAP[eventType];
  if (!entry) return;
  spresenter.automation.emitTrigger(entry.trigger, entry.payload(eventData));
}

// ── UI bridge (config panel) ─────────────────────────────────────────────────

spresenter.ui.onmessage = async (raw: unknown) => {
  const msg = raw as any;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'get-settings':
      pushSettings();
      return;
    case 'save-settings': {
      const s = msg.settings || {};
      settings = {
        host: String(s.host ?? DEFAULTS.host).trim() || DEFAULTS.host,
        port: Number(s.port) || DEFAULTS.port,
        // Only replace the password when the user typed a new one (non-empty).
        password: typeof s.password === 'string' && s.password.length > 0 ? s.password : settings.password,
        autoConnect: s.autoConnect !== false,
      };
      await spresenter.storage.set('settings', settings);
      disconnect();
      closedByUs = false;
      if (settings.autoConnect) connect();
      pushSettings();
      return;
    }
    case 'connect':
      closedByUs = false;
      connect();
      return;
    case 'disconnect':
      disconnect();
      return;
    default:
      return;
  }
};

// ── Automation triggers ──────────────────────────────────────────────────────

function registerTriggers() {
  spresenter.automation.registerTrigger({
    id: 'program-scene-changed',
    name: 'OBS: Cena de programa mudou',
    description: 'Dispara quando a cena ativa (programa) muda.',
    category: 'obs',
    fields: [{ name: 'sceneName', label: 'Cena', type: 'string' }],
    samplePayload: { sceneName: 'Cena 1' },
  });

  spresenter.automation.registerTrigger({
    id: 'preview-scene-changed',
    name: 'OBS: Cena de preview mudou',
    description: 'Dispara quando a cena de preview (modo estúdio) muda.',
    category: 'obs',
    fields: [{ name: 'sceneName', label: 'Cena', type: 'string' }],
    samplePayload: { sceneName: 'Cena 2' },
  });

  spresenter.automation.registerTrigger({
    id: 'record-state-changed',
    name: 'OBS: Estado da gravação mudou',
    description: 'Dispara ao iniciar/parar a gravação.',
    category: 'obs',
    fields: [
      { name: 'active', label: 'Gravando', type: 'boolean' },
      { name: 'state', label: 'Estado', type: 'string' },
    ],
    samplePayload: { active: true, state: 'OBS_WEBSOCKET_OUTPUT_STARTED' },
  });

  spresenter.automation.registerTrigger({
    id: 'stream-state-changed',
    name: 'OBS: Estado da transmissão mudou',
    description: 'Dispara ao iniciar/parar a transmissão.',
    category: 'obs',
    fields: [
      { name: 'active', label: 'Transmitindo', type: 'boolean' },
      { name: 'state', label: 'Estado', type: 'string' },
    ],
    samplePayload: { active: true, state: 'OBS_WEBSOCKET_OUTPUT_STARTED' },
  });

  spresenter.automation.registerTrigger({
    id: 'replay-buffer-state-changed',
    name: 'OBS: Estado do replay buffer mudou',
    description: 'Dispara ao iniciar/parar o replay buffer.',
    category: 'obs',
    fields: [{ name: 'active', label: 'Ativo', type: 'boolean' }],
    samplePayload: { active: true, state: 'OBS_WEBSOCKET_OUTPUT_STARTED' },
  });
}

// ── Automation action nodes ──────────────────────────────────────────────────

function registerNodes() {
  // Scene / transition ------------------------------------------------------
  spresenter.automation.registerNode({
    id: 'set-program-scene',
    name: 'OBS: Cena de programa',
    description: 'Muda a cena ativa (programa) do OBS.',
    category: 'obs',
    config: {
      sceneName: { type: 'string', label: 'Nome da cena', hint: 'Exatamente como aparece no OBS' },
    },
    execute: async (_p: any, config: any) => {
      await request('SetCurrentProgramScene', { sceneName: String(config?.sceneName ?? '') });
    },
  });

  spresenter.automation.registerNode({
    id: 'set-preview-scene',
    name: 'OBS: Cena de preview',
    description: 'Define a cena de preview (modo estúdio).',
    category: 'obs',
    config: {
      sceneName: { type: 'string', label: 'Nome da cena' },
    },
    execute: async (_p: any, config: any) => {
      await request('SetCurrentPreviewScene', { sceneName: String(config?.sceneName ?? '') });
    },
  });

  spresenter.automation.registerNode({
    id: 'trigger-transition',
    name: 'OBS: Disparar transição',
    description: 'Executa a transição do modo estúdio (preview → programa).',
    category: 'obs',
    execute: async () => {
      await request('TriggerStudioModeTransition', {});
    },
  });

  // Recording / streaming ---------------------------------------------------
  spresenter.automation.registerNode({
    id: 'record',
    name: 'OBS: Gravação',
    description: 'Inicia, para ou alterna a gravação.',
    category: 'obs',
    config: {
      mode: {
        type: 'select',
        label: 'Ação',
        default: 'toggle',
        options: [
          { value: 'start', label: 'Iniciar' },
          { value: 'stop', label: 'Parar' },
          { value: 'toggle', label: 'Alternar' },
        ],
      },
    },
    execute: async (_p: any, config: any) => {
      const map: Record<string, string> = { start: 'StartRecord', stop: 'StopRecord', toggle: 'ToggleRecord' };
      await request(map[String(config?.mode ?? 'toggle')] ?? 'ToggleRecord', {});
    },
  });

  spresenter.automation.registerNode({
    id: 'stream',
    name: 'OBS: Transmissão',
    description: 'Inicia, para ou alterna a transmissão (stream).',
    category: 'obs',
    config: {
      mode: {
        type: 'select',
        label: 'Ação',
        default: 'toggle',
        options: [
          { value: 'start', label: 'Iniciar' },
          { value: 'stop', label: 'Parar' },
          { value: 'toggle', label: 'Alternar' },
        ],
      },
    },
    execute: async (_p: any, config: any) => {
      const map: Record<string, string> = { start: 'StartStream', stop: 'StopStream', toggle: 'ToggleStream' };
      await request(map[String(config?.mode ?? 'toggle')] ?? 'ToggleStream', {});
    },
  });

  spresenter.automation.registerNode({
    id: 'replay-buffer',
    name: 'OBS: Replay buffer',
    description: 'Controla o replay buffer.',
    category: 'obs',
    config: {
      mode: {
        type: 'select',
        label: 'Ação',
        default: 'save',
        options: [
          { value: 'start', label: 'Iniciar' },
          { value: 'stop', label: 'Parar' },
          { value: 'save', label: 'Salvar' },
          { value: 'toggle', label: 'Alternar' },
        ],
      },
    },
    execute: async (_p: any, config: any) => {
      const map: Record<string, string> = {
        start: 'StartReplayBuffer',
        stop: 'StopReplayBuffer',
        save: 'SaveReplayBuffer',
        toggle: 'ToggleReplayBuffer',
      };
      await request(map[String(config?.mode ?? 'save')] ?? 'SaveReplayBuffer', {});
    },
  });

  // Source visibility / mute ------------------------------------------------
  spresenter.automation.registerNode({
    id: 'source-visibility',
    name: 'OBS: Visibilidade da fonte',
    description: 'Mostra, oculta ou alterna uma fonte dentro de uma cena.',
    category: 'obs',
    config: {
      sceneName: { type: 'string', label: 'Cena' },
      sourceName: { type: 'string', label: 'Fonte (nome da fonte na cena)' },
      mode: {
        type: 'select',
        label: 'Ação',
        default: 'toggle',
        options: [
          { value: 'show', label: 'Mostrar' },
          { value: 'hide', label: 'Ocultar' },
          { value: 'toggle', label: 'Alternar' },
        ],
      },
    },
    execute: async (_p: any, config: any) => {
      const sceneName = String(config?.sceneName ?? '');
      const sourceName = String(config?.sourceName ?? '');
      const mode = String(config?.mode ?? 'toggle');
      // Resolve the scene item id from the source name first.
      const { sceneItemId } = await request('GetSceneItemId', { sceneName, sourceName });
      let enabled: boolean;
      if (mode === 'toggle') {
        const cur = await request('GetSceneItemEnabled', { sceneName, sceneItemId });
        enabled = !cur.sceneItemEnabled;
      } else {
        enabled = mode === 'show';
      }
      await request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: enabled });
    },
  });

  spresenter.automation.registerNode({
    id: 'input-mute',
    name: 'OBS: Mudo da entrada',
    description: 'Muta, desmuta ou alterna o mudo de uma entrada de áudio.',
    category: 'obs',
    config: {
      inputName: { type: 'string', label: 'Entrada (nome)' },
      mode: {
        type: 'select',
        label: 'Ação',
        default: 'toggle',
        options: [
          { value: 'mute', label: 'Mutar' },
          { value: 'unmute', label: 'Desmutar' },
          { value: 'toggle', label: 'Alternar' },
        ],
      },
    },
    execute: async (_p: any, config: any) => {
      const inputName = String(config?.inputName ?? '');
      const mode = String(config?.mode ?? 'toggle');
      if (mode === 'toggle') {
        await request('ToggleInputMute', { inputName });
      } else {
        await request('SetInputMute', { inputName, inputMuted: mode === 'mute' });
      }
    },
  });

  // Raw request (advanced) --------------------------------------------------
  spresenter.automation.registerNode({
    id: 'raw-request',
    name: 'OBS: Requisição bruta',
    description: 'Envia qualquer request da API obs-websocket v5.',
    category: 'obs',
    config: {
      requestType: { type: 'string', label: 'requestType', hint: 'Ex.: GetVersion' },
      requestData: { type: 'string', label: 'requestData (JSON)', default: '{}', hint: 'JSON ou vazio' },
    },
    execute: async (_p: any, config: any) => {
      const requestType = String(config?.requestType ?? '').trim();
      if (!requestType) throw new Error('Informe o requestType.');
      let data: any = {};
      const rawData = String(config?.requestData ?? '').trim();
      if (rawData) {
        try {
          data = JSON.parse(rawData);
        } catch {
          throw new Error('requestData não é um JSON válido.');
        }
      }
      await request(requestType, data);
    },
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  await loadSettings();
  spresenter.automation.registerCategory({ key: 'obs', label: 'OBS Studio', icon: 'video' });
  registerTriggers();
  registerNodes();
  if (settings.autoConnect) connect();
  console.log('OBS plugin loaded:', spresenter.manifest.name);
})();
