import { chooseAIAction } from '../ai.js';
import type { Game } from '../engine.js';
self.onmessage = (event: MessageEvent<Game>) => {
  try { self.postMessage({ action: chooseAIAction(event.data).action }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
