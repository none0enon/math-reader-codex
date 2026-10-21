# Personal Codex gateway / 个人 Codex 网关

math-reader-codex can use your own ChatGPT subscription for mathematics while keeping Gemini for audio. The gateway runs on your Mac, Linux PC or private Linux server; the BOOX APK and the GitHub Pages PWA keep their existing build and release workflows. On Windows, use WSL; native Windows execution is not validated.

启用后，可在设置页「API 配置」中为每个 AI 功能（数学问答、套索/手写识别、习题批改、Quiz、大纲、讲义和摘要等）分别选择 Codex 网关、主 API 或副 API；首次使用时沿用启用前的调用方式。录音转写和音频纪要仍使用应用原有的 Gemini 配置。关闭 Codex 开关后，选择了 Codex 网关的功能会提示 Codex 未启用，需在「API 配置」中改选主/副 API。

## Architecture

```text
BOOX APK / GitHub Pages PWA
  ├─ text + images + PDF → private HTTPS gateway → local Codex app-server → ChatGPT login
  └─ audio              → existing Gemini configuration
```

The gateway exposes a small authenticated HTTP interface. It starts Codex over local stdio, requires ChatGPT authentication, and stores its own login separately from your desktop Codex configuration. Your ChatGPT credentials are never sent to the BOOX, PWA, GitHub or Cloudflare R2. The app stores a separate gateway access token on the device.

Codex model computation still runs through OpenAI's services and consumes the subscription's Codex allowance. This setup does not make the model run offline or create unlimited inference. The gateway host must be awake and reachable when you use AI; ordinary reading and handwriting remain local.

## Requirements

- Node.js 22.13 or newer, with npm.
- The pinned official `@openai/codex@0.159.2` CLI installed by `npm ci` below.
- A ChatGPT account with Codex access. No OpenAI Platform API key is used.
- A private HTTPS route from the BOOX/PWA to the gateway host.

Install JavaScript dependencies from this directory with `npm ci`. This includes the standalone official Codex CLI; the gateway does not depend on a running Codex desktop app. The PDF renderer is included through `pdfjs-dist` and `@napi-rs/canvas`; it does not need Python, Poppler or an external OCR service.

## Start the gateway

From the repository's `gateway` directory:

```sh
npm ci
npm run setup
npm run login
npm run status
npm start
```

`login` prints the official ChatGPT device-login URL and a short-lived code. Complete the login yourself in the browser. The gateway checks that the resulting account uses ChatGPT authentication. It will reject an API-key account instead of silently spending API credit.

`npm run login` is optional. When `npm start` finds the gateway signed out, it starts the same device-code sign-in itself and prints `ChatGPT sign-in: open https://auth.openai.com/codex/device and enter code …`; math-reader-codex shows that code in API Setting. A login completed with `npm run login` while the gateway is running is loaded on the next status check.

`setup` creates a random access token and prints the token file's path, without printing its value. Copy the contents of that file into math-reader-codex's **Gateway token** field. The default token file is `gateway/.state/gateway-token`; ChatGPT login is stored separately inside `gateway/.state/codex-home`. Both are excluded from Git. Keep this directory private and out of cloud backups or shared ZIPs.

By default, `start` listens on `http://127.0.0.1:4747`. Keep it running while using AI. Set these environment variables before running a command when you need a different configuration:

| Variable | Purpose |
| --- | --- |
| `MATH_READER_CODEX_BIN` | Optional override for the pinned CLI; use only a separately validated runtime |
| `MATH_READER_GATEWAY_STATE_DIR` | Private persistent state directory; default `.state` inside `gateway/` |
| `MATH_READER_GATEWAY_HOST` / `MATH_READER_GATEWAY_PORT` | Bind address and port; default `127.0.0.1:4747` |
| `MATH_READER_GATEWAY_ALLOWED_ORIGINS` | Additional exact browser origins, separated by commas |
| `MATH_READER_GATEWAY_TLS_CERT` / `MATH_READER_GATEWAY_TLS_KEY` | Certificate and private-key paths for native HTTPS |
| `MATH_READER_GATEWAY_TIMEOUT_MS` | Overall request timeout; default 600000 ms |
| `MATH_READER_GATEWAY_LECTURE_TIMEOUT_MS` | Generation time for one chapter lecture job, counted from submission; default 3600000 ms |

