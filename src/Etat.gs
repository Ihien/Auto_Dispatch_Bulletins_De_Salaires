/**
 * Module 1 — Persistance de l'état et déclencheurs de reprise (Batching Engine).
 */

var CLE_ETAT = 'ETAT_TRAITEMENT';
var CLE_DERNIER_RAPPORT = 'DERNIER_RAPPORT';
var FONCTION_REPRISE = 'traiterLot';

var STATUTS_TRAITEMENT = {
  EN_COURS: 'EN_COURS',
  EN_ATTENTE_QUOTA: 'EN_ATTENTE_QUOTA',
  ECHEC: 'ECHEC'
};

function lireEtat_() {
  var brut = PropertiesService.getScriptProperties().getProperty(CLE_ETAT);
  return brut ? JSON.parse(brut) : null;
}

function sauvegarderEtat_(etat) {
  PropertiesService.getScriptProperties().setProperty(CLE_ETAT, JSON.stringify(etat));
}

function purgerEtat_() {
  PropertiesService.getScriptProperties().deleteProperty(CLE_ETAT);
}

function supprimerDeclencheurs_() {
  ScriptApp.getProjectTriggers().forEach(function (declencheur) {
    if (declencheur.getHandlerFunction() === FONCTION_REPRISE) {
      ScriptApp.deleteTrigger(declencheur);
    }
  });
}

/** Remplace tout déclencheur de reprise existant par un seul, à la date donnée. */
function planifierReprise_(date) {
  supprimerDeclencheurs_();
  ScriptApp.newTrigger(FONCTION_REPRISE).timeBased().at(date).create();
  console.log('Reprise planifiée le ' + date.toISOString());
}

/**
 * Le quota Gmail se renouvelle sur 24 h glissantes : première tentative le
 * lendemain à HEURE_REPRISE_QUOTA, puis toutes les deux heures si besoin.
 */
function dateRepriseQuota_(config, maintenant, dejaEnAttente) {
  if (dejaEnAttente) return new Date(maintenant.getTime() + 2 * 60 * 60 * 1000);
  var date = new Date(maintenant.getTime());
  date.setDate(date.getDate() + 1);
  date.setHours(config.HEURE_REPRISE_QUOTA, 0, 0, 0);
  return date;
}

function nouvelEtat_(fichier, periode, arborescence, journalId, idTraitement) {
  return {
    id: idTraitement,
    statut: STATUTS_TRAITEMENT.EN_COURS,
    fichierId: fichier.getId(),
    fichierNom: fichier.getName(),
    periode: periode,
    dossierMoisId: arborescence.mois.getId(),
    dossierAnomaliesId: arborescence.anomalies.getId(),
    journalId: journalId,
    nbPages: null,
    pageSuivante: 0,
    lots: 0,
    echecsConsecutifs: 0,
    debut: new Date().toISOString(),
    compteurs: { archives: 0, envoyes: 0, anomalies: 0, echecsEnvoi: 0, erreurs: 0 }
  };
}
