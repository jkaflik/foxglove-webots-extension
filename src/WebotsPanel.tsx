import type { Experimental, PanelExtensionContext, SettingsTree, SettingsTreeAction } from "@foxglove/extension";
import { ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./vendor/webots/WebotsView.js";

const WEBOTS_RELEASE = "R2025a";
const DEFAULT_WEBOTS_PORT = 1234;

type WebotsMode = "w3d" | "mjpeg";
type ServerUrlMode = "auto" | "manual";
type ConnectionStatus = "idle" | "loading" | "ready" | "connecting" | "connected" | "disconnected" | "error";

type WebotsPanelConfig = {
  serverUrlMode: ServerUrlMode;
  manualServerUrl: string;
  webotsPort: number;
  mode: WebotsMode;
  broadcast: boolean;
  autoConnect: boolean;
};

type DerivedServer = {
  host: string;
  protocol: "ws" | "wss";
  sourceName: string;
};

type WebotsConnectArgs = [string, WebotsMode?, boolean?, boolean?, number?, string?];

type WebotsViewElement = HTMLElement & {
  connect: (...args: WebotsConnectArgs) => void;
  close: () => void;
  hasView: () => boolean;
  resize: () => void;
  setWebotsErrorMessageCallback: (callback: (message: string) => void) => void;
  setWebotsMessageCallback: (callback: (message: string) => void) => void;
  showToolbar: () => void;
  ondisconnect?: () => void;
  onready?: () => void;
  showCustomWindow?: boolean;
  showIde?: boolean;
  showInfo?: boolean;
  showPlay?: boolean;
  showQuit?: boolean;
  showReload?: boolean;
  showReset?: boolean;
  showRobotWindow?: boolean;
  showRun?: boolean;
  showStep?: boolean;
  showTerminal?: boolean;
  showWorldSelection?: boolean;
};

const DEFAULT_CONFIG: WebotsPanelConfig = {
  serverUrlMode: "auto",
  manualServerUrl: `ws://localhost:${DEFAULT_WEBOTS_PORT}`,
  webotsPort: DEFAULT_WEBOTS_PORT,
  mode: "w3d",
  broadcast: false,
  autoConnect: true,
};

let activeOwner: symbol | undefined;
let sharedWebotsView: WebotsViewElement | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function parseWebotsPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONFIG.webotsPort;
  }

  const port = Math.round(value);
  return port >= 1 && port <= 65_535 ? port : DEFAULT_CONFIG.webotsPort;
}

