const util = require('util');
const repl = require('repl');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { isatty } = require('tty');
const assets_dir =
  process.env.PRYBAR_ASSETS_DIR || path.join(process.cwd(), 'prybar_assets');
const rl = require(path.join(assets_dir, 'nodejs', 'input-sync.js'));
const Module = require('module');

let r;
if (!process.env.PRYBAR_QUIET) {
  console.log('Node ' + process.version + ' on ' + process.platform);
}

const isTTY = isatty(process.stdin.fd);

// Red errors (if stdout is a TTY)
function logError(msg) {
  if (isTTY) {
    process.stdout.write(`\u001b[0m\u001b[31m${msg}\u001b[0m`);
  } else {
    process.stdout.write(msg);
  }
}

// The nodejs repl operates in raw mode and does some funky stuff to
// the terminal. This ns the repl and forces non-raw mode.
function pauseRepl() {
  if (!r) return;

  r.pause();
}

// Forces raw mode and resumes the repl.
function resumeRepl() {
  if (!r) return;
  r.resume();
}

// Clear the line if it has anything on it.
function clearLine() {
  if (isTTY && r && r.line) r.clearLine();
}

// Adapted from the internal node repl code just a lot simpler and adds
// red errors (see https://bit.ly/2FRM86S)
function handleError(e) {
  if (r) {
    r.lastError = e;
  }

  if (e && typeof e === 'object' && e.stack && e.name) {
    if (e.name === 'SyntaxError') {
      e.stack = e.stack
        .replace(/^repl:\d+\r?\n/, '')
        .replace(/^\s+at\s.*\n?/gm, '');
    }

    logError(e.stack);
  } else {
    // For some reason needs a newline to flush.
    logError('Thrown: ' + r.writer(e) + '\n');
  }

  if (r) {
    r.clearBufferedCommand();
    r.lines.level = [];
    r.displayPrompt();
  }
}

const sandbox = {
  // The console in the context doesn't bind to our stdout
  console,
  // Browser stdio polyfills
  alert: console.log,
  prompt: (p) => {
    pauseRepl();
    clearLine();

    let ret = rl.question(`${p}> `);

    resumeRepl();

    // Display prompt on the next turn.
    if (r) setImmediate(() => r.displayPrompt());

    return ret;
  },
  confirm: (q) => {
    pauseRepl();
    clearLine();

    const ret = rl.keyInYNStrict(q);

    resumeRepl();

    // Display prompt on the next turn.
    if (r) setImmediate(() => r.displayPrompt());
    return ret;
  },
};

const mainPath = process.env.PRYBAR_FILE
  ? path.resolve(process.env.PRYBAR_FILE)
  : null;

if (mainPath) {
  // Make module resolution stuff work as if we're running
  // `node mainPath`
  const module = new Module(mainPath, null);
  module.id = '.';
  module.filename = mainPath;
  module.paths = Module._nodeModulePaths(path.dirname(mainPath));

  process.mainModule = module;

  sandbox.module = module;
  sandbox.require = module.require.bind(module);
  sandbox.__dirname = path.dirname(mainPath);
  sandbox.__filename = mainPath;
}

const context = vm.createContext(sandbox);
// VM context doesn't have a built-in "global", so we
// have to tell it to point to itself
Object.defineProperties(context, {
  global: {
    ...Object.getOwnPropertyDescriptor(global, 'global'),
    value: context,
  },
  globalThis: {
    ...Object.getOwnPropertyDescriptor(global, 'globalThis'),
    value: context,
  },
  GLOBAL: {
    ...Object.getOwnPropertyDescriptor(global, 'GLOBAL'),
    get: util.deprecate(
      () => context,
      `'GLOBAL' is deprecated, use 'global'`,
      'DEP0016',
    ),
    set: util.deprecate(
      (value) => {
        Object.defineProperty(context, 'GLOBAL', {
          configurable: true,
          writable: true,
          enumerable: true,
          value: value,
        });
      },
      `'GLOBAL' is deprecated, use 'global'`,
      'DEP0016',
    ),
  },
  root: {
    ...Object.getOwnPropertyDescriptor(global, 'root'),
    get: util.deprecate(
      () => context,
      `'root' is deprecated, use 'global'`,
      'DEP0016',
    ),
    set: util.deprecate(
      (value) => {
        Object.defineProperty(context, 'root', {
          configurable: true,
          writable: true,
          enumerable: true,
          value: value,
        });
      },
      `'root' is deprecated, use 'global'`,
      'DEP0016',
    ),
  },
});

// Fill in all the missing globals in the context.
// We have to activate the runtime to actually get
// a list of globals available on this context
const contextGlobals = vm.runInContext(
  'Object.getOwnPropertyNames(global)',
  context,
);
const localGlobals = Object.getOwnPropertyNames(global);
for (let prop of localGlobals) {
  if (contextGlobals.includes(prop)) {
    continue;
  }

  Object.defineProperty(
    context,
    prop,
    Object.getOwnPropertyDescriptor(global, prop),
  );
}

function startRepl() {
  r = repl.start({
    prompt: process.env.PRYBAR_PS1,
  });

  const replContext = r.context;
  r.context = context;

  if (!mainPath) {
    // Since we don't have a mainpath, we will use
    // module resolution that's built into the repl
    r.context.require = replContext.require;
    r.context.module = replContext.module;
  }

  // remove the internal error and ours for red etc.
  r._domain.removeListener('error', r._domain.listeners('error')[0]);
  r._domain.on('error', handleError);
  process.on('uncaughtException', handleError);
}

if (mainPath) {
  const main = fs.readFileSync(mainPath, 'utf-8');

  let script;
  try {
    script = new vm.Script(main, {
      filename: mainPath,
      displayErrors: false,
    });
  } catch (e) {
    handleError(e);
  }

  if (script) {
    let res;
    try {
      res = script.runInContext(context, {
        displayErrors: false,
      });
    } catch (e) {
      handleError(e);
    }

    module.loaded = true;

    if (typeof res !== 'undefined') {
      console.log(util.inspect(res, { colors: true }));
    }
  }

  if (isTTY && process.env.PRYBAR_INTERACTIVE) {
    console.log(
      '\u001b[0m\u001b[90mHint: hit control+c anytime to enter REPL.\u001b[0m',
    );
  }

  if (process.env.PRYBAR_INTERACTIVE) {
    process.once('SIGINT', () => startRepl());
    process.once('beforeExit', () => startRepl());
  }
} else {
  const code = process.env.PRYBAR_CODE || process.env.PRYBAR_EXP;

  if (code) {
    const result = vm.runInContext(code, context, {
      breakOnSigint: isTTY || process.env.PRYBAR_INTERACTIVE,
    });

    if (process.env.PRYBAR_EXP) {
      console.log(result);
    }
  }

  if (process.env.PRYBAR_INTERACTIVE) {
    startRepl();
  }
}
