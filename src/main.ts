import { app, BrowserWindow, dialog } from "electron";
import * as path from "node:path";
import { registerIpcHandlers } from "./ipc/ipc_host";
import dotenv from "dotenv";
// @ts-ignore
import started from "electron-squirrel-startup";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import log from "electron-log";
import {
  getSettingsFilePath,
  readSettings,
  writeSettings,
} from "./main/settings";
import { handleSupabaseOAuthReturn } from "./supabase_admin/supabase_return_handler";
import { handleTernaryProReturn } from "./main/pro";
import { IS_TEST_BUILD } from "./ipc/utils/test_utils";
import { BackupManager } from "./backup_manager";
import { getDatabasePath, initializeDatabase } from "./db";
import { UserSettings } from "./lib/schemas";
import { handleNeonOAuthReturn } from "./neon_admin/neon_return_handler";

log.errorHandler.startCatching();
log.eventLogger.startLogging();
log.scope.labelPadding = false;

const logger = log.scope("main");

// Load environment variables from .env file
dotenv.config();

// Register IPC handlers before app is ready
registerIpcHandlers();

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

async function fetchAndUpdateAppAuthFromToken(
  token: string,
  deviceId?: string,
) {
  const settings = readSettings();
  const base =
    process.env.NEXT_PUBLIC_WEBSITE_BASE ||
    process.env.VERCEL_URL ||
    "https://ternary-pre-domain.vercel.app";
  const origin = base.startsWith("http") ? base : base ? `https://${base}` : "";
  const meUrl = `${origin}/api/app/me`;
  const res = await fetch(meUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET /api/app/me failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as any;
  writeSettings({
    appAuth: {
      token: { value: token },
      deviceId: json.device_id ?? deviceId ?? settings.appAuth?.deviceId,
      email: json.email ?? settings.appAuth?.email,
      plan: json.plan ?? settings.appAuth?.plan,
      status: json.status ?? settings.appAuth?.status,
      featureFlags: json.feature_flags ?? settings.appAuth?.featureFlags,
    },
    enableTernaryPro: Boolean(json?.feature_flags?.pro === true),
  });
  logger.info(
    "Refreshed app auth from token",
    json.email,
    json.plan,
    json.status,
  );
}

async function handleDeviceLinkCallback({
  token,
  deviceId,
}: {
  token: string;
  deviceId?: string;
}): Promise<void> {
  // Persist token immediately so it survives restarts
  writeSettings({
    appAuth: { token: { value: token }, deviceId },
  });
  await fetchAndUpdateAppAuthFromToken(token, deviceId);
}

// https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app#main-process-mainjs
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("ternary", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("ternary");
}

export async function onReady() {
  try {
    const backupManager = new BackupManager({
      settingsFile: getSettingsFilePath(),
      dbFile: getDatabasePath(),
    });
    await backupManager.initialize();
  } catch (e) {
    logger.error("Error initializing backup manager", e);
  }
  initializeDatabase();
  const settings = readSettings();
  await onFirstRunMaybe(settings);

  // Attempt to refresh appAuth from website if a device token exists
  let linkRefreshError: any = null;
  try {
    const token = settings.appAuth?.token?.value;
    if (token) {
      await fetchAndUpdateAppAuthFromToken(token, settings.appAuth?.deviceId);
    }
  } catch (err) {
    linkRefreshError = err;
    logger.warn("Device link refresh failed on startup:", err);
    // Mark as stale and disable Pro so UI doesn't assume entitlement
    writeSettings({
      appAuth: {
        ...readSettings().appAuth,
        status: "stale",
      },
      enableTernaryPro: false,
    });
  }

  createWindow();

  logger.info("Auto-update enabled=", settings.enableAutoUpdate);
  if (settings.enableAutoUpdate) {
    // Technically we could just pass the releaseChannel directly to the host,
    // but this is more explicit and falls back to stable if there's an unknown
    // release channel.
    const postfix = settings.releaseChannel === "beta" ? "beta" : "stable";
    const host = `https://ternary-pre-domain.vercel.app/v1/update/${postfix}`;
    logger.info("Auto-update release channel=", postfix);
    updateElectronApp({
      logger,
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: "ternarystudio/ternary",
        host,
      },
    }); // additional configuration options available
  }
  // Notify renderer if link refresh failed
  if (linkRefreshError) {
    mainWindow?.webContents.send("deep-link-received", {
      type: "link/refresh-failed",
      message: String(linkRefreshError),
    });
  }
}

export async function onFirstRunMaybe(settings: UserSettings) {
  if (!settings.hasRunBefore) {
    await promptMoveToApplicationsFolder();
    writeSettings({
      hasRunBefore: true,
    });
  }
  if (IS_TEST_BUILD) {
    writeSettings({
      isTestMode: true,
    });
  }
}

/**
 * Ask the user if the app should be moved to the
 * applications folder.
 */
