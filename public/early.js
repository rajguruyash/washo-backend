/* Starts the three requests every first screen needs (who is signed in, the rate card, the campaign banner) the moment the page is parsed, instead
   of after the app's code has been downloaded and run. The app picks the answers up from here (src/lib/http.ts). Plain, tiny and safe: if anything
   about it fails, the app simply asks for them itself. */
(function () {
  try {
    var early = (window.__early = { at: Date.now() });
    ['/me', '/catalog', '/campaign'].forEach(function (path) {
      early[path] = fetch('/api' + path, { credentials: 'same-origin' });
      early[path].catch(function () {});
    });
  } catch {
    /* the app asks for them itself */
  }
})();
