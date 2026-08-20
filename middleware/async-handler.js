function asyncHandler(handler) {
  return function handledAsyncRoute(req, res, next) {
    return Promise.resolve(handler(req, res, next)).catch(next);
  };
}

let expressAsyncSupportInstalled = false;

// Express 4 does not observe a Promise returned by an async route. Install a
// small, idempotent compatibility hook so a rejected handler always reaches
// the normal error middleware instead of becoming an unhandled rejection.
function installAsyncRouteSupport() {
  if (expressAsyncSupportInstalled) return;
  // eslint-disable-next-line global-require
  const Layer = require('express/lib/router/layer');
  const original = Layer.prototype.handle_request;
  if (original.__propertyOaAsyncSupport) {
    expressAsyncSupportInstalled = true;
    return;
  }
  function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === 'function') result.catch(next);
    } catch (error) {
      next(error);
    }
  }
  handleRequest.__propertyOaAsyncSupport = true;
  Layer.prototype.handle_request = handleRequest;
  expressAsyncSupportInstalled = true;
}

module.exports = { asyncHandler, installAsyncRouteSupport };