function parseInitialConfig(initialState: unknown): WebotsPanelConfig {
  if (!isRecord(initialState)) {
    return DEFAULT_CONFIG;
  }

  const legacyServerUrl = typeof initialState.serverUrl === "string" ? initialState.serverUrl : undefined;
  const manualServerUrl = typeof initialState.manualServerUrl === "string" && initialState.manualServerUrl.trim() !== ""
    ? initialState.manualServerUrl
    : legacyServerUrl ?? DEFAULT_CONFIG.manualServerUrl;
  const hasLegacyServerUrl = legacyServerUrl != undefined && legacyServerUrl.trim() !== "";
  const serverUrlMode = initialState.serverUrlMode === "auto" || initialState.serverUrlMode === "manual"
    ? initialState.serverUrlMode
    : hasLegacyServerUrl
      ? "manual"
      : DEFAULT_CONFIG.serverUrlMode;
  const mode = initialState.mode === "mjpeg" ? "mjpeg" : DEFAULT_CONFIG.mode;
  const broadcast = typeof initialState.broadcast === "boolean"
    ? initialState.broadcast
    : DEFAULT_CONFIG.broadcast;
  const autoConnect = typeof initialState.autoConnect === "boolean"
    ? initialState.autoConnect
    : DEFAULT_CONFIG.autoConnect;

  return {
    serverUrlMode,
    manualServerUrl,
    webotsPort: parseWebotsPort(initialState.webotsPort),
    mode,
    broadcast,
    autoConnect,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForCustomElement(name: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(`Timed out while loading custom element <${name}>`));
    }, timeoutMs);

    customElements
      .whenDefined(name)
      .then(() => {
        window.clearTimeout(timeout);
        resolve();
      })
      .catch((error: unknown) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

async function loadWebotsViewDefinition(): Promise<void> {
  await waitForCustomElement("webots-view", 15_000);
}

function getOrCreateWebotsView(): WebotsViewElement {
  if (sharedWebotsView != undefined) {
    return sharedWebotsView;
  }

  const webotsView = document.createElement("webots-view") as WebotsViewElement;
  webotsView.classList.add("foxglove-webots-view");
  webotsView.style.background = "#05070a";
  webotsView.style.display = "block";
  webotsView.style.height = "100%";
  webotsView.style.minHeight = "0";
  webotsView.style.overflow = "hidden";
  webotsView.style.width = "100%";
  sharedWebotsView = webotsView;
  return webotsView;
}

function restoreDefaultWebotsToolbarOptions(webotsView: WebotsViewElement): void {
  webotsView.showCustomWindow = undefined;
  webotsView.showIde = undefined;
  webotsView.showInfo = undefined;
  webotsView.showPlay = undefined;
  webotsView.showQuit = undefined;
  webotsView.showReload = undefined;
  webotsView.showReset = undefined;
  webotsView.showRobotWindow = undefined;
  webotsView.showRun = undefined;
  webotsView.showStep = undefined;
  webotsView.showTerminal = undefined;
  webotsView.showWorldSelection = undefined;
}

function normalizeHostForUrl(host: string): string {
  const unwrappedHost = host.replace(/^\[/u, "").replace(/\]$/u, "");
  return unwrappedHost.includes(":") ? `[${unwrappedHost}]` : unwrappedHost;
}

function protocolForSourceUrl(url: URL): "ws" | "wss" {
  return url.protocol === "wss:" || url.protocol === "https:" ? "wss" : "ws";
}

function tryDeriveServerFromText(text: string): DerivedServer | undefined {
  const directValue = text.trim();
  const urlMatch = /\b(?:wss?|https?):\/\/[^\s,)]+/u.exec(directValue);
  const candidate = urlMatch?.[0] ?? directValue;

  try {
    const url = new URL(candidate);
    if (url.hostname === "") {
      return undefined;
    }

    return { host: url.hostname, protocol: protocolForSourceUrl(url), sourceName: text };
  } catch {
    return undefined;
  }
}

function deriveServerFromDataSources(dataSources: Experimental.DataSourceMap | undefined): DerivedServer | undefined {
  for (const dataSource of dataSources?.values() ?? []) {
    const derivedServer = tryDeriveServerFromText(dataSource.name);
    if (derivedServer != undefined) {
      return derivedServer;
    }
  }

  return undefined;
}

function resolveServerUrl(config: WebotsPanelConfig, derivedServer: DerivedServer | undefined): string {
  if (config.serverUrlMode === "manual") {
    const manualServerUrl = config.manualServerUrl.trim();
    return manualServerUrl === "" ? DEFAULT_CONFIG.manualServerUrl : manualServerUrl;
  }

  const protocol = derivedServer?.protocol ?? "ws";
  const host = normalizeHostForUrl(derivedServer?.host ?? "localhost");
  return `${protocol}://${host}:${config.webotsPort}`;
}

function connectionStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "loading":
      return "Loading Webots view";
    case "ready":
      return "Ready";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "error":
      return "Error";
  }
}

function statusColor(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "#28d17c";
    case "connecting":
    case "loading":
      return "#f0c94b";
    case "error":
      return "#ff6b6b";
    case "disconnected":
      return "#9aa3b2";
    case "idle":
    case "ready":
      return "#6aa9ff";
  }
}

