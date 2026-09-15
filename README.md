# Open WebUI fork

Fork of [open-webui/open-webui](https://github.com/open-webui/open-webui). Upstream install and docs still apply. This repo only adds the following.

## Gallery

`/gallery` (sidebar: **Gallery**). `/graph` redirects here.

A hallway of dated day bays. Conversation prints hang on the walls. Photos from those chats cluster around them. Click a print to open the thread. Walk, look around, fly to a photo.

- Calendar stick in the corner scrubs time (camera depth follows photo dates).
- Mic menu attaches a folder onto the walls. Detach leaves the files on disk.
- `/gallery?chat=<id>` and the wall QR are the same link for a phone on the LAN.
- Voice stays on the gallery. Captions live in the overlay.

## Local HTTPS

```bash
./start-all.sh
```

llama-server (`:8082`), backend (`:8080`), Vite at `https://localhost:5173`. On a phone, use the machine's LAN IP through `:5173`, not `:8080`.

```bash
./start-all.sh --background
./stop-all.sh
```

## Type

Inter for UI, Fraunces for titles, JetBrains Mono for code and gallery meta.

## Upstream

Everything else is Open WebUI. See [docs.openwebui.com](https://docs.openwebui.com).
