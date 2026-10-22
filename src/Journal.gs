/**
 * Journal d'audit : une ligne par page traitée, dans un Google Sheet créé
 * à côté des bulletins du mois (Racine / AAAA / MM / Journal_Envois_...).
 */

var ENTETES_JOURNAL = ['Horodatage', 'Traitement', 'Page', 'Matricule', 'Statut',
  'Fichier', 'ID fichier Drive', 'Destinataire', 'Détail'];

var STATUTS = {
  ENVOYE: 'ENVOYE',
  ANOMALIE: 'ANOMALIE',
  ECHEC_ENVOI: 'ECHEC_ENVOI',
  ERREUR: 'ERREUR'
};

function creerJournal_(dossierMois, periode, idTraitement) {
  var classeur = SpreadsheetApp.create('Journal_Envois_' + periode.annee + '_' + periode.mois + '_' + idTraitement);
  var feuille = classeur.getSheets()[0];
  feuille.setName('Journal');
  feuille.getRange(1, 1, 1, ENTETES_JOURNAL.length).setValues([ENTETES_JOURNAL]).setFontWeight('bold');
  feuille.setFrozenRows(1);
  DriveApp.getFileById(classeur.getId()).moveTo(dossierMois);
  return classeur.getId();
}

/** Écrit en une seule opération les lignes accumulées pendant le lot. */
function ecrireJournal_(journalId, lignes) {
  if (!journalId || !lignes.length) return;
  try {
    var feuille = SpreadsheetApp.openById(journalId).getSheets()[0];
    feuille.getRange(feuille.getLastRow() + 1, 1, lignes.length, ENTETES_JOURNAL.length).setValues(lignes);
  } catch (e) {
    // Le journal ne doit jamais interrompre la paie : les journaux d'exécution font foi.
    console.error('Écriture du journal impossible : ' + e.message);
  }
}

function ligneJournal_(etat, numeroPage, matricule, statut, fichier, destinataire, detail) {
  return [
    new Date(),
    etat.id,
    numeroPage,
    matricule || '',
    statut,
    fichier ? fichier.getName() : '',
    fichier ? fichier.getId() : '',
    destinataire || '',
    detail || ''
  ];
}