function createSettingsTree(args: {
  config: WebotsPanelConfig;
  derivedServer: DerivedServer | undefined;
  lastError: string;
  resolvedServerUrl: string;
  status: ConnectionStatus;
  statusText: string;
  actionHandler: (action: SettingsTreeAction) => void;
}): SettingsTree {
  const { actionHandler, config, derivedServer, lastError, resolvedServerUrl, status, statusText } = args;

  return {
    enableFilter: true,
    actionHandler,
    nodes: {
      connection: {
        label: "Connection",
        actions: [
          { type: "action", id: "reconnect", label: "Reconnect" },
          { type: "action", id: "disconnect", label: "Disconnect" },
        ],
        fields: {
          serverUrlMode: {
            label: "Server URL mode",
            input: "select",
            value: config.serverUrlMode,
            options: [
              { label: "Auto from Foxglove source", value: "auto" },
              { label: "Manual", value: "manual" },
            ],
          },
          manualServerUrl: {
            label: "Manual server URL",
            input: "string",
            value: config.manualServerUrl,
            disabled: config.serverUrlMode === "auto",
            placeholder: DEFAULT_CONFIG.manualServerUrl,
          },
          webotsPort: {
            label: "Webots port",
            input: "number",
            value: config.webotsPort,
            min: 1,
            max: 65_535,
            precision: 0,
            step: 1,
            disabled: config.serverUrlMode === "manual",
          },
          mode: {
            label: "Mode",
            input: "select",
            value: config.mode,
            options: [
              { label: "w3d", value: "w3d" },
              { label: "mjpeg", value: "mjpeg" },
            ],
          },
          broadcast: {
            label: "Watch-only",
            input: "boolean",
            value: config.broadcast,
            help: "When disabled, Webots toolbar controls can control the simulation.",
          },
          autoConnect: {
            label: "Auto-connect",
            input: "boolean",
            value: config.autoConnect,
          },
        },
      },
      status: {
        label: "Status",
        fields: {
          connectionStatus: {
            label: "Connection status",
            input: "string",
            value: connectionStatusLabel(status),
            readonly: true,
          },
          statusText: {
            label: "Details",
            input: "string",
            value: statusText,
            readonly: true,
          },
          resolvedServerUrl: {
            label: "Resolved server URL",
            input: "string",
            value: resolvedServerUrl,
            readonly: true,
          },
          detectedSource: {
            label: "Detected source",
            input: "string",
            value: derivedServer?.sourceName ?? "No URL-like Foxglove data source detected",
            readonly: true,
          },
          lastError: {
            label: "Last error",
            input: "multiline-string",
            value: lastError,
            readonly: true,
          },
        },
      },
    },
  };
}

function WebotsPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [config, setConfig] = useState<WebotsPanelConfig>(() =>
    parseInitialConfig(context.initialState),
  );
  const [derivedServer, setDerivedServer] = useState<DerivedServer | undefined>();
  const [lastError, setLastError] = useState("");
  const [lastMessage, setLastMessage] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [statusText, setStatusText] = useState("Not connected");
  const [viewReady, setViewReady] = useState(false);
  const configRef = useRef(config);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const didInitialAutoConnectRef = useRef(false);
  const lastAutoConnectKeyRef = useRef<string | undefined>();
  const ownerIdRef = useRef(Symbol("WebotsPanel"));
  const resolvedServerUrl = resolveServerUrl(config, derivedServer);
  const resolvedServerUrlRef = useRef(resolvedServerUrl);
  const webotsViewRef = useRef<WebotsViewElement | undefined>();

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    resolvedServerUrlRef.current = resolvedServerUrl;
  }, [resolvedServerUrl]);

  const updateConfig = useCallback(
    (patch: Partial<WebotsPanelConfig>) => {
      setConfig((current) => {
        const next = { ...current, ...patch };
        context.saveState(next);
        return next;
      });
    },
    [context],
  );

  const connectWebotsView = useCallback((): void => {
    const webotsView = webotsViewRef.current;
    if (webotsView == undefined) {
      setStatus("error");
      setStatusText("Webots view is not ready yet");
      return;
    }

    const nextConfig = configRef.current;
    const serverUrl = resolvedServerUrlRef.current.trim();
    if (serverUrl === "") {
      setStatus("error");
      setStatusText("Server URL is empty");
      setLastError("Enter a Webots streaming WebSocket URL, e.g. ws://localhost:1234");
      return;
    }

    try {
      setLastError("");
      setLastMessage("");
      setStatus("connecting");
      setStatusText(`Connecting to ${serverUrl}`);
      restoreDefaultWebotsToolbarOptions(webotsView);

      webotsView.onready = () => {
        webotsView.setWebotsMessageCallback((message: string) => {
          setLastError("");
          setLastMessage(message);
        });
        webotsView.setWebotsErrorMessageCallback((message: string) => {
          setLastError(message);
          setStatus("error");
          setStatusText("Webots reported an error");
        });
        webotsView.showToolbar();
        webotsView.resize();
        setStatus("connected");
        setStatusText(`Connected to ${serverUrl}`);
      };

      webotsView.ondisconnect = () => {
        setStatus("disconnected");
        setStatusText("Disconnected from Webots");
      };

      webotsView.connect(serverUrl, nextConfig.mode, nextConfig.broadcast, false);
    } catch (error: unknown) {
      setStatus("error");
      setLastError(formatError(error));
      setStatusText("Failed to connect to Webots");
    }
  }, []);

  const disconnectWebotsView = useCallback(() => {
    const webotsView = webotsViewRef.current;
    if (webotsView == undefined) {
      return;
    }

    try {
      webotsView.close();
      setStatus("disconnected");
      setStatusText("Disconnected from Webots");
    } catch (error: unknown) {
      setStatus("error");
      setLastError(formatError(error));
      setStatusText("Failed to disconnect from Webots");
    }
  }, []);

  const handleSettingsAction = useCallback(
    (action: SettingsTreeAction): void => {
      if (action.action === "perform-node-action") {
        if (action.payload.id === "reconnect") {
          connectWebotsView();
        } else if (action.payload.id === "disconnect") {
          disconnectWebotsView();
        }
        return;
      }

      if (action.action !== "update" || action.payload.path[0] !== "connection") {
        return;
      }

      const field = action.payload.path[1];
      const value = action.payload.value;
      switch (field) {
        case undefined:
          break;
        case "serverUrlMode":
          if (value === "auto" || value === "manual") {
            updateConfig({ serverUrlMode: value });
          }
          break;
        case "manualServerUrl":
          if (typeof value === "string") {
            updateConfig({ manualServerUrl: value });
          }
          break;
        case "webotsPort":
          updateConfig({ webotsPort: parseWebotsPort(value) });
          break;
        case "mode":
          if (value === "w3d" || value === "mjpeg") {
            updateConfig({ mode: value });
          }
          break;
        case "broadcast":
          if (typeof value === "boolean") {
            updateConfig({ broadcast: value });
          }
          break;
        case "autoConnect":
          if (typeof value === "boolean") {
            updateConfig({ autoConnect: value });
          }
          break;
      }
    },
    [connectWebotsView, disconnectWebotsView, updateConfig],
  );

  useEffect(() => {
    context.updatePanelSettingsEditor(
      createSettingsTree({
        actionHandler: handleSettingsAction,
        config,
        derivedServer,
        lastError,
        resolvedServerUrl,
        status,
        statusText,
      }),
    );
  }, [config, context, derivedServer, handleSettingsAction, lastError, resolvedServerUrl, status, statusText]);

  useEffect(() => {
    context.setDefaultPanelTitle("Webots");
  }, [context]);

  useEffect(() => {
    const dataSourceContext = context as unknown as {
      onRender?: (renderState: Experimental.RenderState, done: () => void) => void;
      watch: (field: "dataSources") => void;
    };

    dataSourceContext.onRender = (renderState, done) => {
      setDerivedServer(deriveServerFromDataSources(renderState.dataSources));
      done();
    };

    try {
      dataSourceContext.watch("dataSources");
    } catch (error: unknown) {
      setLastError(`Could not watch Foxglove data sources: ${formatError(error)}`);
    }
  }, [context]);

  useEffect(() => {
    const ownerId = ownerIdRef.current;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;

    setStatus("loading");
    setStatusText(`Loading bundled WebotsView.js ${WEBOTS_RELEASE}`);

    void loadWebotsViewDefinition()
      .then(() => {
        if (disposed || containerRef.current == undefined) {
          return;
        }

        const webotsView = getOrCreateWebotsView();
        activeOwner = ownerId;
        webotsViewRef.current = webotsView;
        containerRef.current.replaceChildren(webotsView);

        resizeObserver = new ResizeObserver(() => {
          webotsView.resize();
        });
        resizeObserver.observe(containerRef.current);

        setViewReady(true);
        setStatus("ready");
        setStatusText("Webots view loaded");
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }

        setStatus("error");
        setLastError(formatError(error));
        setStatusText("Failed to load bundled WebotsView.js");
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      setViewReady(false);

      if (activeOwner !== ownerId) {
        return;
      }

      activeOwner = undefined;
      const webotsView = webotsViewRef.current;
      webotsViewRef.current = undefined;
      if (webotsView == undefined) {
        return;
      }

      webotsView.onready = undefined;
      webotsView.ondisconnect = undefined;
      try {
        webotsView.close();
      } catch {
        // Foxglove is unmounting the panel; Webots may already have closed its internal view.
      }
      webotsView.parentElement?.removeChild(webotsView);
    };
  }, []);

  useEffect(() => {
    if (!viewReady || !config.autoConnect) {
      return;
    }

    const autoConnectKey = `${resolvedServerUrl}|${config.mode}|${String(config.broadcast)}`;
    if (!didInitialAutoConnectRef.current) {
      didInitialAutoConnectRef.current = true;
      lastAutoConnectKeyRef.current = autoConnectKey;
      connectWebotsView();
      return;
    }

    if (config.serverUrlMode === "auto" && lastAutoConnectKeyRef.current !== autoConnectKey) {
      lastAutoConnectKeyRef.current = autoConnectKey;
      connectWebotsView();
    }
  }, [config.autoConnect, config.broadcast, config.mode, config.serverUrlMode, connectWebotsView, resolvedServerUrl, viewReady]);

  return (
    <div
      style={{
        background: "#05070a",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
        width: "100%",
      }}
    >
      <div ref={containerRef} style={{ height: "100%", minHeight: 0, width: "100%" }} />
      <div
        style={{
          alignItems: "center",
          background: "rgba(11, 15, 23, 0.82)",
          border: "1px solid rgba(148, 163, 184, 0.24)",
          borderRadius: 999,
          display: "flex",
          gap: 8,
          left: 10,
          maxWidth: "calc(100% - 20px)",
          padding: "5px 9px",
          pointerEvents: "none",
          position: "absolute",
          top: 10,
          zIndex: 10,
        }}
      >
        <span
          style={{
            background: statusColor(status),
            borderRadius: 999,
            display: "inline-block",
            flex: "0 0 auto",
            height: 8,
            width: 8,
          }}
        />
        <span
          style={{
            color: status === "error" ? "#fecaca" : "#d6deeb",
            fontFamily:
              "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {statusText}
        </span>
      </div>
      {lastError !== "" && (
        <div
          style={{
            background: "rgba(127, 29, 29, 0.86)",
            border: "1px solid rgba(252, 165, 165, 0.36)",
            borderRadius: 6,
            bottom: 10,
            color: "#fee2e2",
            fontFamily:
              "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontSize: 12,
            left: 10,
            maxWidth: "calc(100% - 20px)",
            padding: "7px 9px",
            pointerEvents: "none",
            position: "absolute",
            wordBreak: "break-word",
            zIndex: 10,
          }}
        >
          {lastError}
        </div>
      )}
      {lastError === "" && lastMessage !== "" && (
        <div
          style={{
            background: "rgba(15, 23, 42, 0.82)",
            border: "1px solid rgba(148, 163, 184, 0.24)",
            borderRadius: 6,
            bottom: 10,
            color: "#cbd5e1",
            fontFamily:
              "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontSize: 12,
            left: 10,
            maxWidth: "calc(100% - 20px)",
            padding: "7px 9px",
            pointerEvents: "none",
            position: "absolute",
            wordBreak: "break-word",
            zIndex: 10,
          }}
        >
          {lastMessage}
        </div>
      )}
    </div>
  );
}

export function initWebotsPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<WebotsPanel context={context} />);

  return () => {
    root.unmount();
  };
}
