import { contextBridge, ipcRenderer } from "electron";

/*
  The bridge for the window's toolbar (static/toolbar.html): it is told what to draw and
  sends back what was clicked. Only the toolbar page gets this; the web app's tabs have
  their own bridge (index.ts).
*/

type Command = "select" | "close" | "new" | "back" | "forward";

// Not "toolbar": the page already has a built-in window.toolbar, which cannot be replaced.
contextBridge.exposeInMainWorld(
  "tabbar",
  Object.freeze({
    onState: (draw: (state: unknown) => void): void => {
      ipcRenderer.on("tabs:state", (_event, state: unknown) => draw(state));
      ipcRenderer.send("tabs:command", "ready");
    },
    send: (command: Command, id?: number): void => {
      ipcRenderer.send("tabs:command", command, typeof id === "number" ? id : undefined);
    },
  }),
);
