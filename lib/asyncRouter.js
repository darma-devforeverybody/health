const express = require('express');
const asyncHandler = require('./asyncHandler');

// Wraps every handler registered on this router with asyncHandler, so a
// rejected promise becomes a normal Express error instead of crashing the
// process — without having to wrap each route body individually.
module.exports = function asyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => original(path, ...handlers.map(asyncHandler));
  }
  return router;
};
