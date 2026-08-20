function asyncHandler(handler) {
  return function handledAsyncRoute(req, res, next) {
    return Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
