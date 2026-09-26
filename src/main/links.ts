import { shell } from "electron";

/** Open a link in the system browser. Only web and mail links; never file: or custom schemes. */
export function openExternal(url: string): void {
  if (!/^(https?|mailto):/i.test(url)) return;
  void shell.openExternal(url);
}
