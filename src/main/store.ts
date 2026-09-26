import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";

/** The main window's last size and position, so it opens where it was closed. */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 820, maximized: false };

const stateFile = (): string => path.join(app.getPath("userData"), "window-state.json");

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Read the saved state; fall back to defaults when there is none, or when the saved
 *  position is on a display that is no longer connected. */
export function loadWindowState(): WindowState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Partial<WindowState>;
    if (!isNumber(raw.width) || !isNumber(raw.height) || raw.width < 600 || raw.height < 400) return DEFAULT_STATE;
    const state: WindowState = { width: raw.width, height: raw.height, maximized: raw.maximized === true };
    if (isNumber(raw.x) && isNumber(raw.y)) {
      const rect: Rectangle = { x: raw.x, y: raw.y, width: state.width, height: state.height };
      if (screen.getAllDisplays().some((d) => intersects(d.workArea, rect))) {
        state.x = raw.x;
        state.y = raw.y;
      }
    }
    return state;
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds();
    const state: WindowState = { ...bounds, maximized: win.isMaximized() };
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch (e) {
    console.warn("[anothernotes] could not save the window state:", e);
  }
}
