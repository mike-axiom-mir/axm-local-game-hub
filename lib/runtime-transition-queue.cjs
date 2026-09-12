'use strict';

class RuntimeTransitionQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('runtime transition must be a function'));
    }

    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

module.exports = {
  RuntimeTransitionQueue,
};
