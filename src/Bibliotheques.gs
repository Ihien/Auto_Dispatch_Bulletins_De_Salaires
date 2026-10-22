/**
 * Chargement des bibliothèques PDF (pdf-lib, pdf.js) dans le moteur V8
 * d'Apps Script, qui ne fournit pas les API navigateur dont elles dépendent.
 */

/**
 * Le moteur Apps Script n'a ni setTimeout, ni URL. Les minuteries sont
 * émulées par des micro-tâches : aucun traitement ne dépend d'un délai réel.
 */
function installerPolyfills_() {
  var global = globalThis;
  if (typeof global.setTimeout !== 'function') {
    global.setTimeout = function (fn) {
      var args = Array.prototype.slice.call(arguments, 2);
      Promise.resolve().then(function () { fn.apply(null, args); });
      return 0;
    };
    global.clearTimeout = function () {};
  }
  if (typeof global.URL !== 'function') {
    // pdf.js teste « x instanceof URL » ; les constructions réelles sont
    // toutes protégées par try/catch et ne concernent que les liens.
    global.URL = function URL() { throw new Error('URL indisponible dans Apps Script'); };
  }
}

/** Télécharge, vérifie et évalue les bibliothèques (une fois par exécution). */
function chargerBibliotheques_() {
  if (globalThis.PDFLib && globalThis.pdfjsLib) return;
  installerPolyfills_();
  BIBLIOTHEQUES.forEach(function (lib) {
    var reponse = UrlFetchApp.fetch(lib.url, { muteHttpExceptions: true });
    if (reponse.getResponseCode() !== 200) {
      throw new Error('Téléchargement impossible de ' + lib.nom + ' (HTTP ' + reponse.getResponseCode() + ').');
    }
    var empreinte = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, reponse.getContent()));
    if (empreinte !== lib.sha256) {
      throw new Error('Empreinte SHA-256 inattendue pour ' + lib.nom + ' : chargement refusé.');
    }
    // Évaluation indirecte : le code s'exécute dans la portée globale.
    (0, eval)(reponse.getContentText());
  });
  if (!globalThis.PDFLib || !globalThis.pdfjsLib || !globalThis.pdfjsWorker) {
    throw new Error('Bibliothèques PDF chargées mais non initialisées.');
  }
}