By default, the gateway uses its pinned CLI dependency. Do not substitute a desktop-bundled binary merely because it is newer: tool exposure can differ even when the same feature flags are supplied. A CLI override must pass the security/protocol tests and real account checks before use.

## Network connection

First verify the gateway on its own host using the loopback address. For your BOOX, use a private HTTPS endpoint, for example a VPN with HTTPS termination or a reverse proxy reachable only by your own devices. A public GitHub Pages PWA cannot reliably call an unencrypted LAN HTTP endpoint. The gateway's bind address, certificate options and allowed origins are explicit configuration; do not put the raw Codex app-server on a network listener.

The app's gateway URL must be the base address, such as `https://math-reader.your-private-domain.example`, without `/v1/ask`. Allow the exact browser origins that will call it. The Android application's origin is `https://appassets.androidplatform.net`; the current GitHub Pages origin is `https://none0enon.github.io`. A PWA hosted on another domain needs that origin added to the gateway configuration.

### Mac + Tailscale private HTTPS

1. Install the [official standalone Tailscale app](https://tailscale.com/docs/install/mac) on the Mac, approve its system extension/VPN prompts, and sign in. Install Tailscale on the BOOX and sign into the same private network.
2. Keep the gateway on its default `127.0.0.1:4747` address. Do not enable remote insecure binding.
3. In the Mac terminal, run the following using the standalone app's CLI:

   ```sh
   /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg http://127.0.0.1:4747
   /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
   ```

4. If Tailscale asks to enable HTTPS, follow its official confirmation link. Enter the resulting `https://…ts.net` base URL in the app, together with the separate gateway token. Keep that token out of GitHub, URLs and screenshots.
5. Use **Serve**, not **Funnel**: Serve is reachable within the private network; Funnel publishes a service to the Internet. Do not configure an exit node, subnet routes, or public port forwarding for this gateway.
6. If the browser asks for local-network access, allow it for the math-reader-codex site. The gateway supports allowlisted PNA preflights for older browsers, but that does not replace modern browser permission prompts or bearer authentication.

The Mac must remain awake, Tailscale connected, and the gateway process running. `serve --bg` does not start Node or prevent Mac sleep. Test **Test connection** from the actual BOOX; a successful request on the Mac does not establish BOOX connectivity. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and [Chrome local-network permissions](https://developer.chrome.com/blog/local-network-access).

## Configure math-reader-codex

1. Open **Settings → API Setting**.
2. Keep a working Gemini endpoint, key and audio-capable model in the existing Primary or Backup API settings.
3. Enable the **Codex** section and enter the private gateway's base URL and its separate access token.
4. Test the connection and load the models available to the gateway's ChatGPT account. Choose a model and supported reasoning effort.
5. Save, then test an ordinary question, a lasso image, a PDF page and an audio recording.
6. In **Settings → API by Feature**, choose Codex Gateway, Primary API or Backup API for each AI feature. The first run keeps the routing you had before; this choice is stored only in local IndexedDB, never R2-synced, and included in full ZIP export/import.

A feature routed to Codex shows a Codex failure to the user; it does not silently fall back to Gemini. Audio requests use a configured Gemini provider even when Codex is enabled. Gateway settings and its access token are excluded from R2 metadata sync and preserved during cloud restore. A full ZIP backup includes local settings, just as it did for existing AI keys, so keep that backup private.

## PDF handling

PDFs are parsed in a disposable worker. The gateway supplies every page as an image together with the text layer, retaining formulas, handwriting, diagrams and scanned pages. Client filenames never select filesystem paths. Temporary inputs and rendered pages live in a request-specific directory and are removed after completion, failure or cancellation.

Long responses use WebSocket. When the combined inline image encoding exceeds 1 MB, the gateway uploads the original images through Codex's ChatGPT file service and includes all file references in the same model turn. This avoids oversized WebSocket messages without splitting lecture generation or reducing image quality. The pinned CLI version supports these file references. Upstream retries are shown as a retry stage (see lecture jobs below).

A request accepts up to 64 MiB of PDF bytes, 48 pages, and 400,000 extracted text characters. Larger documents return an explicit `context_length_exceeded` error; they are never silently truncated. The existing outline generator recognizes this error and retries in smaller page ranges, including recursive splitting. A document with an unreadable password or broken rendering fails with an actionable error.

The 48-page limit applies to each request, not to an entire book. Outline generation can split automatically; other calls such as an unusually long single chapter or paper currently require a smaller page range/document. Image limits and model context limits may be reached earlier.

## Security boundary and API status

This is a single-user integration for your own trusted devices, not a public multi-tenant inference service. Run it under a dedicated OS account or container with access only to the gateway state and temporary inputs. The isolated `CODEX_HOME` and child environment separate credentials and configuration, but they are not an operating-system filesystem boundary.

The gateway disables known Codex tool features, explicitly disables `tools.experimental_request_user_input`, refuses client tool/approval requests, interrupts observed tool activity, and never forwards arbitrary HTTP input as app-server RPC methods. In a local fake-provider capture, the pinned official CLI sent an empty `tools` array and no injected `additional_tools` input. The desktop-bundled build tested separately did inject host tool descriptions; this is why the independent runtime is pinned. This observation is not an OS sandbox guarantee or a guarantee about future CLI/model changes. Do not run the service with access to unrelated private files or production secrets. Keep the raw app-server on private local stdio only.

Account allowance, device-code login availability, and supported model options depend on the user's ChatGPT account. The automated tests use local fakes; they do not establish subscription access, real model quality, remote HTTPS reachability, or BOOX compatibility. Those require the real-device acceptance checks above.

On 2026-09-20, the gateway was also validated on a Mac using a real ChatGPT login (no OpenAI API key): text mathematics, a triangle image, a PDF-based lecture, and JSON grading all returned correct sample answers with `gpt-6-astra`. These small acceptance samples are not a general accuracy guarantee; BOOX networking and real Gemini audio remain separate checks.

## HTTP interface

All `/v1/` endpoints require `Authorization: Bearer <gateway-access-token>`.

- `GET /v1/status`: restart Codex if its app-server exited, read the ChatGPT login and make an authenticated upstream rate-limit request. A forced token refresh is attempted only after ChatGPT rejects the current token. Returns readiness, `checkedAt`, `auth` (`email`, `planType` when signed in), a `login` or `gateway` recovery action with `statusError`/`statusMessage` on failure, and `login`: the pending device code (`verificationUrl`, `userCode`, `expiresAt`), the reason the last one ended, or `null`.
- `POST /v1/login`: start a ChatGPT device-code login, or return the pending one unchanged; a second request would cancel the code already shown. Returns `status`, `verificationUrl`, `userCode` and `expiresAt`; complete the authorization yourself in the browser.
- `GET /v1/models`: the available model IDs and supported reasoning effort options.
- `POST /v1/ask`: one mathematics request. With `Accept: text/event-stream`, returns SSE `progress`, `result`, and `error` events. The app always requests streaming; JSON remains available to older clients.
- `POST /v1/lecture-jobs`: submit `{ "id": "<client UUID>", "request": <ask request> }`; retrying the same id and input reuses the existing job.
- `GET /v1/lecture-jobs/<id>`: retrieve `pending` (with `progress`), `completed` (with `text`), or `failed` (with `error`). These endpoints require the same bearer token.
- `GET /v1/lecture-jobs/<id>/events`: stream the latest progress and final result for an existing job; reconnecting attaches to the same inference request.

All Codex generation requests start immediately in independent ephemeral threads. The gateway has no inference queue, pending-request limit, or application-level concurrency cap. Upstream account limits still apply and are reported as errors. Independent outline sections, uploaded exercises, OCR pages, batch grading requests, and handwriting-index requests also run concurrently. File and cloud commits retain their existing persistence ordering.

Progress carries `stage`, cumulative `partialText`, public `commentaryText`, and readable `reasoningSummary`; lecture progress also includes `elapsedMs`. Public messages and readable summaries accumulate across their message items without preview truncation. The SSE connection sends a heartbeat every 15 seconds, coalesces progress updates every 100 ms, and detects 45 seconds without incoming data. A slow client receives the latest pending preview and the complete final result after its socket drains. OpenAI-compatible, Claude, and Gemini requests also use streaming. Raw reasoning is never forwarded.

Every Codex generation request enters the shared output viewer, including all 23 non-audio feature routes. Features with an explicit in-place preview continue displaying it; every other feature opens the shared viewer as soon as its request begins. This includes outline sections, abstracts, classroom photos/files, selections, exercise upload/batch/regeneration, all grading routes, OCR, handwriting recognition/indexing, and review quiz generation/grading. Cumulative JSON and tagged responses are visible as text during generation and are parsed/saved by their feature after completion.

Each concurrent request has its own number, feature/source label, public messages, readable summary, answer buffer, completion state, and error. The request selector switches between these independent buffers. Closing the viewer lets generation continue; **Codex output** in the gateway settings reopens it. Failure retains the text already received, and clearing finished previews only clears these transient in-memory buffers. These buffers never enter app data, IndexedDB, backups, or cloud synchronization.

Chapter jobs continue after a browser disconnect. The page retains the job id and connection/model selection, then reconnects to the event stream when reopened. Jobs have a 60-minute generation deadline from submission, and completed results remain for up to 30 minutes; retained completed results can be evicted when 64 records accumulate. Connection retries tolerate about two minutes offline. Restarting the gateway loses in-memory jobs and causes missing jobs to be resubmitted. Update the gateway and frontend together, then restart the gateway.

The connection settings page checks on open, on return to the app, and every 30 seconds while the app is visible and Codex is configured. A generation transport or authorization failure opens the existing gateway settings. Editing the URL or token clears the previous success state; stale asynchronous checks cannot overwrite a newer configuration.

When the gateway answers but ChatGPT is signed out or the login expired, API Setting opens by itself, requests the device code from the gateway (or shows the one it already has) and displays it with the official authorization link; every device shows the same code. The APK opens the authorization page in the system browser and copies the code once per sign-in; a browser opens it when a recent tap allows a new window, otherwise through **Open authorization and copy code**. While API Setting is open the page checks every 3 seconds (paused while the authorization page is in front) and switches to the signed-in account as soon as authorization completes. An expired code is replaced automatically. Instructions to start the gateway and check VPN/Tailscale, HTTPS forwarding, URL and token appear only when the gateway cannot be reached; a reachable gateway whose Codex service failed shows the gateway's own error, and a gateway too old for web sign-in is identified as needing an update. Manual authorization remains available with `npm run login` in `gateway/`.

The gateway restarts its Codex app-server on the next request after the process exits. Generation and model requests do not force a token refresh, so concurrent requests cannot rotate the refresh token underneath each other; `npm run status` also reads the login without refreshing it.

Over HTTP/SSE, ChatGPT was observed to end a single model response stream after about 15 minutes; lectures with high or maximum reasoning effort can exceed this. WebSocket avoids that observed path, but generation longer than 15 minutes over WebSocket is not yet validated. Whenever a response stream ends early, Codex retries automatically: completed reasoning is kept, but the unfinished lecture text is written again from its beginning. The chapter page shows this as a retry stage and keeps the longest earlier preview until the new attempt overtakes it; only the completed answer is saved. If every retry is cut off, the job fails with `codex_stream_disconnected`; use a smaller page range or lower reasoning effort.

The request accepts `systemPrompt`, `messages`, optional `model` and `reasoningEffort`, and optional `pdfAttachment: { base64, name }`. Message content is a string or an array of `text` and inline `image_url` blocks. Audio is not accepted by this endpoint. Errors have the form `{ "error": { "code": "...", "message": "..." } }`.

## Official references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [ChatGPT and Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

This is a personal, trusted-device integration. The documented app-server interface is experimental; validate upgrades with the gateway tests and a real text/image/PDF request before updating a working installation.
