# Bit Lab

Browser-based Arduino code editor with Arduino Uno compilation and upload.

## Requirements

- Node.js 20.19 or newer and npm
- Arduino CLI (local installation; see [Arduino CLI setup](#arduino-cli-setup))
- A connected Arduino Uno or compatible board for hardware uploads
- A WebUSB-capable browser for USB device selection; localhost is a secure
  context for browser device APIs

## Getting started

Install JavaScript dependencies, Arduino CLI, and the supported board cores:

```powershell
npm install
npm run arduino:setup
npm run arduino:cores:install
Copy-Item backend\.env.example backend\.env
```

Start the apps:

```powershell
npm run dev
```

Open `http://localhost:5173`. The Vite development server proxies
API requests to the backend, which listens only on `127.0.0.1:3001`.

## Arduino CLI setup

On Windows, download and verify the latest Arduino CLI release into the
project-local `.tools` directory, then install or update the cores:

```powershell
npm run arduino:setup
npm run arduino:cores:install
npm run arduino:version
```

The setup script downloads the official CLI release and verifies its published
SHA-256 checksum. Arduino CLI data, downloaded packages, and user libraries are
kept in this project directory. To use a CLI executable installed elsewhere,
set `ARDUINO_CLI_PATH` before starting the backend.

## Compile and upload

Choose a board from **Select Board**, then click **Compile** to see compiler
logs and generate an Intel HEX or binary file. After a successful build:

1. Connect the board to the computer.
2. Click **Detect board** to request browser USB device permission, or use
   **Refresh ports** if WebUSB is unavailable.
3. Select the board's serial port and click **Upload**.

The browser's WebUSB API is used for USB device selection, but it cannot directly
flash the USB-serial interface used by a typical Uno R3. The actual serial
bootloader upload therefore goes through the local Arduino CLI bridge, which
validates the generated HEX file and confirms that the selected port is
currently available. This local bridge is also the fallback when WebUSB is
unsupported; no network-facing agent is required. A future Arduino Create Agent
adapter can replace the local CLI upload implementation without changing the
editor's compile flow.

## Libraries

Click **Libraries** in the top bar to open the Library Manager, which works
like the one in the Arduino IDE:

- **Browse** searches the Arduino library index (refreshed at most once a day).
  Pick a version and click **Install**; dependencies are installed too. An
  installed library can be switched to another version or removed.
- **Installed** lists installed libraries, offers **Update** when a newer
  version exists, and **Include** adds the library's `#include` lines to the
  top of the sketch.
- **Add .ZIP** installs a library from a `.zip` file of up to 20 MB, like the
  IDE's *Sketch > Include Library > Add .ZIP Library*.

Libraries are installed with Arduino CLI into `arduino/libraries/` in this
project and are shared by every sketch compiled by this backend. Library
installs and removals run one at a time.

## Boards

Click **Boards** in the top bar to open the Board Manager, which works like the
one in the Arduino IDE: **Browse** lists every board package from the package
indexes (search to filter), and **Installed** offers **Update** and **Remove**.
Installing a package such as `arduino:samd` adds all of its boards to the
**Board** list, grouped by package, and they can be compiled and uploaded right
away. Package downloads include compilers and tools and can take several
minutes. AVR boards build an Intel HEX file; other cores build a `.bin`.

Boards from other makers (Raspberry Pi Pico, STM32, Adafruit, ...) need their
package index link, the IDE's *Additional Boards Manager URLs*. Paste the
`package_..._index.json` link in the Board Manager's **Board URLs** tab (or
pick a popular one) and click **Add**; its boards then show up in **Browse**.
A link whose index can't be downloaded is rejected and not saved. The links
are stored in `arduino-cli.yaml`.

## Serial Monitor and Plotter

The bottom panel has three tabs: **Console**, **Serial Monitor** and
**Serial Plotter**. Pick the board's port, choose the baud rate that matches
`Serial.begin(...)`, and click **Connect** (opening either serial tab connects
automatically). The monitor and plotter share one connection through the local
Arduino CLI bridge (`arduino-cli monitor`), so it works in any browser.

- **Serial Monitor** shows incoming text with optional timestamps and
  autoscroll, and sends messages with a chosen line ending (↑ recalls history).
- **Serial Plotter** graphs numbers printed one line per sample, in the same
  formats as the Arduino IDE: `12 34`, `12,34`, or labelled
  `temp:21.5 humidity:40`. Click a legend entry to hide a series.

A serial port can only be opened once, so uploading pauses the monitor and
reconnects it afterwards. Compile and upload show an estimated progress bar
(Arduino CLI does not report progress), which learns from previous run times
per board.

Each sketch opens in its own tab above the editor, so **New** and **Open**
never replace what you were working on; click a tab to switch, and **×** (or
middle-click) to close it. Open tabs are kept in the browser and come back
after a reload. **Compile** builds the active tab. In Chrome and Edge, **Save**
writes back to the opened file; other browsers download it instead. Zoom the
code with the toolbar, **Ctrl + mouse wheel** over the editor, or the keyboard.

Shortcuts: **Ctrl+R** compile, **Ctrl+U** upload, **Ctrl+S** save,
**Ctrl+O** open, **Ctrl+=** / **Ctrl+-** / **Ctrl+0** zoom the editor.

## API

The API has no authentication: anyone who can reach it can list ports,
compile, and upload. It listens only on `127.0.0.1` by default, so only this
computer can reach it. Do not expose it on a network (`HOST=0.0.0.0`) without
putting access control in front of it.

- `GET /ports` lists ports detected by Arduino CLI.
- `POST /compile` accepts `{ "code": "...", "board": "arduino:avr:uno" }` and
  returns compiler logs and a base64-encoded board-specific artifact. ESP32
  artifacts also include the bootloader and partition table in `supportFiles`.
- `GET /libraries` lists installed libraries, and
  `GET /libraries/search?q=dht` searches the library index (up to 50 results).
- `POST /libraries/install` accepts `{ "name": "DHT sensor library",
  "version": "1.4.7" }` (version optional); `POST /libraries/uninstall`
  accepts `{ "name": "..." }`; `POST /libraries/zip` accepts a raw
  `application/zip` body.
- `POST /upload` accepts `{ "port": "COM4", "board": "arduino:avr:uno",
  "filename": "BitLabSketch.hex", "binary": "..." }` (plus `supportFiles` for
  ESP32), validates the artifact type and detected port, then uploads with
  Arduino CLI. Any serial monitor open on that port is closed first.
- `GET /boards` lists every installed board; `GET /cores` lists installed
  board packages and `GET /cores/search?q=samd` searches the package index
  (an empty query lists all). `POST /cores/install` accepts `{ "id":
  "arduino:samd", "version": "1.8.14" }` (version optional) and
  `POST /cores/uninstall` accepts `{ "id": "..." }`. `GET /cores/urls` lists the additional
  board manager URLs, `POST /cores/urls` with `{ "url": "https://..." }` adds
  one (and downloads its index), and `POST /cores/urls/remove` removes one. Compile and upload accept
  any installed board's FQBN.
- `GET /monitor?port=COM4&baud=9600` streams serial output as
  newline-delimited JSON (`open`, `data`, `error`, `closed` events) until the
  client disconnects; `POST /monitor/send` accepts `{ "port": "COM4",
  "data": "on
" }` and writes it to the open monitor.

### Rate limits

Requests are limited per client IP across the whole API, with tighter limits
on compile and upload. Defaults are 300 API requests, 20 compiles, 10
uploads, and 30 library changes per IP every 10 minutes; change
them with the `RATE_LIMIT_*` variables in `backend/.env`. Limited requests
return HTTP 429 with a `RateLimit` header. Counters are kept in memory, so they
apply per backend process; use a shared store such as Redis
([`rate-limit-redis`](https://www.npmjs.com/package/rate-limit-redis)) if you
run several backend instances.

## Adding boards

The supported board list lives in the root [`boards.json`](./boards.json) and
is shared by the frontend dropdown and backend FQBN allowlist. To add a board,
add its display name and exact Arduino CLI FQBN there. Add its package index URL
to `arduino-cli.yaml` if required, add its core to
[`scripts/install-board-cores.ps1`](./scripts/install-board-cores.ps1), and
extend the compile artifact extension mapping in
[`backend/src/compiler.ts`](./backend/src/compiler.ts) if the core produces
something other than `.hex` for AVR or `.bin` for ESP boards. Install/update
the listed cores with `npm run arduino:cores:install`.

Rate-limited requests return HTTP 429.
Compilation failures return HTTP 422. Invalid requests return HTTP 400; a port
that is no longer detected returns HTTP 409.

## HTTPS and deployment

HTTPS is enforced automatically when `NODE_ENV=production`, or explicitly with
`REQUIRE_HTTPS=true`. Terminate TLS at a trusted reverse proxy. In that setup,
set `TRUST_PROXY=true` only if the proxy overwrites `X-Forwarded-Proto`. Enable
`HOST=0.0.0.0` only when the API is firewalled and reachable solely through
that proxy. HSTS is emitted for HTTPS requests. Plain HTTP remains available
for local development on loopback.

## Build and test

```powershell
npm run build
npm test
```
