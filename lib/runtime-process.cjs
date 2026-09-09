'use strict';

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);

  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once('exit', onExit);

    // The child may have exited between the first check and listener setup.
    if (hasExited(child)) finish(true);
  });
}

async function terminateChild(child, options) {
  const graceMs = options && options.graceMs !== undefined ? options.graceMs : 900;
  const forceMs = options && options.forceMs !== undefined ? options.forceMs : 300;

  if (!child) return { exited: true, forced: false, signal: null };
  if (hasExited(child)) {
    return { exited: true, forced: false, signal: child.signalCode || null };
  }

  child.kill('SIGTERM');
  if (await waitForExit(child, graceMs)) {
    return { exited: true, forced: false, signal: child.signalCode || null };
  }

  // child.killed only means kill() successfully sent a signal. It is not
  // evidence that the operating-system process exited.
  child.kill('SIGKILL');
  if (await waitForExit(child, forceMs)) {
    return { exited: true, forced: true, signal: child.signalCode || null };
  }

  throw new Error(`game runtime did not exit after SIGTERM (${graceMs}ms) and SIGKILL (${forceMs}ms)`);
}

module.exports = {
  hasExited,
  terminateChild,
  waitForExit,
};
