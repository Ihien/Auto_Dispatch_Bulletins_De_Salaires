/**
 * Mise en cache de la table de correspondance Matricule / Adresse Email.
 */

var REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Charge la table en mémoire : { MATRICULE: 'email' }.
 * Une ligne sans email valide est conservée avec une valeur vide afin que la
 * page correspondante soit routée vers les anomalies (Règle 4).
 */
function chargerAnnuaire_(config) {
  var classeur = SpreadsheetApp.openById(config.SHEET_CORRESPONDANCE_ID);
  var onglet = config.ONGLET_CORRESPONDANCE
    ? classeur.getSheetByName(config.ONGLET_CORRESPONDANCE)
    : classeur.getSheets()[0];
  if (!onglet) {
    throw new Error('Onglet « ' + config.ONGLET_CORRESPONDANCE + ' » introuvable dans la table de correspondance.');
  }
  var lignes = onglet.getDataRange().getValues();
  if (config.LIGNE_EN_TETE) lignes = lignes.slice(1);

  var annuaire = {};
  var doublons = [];
  lignes.forEach(function (ligne) {
    var matricule = normaliserMatricule_(ligne[config.COLONNE_MATRICULE - 1]);
    if (!matricule) return;
    var email = String(ligne[config.COLONNE_EMAIL - 1] || '').trim();
    if (!REGEX_EMAIL.test(email)) email = '';
    if (Object.prototype.hasOwnProperty.call(annuaire, matricule) && annuaire[matricule] !== email) {
      doublons.push(matricule);
    }
    annuaire[matricule] = email;
  });
  if (doublons.length) {
    // Ambiguïté de routage : on préfère bloquer ces matricules plutôt que de deviner.
    doublons.forEach(function (matricule) { annuaire[matricule] = ''; });
    console.warn('Matricules présents plusieurs fois avec des emails différents (envoi bloqué) : ' +
      doublons.join(', '));
  }
  return annuaire;
}

function emailPourMatricule_(annuaire, matricule) {
  if (!matricule || !Object.prototype.hasOwnProperty.call(annuaire, matricule)) return '';
  return annuaire[matricule];
}
