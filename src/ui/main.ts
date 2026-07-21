// Painel de conexão do OBS Studio, construído com o UI kit compartilhado do SDK
// (mesmo visual dos demais plugins). Toda ação privilegiada (WebSocket) roda na
// thread de lógica (code.ts); aqui só trocamos mensagens via o bridge do SDK.
import { postMessage, onMessage } from '@spresenter/plugin-sdk/ui';
import {
  injectStyles,
  Root,
  Header,
  Panel,
  Row,
  Field,
  TextInput,
  Checkbox,
  Button,
  Actions,
  StatusIndicator,
  type StatusState,
} from '@spresenter/plugin-sdk/ui-kit';

injectStyles();

type ObsStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface ObsSettings {
  host?: string;
  port?: number;
  autoConnect?: boolean;
  hasPassword?: boolean;
}

const LABELS: Record<ObsStatus, string> = {
  disconnected: 'Desconectado',
  connecting: 'Conectando…',
  connected: 'Conectado',
  error: 'Erro',
};

const STATE: Record<ObsStatus, StatusState> = {
  disconnected: 'idle',
  connecting: 'connecting',
  connected: 'ok',
  error: 'error',
};

// --- Controls -------------------------------------------------------------
const host = TextInput({ id: 'host', value: '127.0.0.1' });
const port = TextInput({ id: 'port', type: 'number', value: 4455 });
const password = TextInput({
  id: 'password',
  type: 'password',
  placeholder: '(sem senha)',
});
password.setAttribute('autocomplete', 'off');

let passwordDirty = false;
password.addEventListener('input', () => {
  passwordDirty = true;
});

const autoConnect = Checkbox({
  id: 'autoConnect',
  label: 'Conectar automaticamente ao iniciar',
  checked: true,
});
const autoConnectInput = autoConnect.querySelector<HTMLInputElement>('input')!;

const status = StatusIndicator({ label: '—' });

// --- Layout ---------------------------------------------------------------
document.body.appendChild(
  Root(
    Header({
      title: '🎥 OBS Studio',
      subtitle:
        'Conecte ao servidor obs-websocket (Ferramentas → WebSocket Server) e use os nós "OBS Studio" no editor de automação.',
    }),
    Panel({
      children: [
        status,
        Row(
          Field({ label: 'Host', control: host, grow: 2 }),
          Field({ label: 'Porta', control: port, grow: 1 }),
        ),
        Field({ label: 'Senha', control: password }),
        autoConnect,
        Actions(
          Button({
            id: 'save',
            label: 'Salvar e conectar',
            variant: 'primary',
            onClick: () => {
              postMessage({ type: 'save-settings', settings: collect() });
              passwordDirty = false;
            },
          }),
          Button({
            id: 'connect',
            label: 'Conectar',
            onClick: () => postMessage({ type: 'connect' }),
          }),
          Button({
            id: 'disconnect',
            label: 'Desconectar',
            onClick: () => postMessage({ type: 'disconnect' }),
          }),
        ),
      ],
    }),
  ),
);

// --- State bridge ---------------------------------------------------------
function applySettings(s?: ObsSettings): void {
  if (!s) return;
  host.value = s.host != null ? s.host : '127.0.0.1';
  port.value = String(s.port != null ? s.port : 4455);
  autoConnectInput.checked = s.autoConnect !== false;
  // Não recebemos a senha em texto puro; mostramos um placeholder se houver uma.
  password.placeholder = s.hasPassword ? '•••••••• (definida)' : '(sem senha)';
  if (!passwordDirty) password.value = '';
}

function applyStatus(s?: ObsStatus, detail?: string): void {
  const known = s && s in STATE ? s : undefined;
  status.set({
    state: known ? STATE[known] : 'idle',
    label: known ? LABELS[known] : s || '—',
    detail: detail || '',
  });
}

function collect() {
  return {
    host: host.value.trim(),
    port: Number(port.value) || 4455,
    password: passwordDirty ? password.value : undefined,
    autoConnect: autoConnectInput.checked,
  };
}

onMessage((raw) => {
  const msg = raw as {
    type?: string;
    settings?: ObsSettings;
    status?: ObsStatus;
    detail?: string;
  };
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'settings') {
    applySettings(msg.settings);
    applyStatus(msg.status, msg.detail);
  } else if (msg.type === 'status') {
    applyStatus(msg.status, msg.detail);
  }
});

// Pede o estado atual ao carregar.
postMessage({ type: 'get-settings' });
