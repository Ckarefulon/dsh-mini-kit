/**
 * One entry point for the whole suite.
 *
 * `node --test test/` would also work, but it runs every file in a child process
 * with piped stdio, and a confined or unusual environment can refuse that. This
 * file imports the same tests into one process, so `npm test` is reproducible
 * wherever the game is being played.
 */

import './process-tree.test.mjs'
import './sessions.test.mjs'
import './marker.test.mjs'
import './restart.test.mjs'
import './plugin.test.mjs'
import './index.test.mjs'
