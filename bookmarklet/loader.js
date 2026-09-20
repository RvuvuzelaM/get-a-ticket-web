// Loaded by the bookmarklet into a page of ebilet.intercity.pl. The dashboard
// goes into a same-origin iframe on top of the page: its requests carry the
// web app's Origin, the e-IC page underneath keeps running untouched, and
// neither side's CSS or JS can reach the other.
(function () {
  var FRAME_ID = "get-a-ticket";
  var EIC = "https://ebilet.intercity.pl/";
  var base = new URL(".", document.currentScript.src).href;

  if (location.origin + "/" !== EIC) {
    if (confirm("Get a ticket działa tylko na stronie ebilet.intercity.pl.\nOtworzyć ją teraz? Po załadowaniu kliknij zakładkę jeszcze raz.")) location.href = EIC;
    return;
  }
  // A second click on the bookmark closes the dashboard.
  var old = document.getElementById(FRAME_ID);
  if (old) { old.remove(); return; }

  var frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.title = "Get a ticket";
  frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:#fff";
  document.body.appendChild(frame);

  var fresh = "?" + Date.now(); // the static host may cache for long; the app changes with e-IC
  var doc = frame.contentDocument;
  doc.open();
  doc.write('<!doctype html><html lang="pl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Get a ticket</title>' +
    '<link rel="stylesheet" href="' + base + '../style.css' + fresh + '"></head><body>' +
    '<script src="' + base + '../vendor/mustache.min.js"><\/script>' +
    '<script src="' + base + 'core.js' + fresh + '"><\/script>' +
    '<script src="' + base + 'app.js' + fresh + '"><\/script></body></html>');
  doc.close();
})();
