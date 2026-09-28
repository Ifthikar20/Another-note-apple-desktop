import { EventEmitter } from "node:events";

/**
 * Events between the app's modules. "lists-changed": the server confirmed a change to
 * what the web app's lists show (a note made, renamed or deleted, a session made, a
 * folder changed). renderer.ts sees every API call and emits it; windows.ts refreshes
 * the pages that are out of sight so their sidebars and dashboards stay current.
 */
export const appEvents = new EventEmitter();
