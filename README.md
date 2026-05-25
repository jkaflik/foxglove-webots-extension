# Foxglove Webots Extension

Foxglove Desktop extension that embeds a Webots R2025a 3D stream directly with the `webots-view` web component. It does not use an iframe, Webots' generated `index.html` page, or a runtime download of `WebotsView.js`.

## Requirements

- Foxglove Desktop
- Webots R2025a

## Install dependencies

```sh
npm install
```

## Run Webots streaming

Start Webots with the streaming server enabled. Webots uses TCP port `1234` by default.

```sh
webots --stream=w3d /path/to/world.wbt
```

On macOS, if `webots` is not on your `PATH`, use the app binary directly:

```sh
/Applications/Webots.app/Contents/MacOS/webots --stream=w3d /path/to/world.wbt
```

For another port:

```sh
webots --port=1235 --stream=w3d /path/to/world.wbt
```

Then set `Webots port` to `1235` in the panel settings, or use manual server URL `ws://localhost:1235`.

## Install into Foxglove Desktop

```sh
npm run local-install
```

Open or reload Foxglove Desktop, then add the `Webots` panel.

## Package

```sh
npm run package
```

The packaged `.foxe` file is written to the project root.

## Panel settings

- `Server URL mode`: defaults to `Auto from Foxglove source`. The panel derives `ws://<data-source-host>:<Webots port>` from the active Foxglove data source when possible.
- `Manual server URL`: fallback/manual Webots streaming WebSocket URL. Default: `ws://localhost:1234`.
- `Webots port`: default `1234`, used by auto mode.
- `Mode`: `w3d` or `mjpeg`. Default: `w3d`.
- `Watch-only`: passes Webots' broadcast mode. Disabled by default so the Webots toolbar can control the simulation.
- `Auto-connect`: connects automatically when the panel mounts. Enabled by default.
- Panel settings actions: `Reconnect` and `Disconnect`.

## Notes

- Webots `webots-view` R2025a and its JavaScript/CSS/WASM support files are bundled into the extension under `src/vendor/webots`.
