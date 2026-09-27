import { powerSaveBlocker, type WebContents } from "electron";

/*
  A lesson is audio: the tutor talks, the pointer moves, and the student's hands are
  off the keyboard and mouse for minutes at a time. On a Mac that is exactly when the
  display goes to sleep. So while any tab is making sound, the display is kept awake,
  and for a little while after the last one goes quiet (the tutor pauses between
  sentences and while a clip is fetched; a question takes a few seconds to answer).
*/

const RELEASE_AFTER_MS = 60 * 1000;

let blockerId: number | null = null;
let releaseTimer: NodeJS.Timeout | undefined;
const audible = new Set<number>();

function keepAwake(): void {
  clearTimeout(releaseTimer);
  releaseTimer = undefined;
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return;
  blockerId = powerSaveBlocker.start("prevent-display-sleep");
}

function releaseSoon(): void {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = undefined;
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }, RELEASE_AFTER_MS);
  releaseTimer.unref();
}

function update(): void {
  if (audible.size > 0) keepAwake();
  else releaseSoon();
}

export function isKeepingScreenAwake(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
}

/** Keep the display awake while this page plays sound. */
export function watchLessonAudio(contents: WebContents): void {
  const id = contents.id;
  contents.on("audio-state-changed", (event) => {
    if (event.audible) audible.add(id);
    else audible.delete(id);
    update();
  });
  contents.once("destroyed", () => {
    if (audible.delete(id)) update();
  });
}
