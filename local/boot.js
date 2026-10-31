/* Drop Off · on-device mode loader (only in builds made by devserver/build-local.mjs).
   Creates the promise the app's Supabase client waits on while local/backend.mjs starts Postgres in the page. */
(function () {
  var cfg = window.DO_CONFIG || {};
  if (!cfg.local) return;
  var resolve, reject;
  var ready = new Promise(function (a, b) { resolve = a; reject = b; });
  window.DO_LOCAL = {
    ready: ready, resolve: resolve, reject: reject, status: 'starting',
    fetch: function (input, init) { return ready.then(function (be) { return be.fetch(input, init); }); }
  };
})();
