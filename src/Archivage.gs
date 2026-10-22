/**
 * Module 3 — Structuration chronologique dynamique (Racine / AAAA / MM).
 * Aucun identifiant de dossier mensuel n'est stocké en configuration : les
 * dossiers sont retrouvés par leur nom sous la racine, ou créés à la volée.
 */

/** Période d'archivage { annee: 'AAAA', mois: 'MM' }. */
function determinerPeriode_(config, maintenant) {
  if (config.PERIODE) {
    var morceaux = config.PERIODE.split('-');
    return { annee: morceaux[0], mois: morceaux[1] };
  }
  var fuseau = Session.getScriptTimeZone();
  return {
    annee: Utilities.formatDate(maintenant, fuseau, 'yyyy'),
    mois: Utilities.formatDate(maintenant, fuseau, 'MM')
  };
}

function obtenirOuCreerSousDossier_(parent, nom) {
  var existants = parent.getFoldersByName(nom);
  if (existants.hasNext()) return existants.next();
  return parent.createFolder(nom);
}

/** Règle 3 — valide ou crée Racine / AAAA / MM et le dossier d'anomalies. */
function preparerArborescence_(config, periode) {
  var racine = DriveApp.getFolderById(config.DOSSIER_RACINE_ID);
  var dossierAnnee = obtenirOuCreerSousDossier_(racine, periode.annee);
  var dossierMois = obtenirOuCreerSousDossier_(dossierAnnee, periode.mois);
  var dossierAnomalies = obtenirOuCreerSousDossier_(dossierMois, config.NOM_DOSSIER_ANOMALIES);
  return { mois: dossierMois, anomalies: dossierAnomalies };
}

/** Retourne l'unique PDF présent dans le dossier source. */
function trouverPdfMaitre_(config) {
  var dossier = DriveApp.getFolderById(config.DOSSIER_SOURCE_ID);
  var fichiers = dossier.getFilesByType('application/pdf');
  var trouves = [];
  while (fichiers.hasNext()) trouves.push(fichiers.next());
  if (trouves.length === 0) {
    throw new Error('Aucun PDF trouvé dans le dossier source.');
  }
  if (trouves.length > 1) {
    // Refus explicite : traiter le mauvais fichier enverrait 600 courriels erronés.
    throw new Error('Plusieurs PDF dans le dossier source (' +
      trouves.map(function (f) { return f.getName(); }).join(', ') +
      '). Ne laisser que le fichier de paie à traiter.');
  }
  return trouves[0];
}

/** Déplace le PDF maître traité dans le sous-dossier des fichiers traités. */
function classerPdfMaitre_(config, fichierId) {
  var source = DriveApp.getFolderById(config.DOSSIER_SOURCE_ID);
  var traites = obtenirOuCreerSousDossier_(source, config.NOM_DOSSIER_TRAITES);
  DriveApp.getFileById(fichierId).moveTo(traites);
}

function nettoyerNomFichier_(valeur) {
  return String(valeur).replace(/[\\\/:*?"<>|\s]+/g, '-');
}

function nomBulletin_(matricule) {
  return 'Bulletin_' + nettoyerNomFichier_(matricule) + '.pdf';
}

function nomAnomalie_(numeroPage) {
  return 'Alerte_Matricule_Inconnu_Page_' + numeroPage + '.pdf';
}

function enregistrerPdf_(dossier, octets, nom) {
  var blob = Utilities.newBlob(Array.from(octets), 'application/pdf', nom);
  return dossier.createFile(blob);
}