async function promptMoveToApplicationsFolder(): Promise<void> {
  // Why not in e2e tests?
  // There's no way to stub this dialog in time, so we just skip it
  // in e2e testing mode.
  if (IS_TEST_BUILD) return;
  if (process.platform !== "darwin") return;
  if (app.isInApplicationsFolder()) return;
  logger.log("Prompting user to move to applications folder");

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications Folder", "Do Not Move"],
    defaultId: 0,
    message: "Move to Applications Folder? (required for auto-update)",
  });

  if (response === 0) {
    logger.log("User chose to move to applications folder");
    app.moveToApplicationsFolder();
  } else {
    logger.log("User chose not to move to applications folder");
  }
}

declare global {
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: process.env.NODE_ENV === "development" ? 1280 : 960,
    minWidth: 800,
    height: 700,
    minHeight: 500,
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    trafficLightPosition: {
      x: 10,
      y: 8,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      // transparent: true,
    },
    // backgroundColor: "#00000001",
    // frame: false,
  });
  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, "../renderer/main_window/index.html"),
    );
  }
  if (process.env.NODE_ENV === "development") {
    // Open the DevTools.
    mainWindow.webContents.openDevTools();
  }
};

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // the commandLine is array of strings in which last element is deep link url
    handleDeepLinkReturn(commandLine.pop()!);
  });
  app.whenReady().then(onReady);
}

// Handle the protocol. In this case, we choose to show an Error Box.
app.on("open-url", (event, url) => {
  handleDeepLinkReturn(url);
});

function handleDeepLinkReturn(url: string) {
  // example url: "ternary://supabase-oauth-return?token=a&refreshToken=b"
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log.info("Invalid deep link URL", url);
    return;
  }
  // ternary://link/callback?status=ok&token=...&device_id=...
  if (parsed.hostname === "link" && parsed.pathname === "/callback") {
    const status = parsed.searchParams.get("status");
    const token = parsed.searchParams.get("token");
    const deviceId = parsed.searchParams.get("device_id");
    if (status !== "ok" || !token) {
      dialog.showErrorBox(
        "Invalid URL",
        "Expected status=ok and token for device linking callback",
      );
      return;
    }
    void handleDeviceLinkCallback({ token, deviceId: deviceId || undefined })
      .then(() => {
        mainWindow?.webContents.send("deep-link-received", {
          type: "link/callback",
        });
      })
      .catch((e) => {
        logger.error("Error handling device link callback", e);
        dialog.showErrorBox(
          "Link Failed",
          `There was an error linking this device: ${String(e)}`,
        );
      });
    return;
  }

  // Intentionally do NOT log the full URL which may contain sensitive tokens.
  log.log(
    "Handling deep link: protocol",
    parsed.protocol,
    "hostname",
    parsed.hostname,
  );
  if (parsed.protocol !== "ternary:") {
    dialog.showErrorBox(
      "Invalid Protocol",
      `Expected ternary://, got ${parsed.protocol}. Full URL: ${url}`,
    );
    return;
  }
  if (parsed.hostname === "neon-oauth-return") {
    const token = parsed.searchParams.get("token");
    const refreshToken = parsed.searchParams.get("refreshToken");
    const expiresIn = Number(parsed.searchParams.get("expiresIn"));
    if (!token || !refreshToken || !expiresIn) {
      dialog.showErrorBox(
        "Invalid URL",
        "Expected token, refreshToken, and expiresIn",
      );
      return;
    }
    handleNeonOAuthReturn({ token, refreshToken, expiresIn });
    // Send message to renderer to trigger re-render
    mainWindow?.webContents.send("deep-link-received", {
      type: parsed.hostname,
    });
    return;
  }
  if (parsed.hostname === "supabase-oauth-return") {
    const token = parsed.searchParams.get("token");
    const refreshToken = parsed.searchParams.get("refreshToken");
    const expiresIn = Number(parsed.searchParams.get("expiresIn"));
    if (!token || !refreshToken || !expiresIn) {
      dialog.showErrorBox(
        "Invalid URL",
        "Expected token, refreshToken, and expiresIn",
      );
      return;
    }
    handleSupabaseOAuthReturn({ token, refreshToken, expiresIn });
    // Send message to renderer to trigger re-render
    mainWindow?.webContents.send("deep-link-received", {
      type: parsed.hostname,
    });
    return;
  }
  // ternary://ternary-pro-return?key=123&budget_reset_at=2025-05-26T16:31:13.492000Z&max_budget=100
  if (parsed.hostname === "ternary-pro-return") {
    const apiKey = parsed.searchParams.get("key");
    if (!apiKey) {
      dialog.showErrorBox("Invalid URL", "Expected key");
      return;
    }
    handleTernaryProReturn({
      apiKey,
    });
    // Send message to renderer to trigger re-render
    mainWindow?.webContents.send("deep-link-received", {
      type: parsed.hostname,
    });
    return;
  }
  dialog.showErrorBox("Invalid deep link URL", url);
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
