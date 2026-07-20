# Spresenter — OBS Studio plugin

Controls [OBS Studio](https://obsproject.com/) from the Spresenter automation
editor, via [obs-websocket v5](https://github.com/obsproject/obs-websocket).

## Action nodes

All appear in the add-node menu, under the **OBS Studio** category:

| Node | Action |
|------|--------|
| OBS: Cena de programa | Change the active (program) scene (`SetCurrentProgramScene`) |
| OBS: Cena de preview | Set the preview scene (`SetCurrentPreviewScene`) |
| OBS: Disparar transição | Studio-mode transition (`TriggerStudioModeTransition`) |
| OBS: Gravação | Start / stop / toggle recording |
| OBS: Transmissão | Start / stop / toggle streaming |
| OBS: Replay buffer | Start / stop / save / toggle |
| OBS: Visibilidade da fonte | Show / hide / toggle a source in a scene |
| OBS: Mudo da entrada | Mute / unmute / toggle audio |
| OBS: Requisição bruta | Any obs-websocket v5 `requestType` (advanced) |

## Triggers

OBS events become automation triggers (also under **OBS Studio**). Each trigger
node can filter on its payload fields (e.g. only a specific scene):

| Trigger | Payload |
|---------|---------|
| OBS: Cena de programa mudou | `sceneName` |
| OBS: Cena de preview mudou | `sceneName` |
| OBS: Estado da gravação mudou | `active`, `state` |
| OBS: Estado da transmissão mudou | `active`, `state` |
| OBS: Estado do replay buffer mudou | `active`, `state` |

## Usage

1. In OBS: **Tools → WebSocket Server Settings** → enable the server (default
   port `4455`) and optionally set a password.
2. In Spresenter: **Settings → Plugins** → install this plugin (folder or
   `.zip`). Open the **OBS Studio** panel, enter host/port/password → *Save and
   connect*.
3. In the **Automation** editor, add nodes/triggers from the **OBS Studio**
   category.

## Development

```bash
npm install          # uses the SDK packed at sdk/spresenter-plugin-sdk.tgz
npm run build        # produces dist/code.js
npm run package      # produces release/com.spresenter.obs-<version>.zip
```

The SDK (`@spresenter/plugin-sdk`) is consumed as a local tarball at
`sdk/spresenter-plugin-sdk.tgz`. To refresh it, run `npm run build:sdk` in the
main Spresenter repo (or `npm pack` in `packages/plugin-sdk`) and copy the
generated `.tgz` into `sdk/`.

> Requires the `spresenter.net` / `spresenter.crypto` primitives and the
> `net:connect` permission (Spresenter ≥ 0.3.0).
