// Where the worklet bundle is, and the one call that loads it.
//
// An AudioWorklet is added by URL, not by import, so a package that ships one
// has to hand the caller a URL rather than a module. `dist/` is built from
// `src/` by `npm run build`; resolving against import.meta.url means a
// bundler, a CDN and a bare <script type="module"> all find the same file.
//
// This is the only module in the library that touches Web Audio. Everything
// under it is plain computation and stays that way.

/** The classic script to hand to `audioWorklet.addModule`. */
export const workletURL = new URL("../../dist/iyagi-processor.bundle.js", import.meta.url);

/** The name `processor.js` registers it under. */
export const PROCESSOR_NAME = "iyagi-processor";

/**
 * Load the processor into a context, then make a node for it.
 *
 * ```js
 * const ctx = new AudioContext();
 * const node = await createIyagiNode(ctx);
 * node.connect(ctx.destination);
 * node.port.postMessage({ type: "load", song, bank });
 * ```
 *
 * The node's port speaks the protocol in `src/worklet/processor.js`: `load`,
 * `play`, `pause`, `stop`, `loop`, `gain`, `meters` in; `loaded`, `position`,
 * `ended`, `error` out.
 *
 * @param {BaseAudioContext} context
 * @param {AudioWorkletNodeOptions} [options]
 * @returns {Promise<AudioWorkletNode>}
 */
export async function createIyagiNode(context, options) {
  await context.audioWorklet.addModule(workletURL);
  return new AudioWorkletNode(context, PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    ...options,
  });
}
