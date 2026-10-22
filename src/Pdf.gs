/**
 * Module 2 — Extraction documentaire (pdf.js) et découpage physique (pdf-lib).
 */

/** Ouvre le PDF maître avec les deux bibliothèques. */
async function ouvrirPdfMaitre_(fichier) {
  var octets = new Uint8Array(fichier.getBlob().getBytes());
  var docDecoupe = await PDFLib.PDFDocument.load(octets);
  // pdf.js transfère le tampon qu'on lui donne : on lui passe une copie.
  var docTexte = await pdfjsLib.getDocument({
    data: octets.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0
  }).promise;
  if (docDecoupe.getPageCount() !== docTexte.numPages) {
    throw new Error('Nombre de pages incohérent entre pdf-lib (' + docDecoupe.getPageCount() +
      ') et pdf.js (' + docTexte.numPages + ').');
  }
  return { docDecoupe: docDecoupe, docTexte: docTexte, nbPages: docTexte.numPages };
}

/** Variantes textuelles d'une page (index 0), de la plus fidèle à la plus brute. */
async function extraireTextePage_(pdf, index) {
  var page = await pdf.docTexte.getPage(index + 1);
  var contenu = await page.getTextContent();
  page.cleanup();
  return [
    reconstruireLignes_(contenu.items),
    contenu.items.map(function (item) { return item.str || ''; }).join(' ')
  ];
}

/**
 * Recompose le texte ligne par ligne à partir des positions des fragments.
 * Certains générateurs de paie découpent les mots (« Matri » + « cule ») :
 * deux fragments jointifs sur la même ligne sont recollés sans espace. Les
 * fragments « espace » que pdf.js insère lui-même sont ignorés au profit de
 * l'écart réel (une espace typographique mesure environ 0,25 à 0,3 em).
 */
function reconstruireLignes_(items) {
  var texte = '';
  var precedent = null;
  items.forEach(function (item) {
    if (!item.str || !item.str.trim() || !item.transform) return;
    var x = item.transform[4];
    var y = item.transform[5];
    var taille = Math.abs(item.transform[3]) || Math.abs(item.transform[0]) || 10;
    if (precedent) {
      if (Math.abs(y - precedent.y) > taille / 2) {
        texte += '\n';
      } else if (x - precedent.fin > taille * 0.2) {
        texte += ' ';
      }
    }
    texte += item.str;
    precedent = { y: y, fin: x + (item.width || 0) };
  });
  return texte;
}

function compilerRegexMatricule_(source) {
  var regex = new RegExp(source, 'i');
  if (new RegExp(source + '|').exec('').length < 2) {
    throw new Error('l\'expression doit contenir un groupe de capture pour le matricule.');
  }
  return regex;
}

/** Capture le matricule dans la première variante textuelle qui le contient. */
function extraireMatricule_(variantes, regex) {
  for (var i = 0; i < variantes.length; i++) {
    var resultat = regex.exec(variantes[i]);
    if (resultat && resultat[1]) return normaliserMatricule_(resultat[1]);
  }
  return null;
}

function normaliserMatricule_(valeur) {
  return String(valeur === null || valeur === undefined ? '' : valeur).trim().toUpperCase();
}

/** Règle 1 — génère un PDF ne contenant que la page demandée. */
async function extrairePage_(pdf, index) {
  var sortie = await PDFLib.PDFDocument.create();
  var pages = await sortie.copyPages(pdf.docDecoupe, [index]);
  sortie.addPage(pages[0]);
  return sortie.save();
}
