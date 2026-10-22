/**
 * Configuration du traitement des bulletins de salaire.
 *
 * Les valeurs par défaut ci-dessous peuvent être surchargées sans modifier le
 * code, via « Paramètres du projet > Propriétés du script » (même clé).
 * Les trois identifiants marqués OBLIGATOIRE doivent être renseignés.
 */
var CONFIG_DEFAUT = {
  // OBLIGATOIRE — dossier Drive où est déposé le PDF maître (un seul PDF à la fois).
  DOSSIER_SOURCE_ID: '',
  // OBLIGATOIRE — dossier racine de l'archivage (Racine / AAAA / MM).
  DOSSIER_RACINE_ID: '',
  // OBLIGATOIRE — Google Sheet de correspondance Matricule / Adresse Email.
  SHEET_CORRESPONDANCE_ID: '',

  // Onglet de la table de correspondance (vide = premier onglet).
  ONGLET_CORRESPONDANCE: '',
  // Colonnes (1 = A) et présence d'une ligne d'en-tête.
  COLONNE_MATRICULE: 1,
  COLONNE_EMAIL: 2,
  LIGNE_EN_TETE: true,

  // Module 2 — expression régulière de capture du matricule (groupe 1).
  REGEX_MATRICULE: 'Matricule\\s*:\\s*(\\w+)',

  // Période d'archivage forcée au format AAAA-MM (vide = date courante).
  PERIODE: '',

  NOM_DOSSIER_ANOMALIES: 'Anomalies',
  NOM_DOSSIER_TRAITES: '_Traites',
  CREER_JOURNAL: true,

  // Module 1 — budget de temps par exécution (la limite Google est de 6 min).
  BUDGET_TEMPS_MS: 5 * 60 * 1000,
  // Limite facultative de pages par lot (0 = aucune), utile pour un pilote.
  MAX_PAGES_PAR_LOT: 0,
  DELAI_REPRISE_MS: 60 * 1000,
  HEURE_REPRISE_QUOTA: 1,
  MAX_ECHECS_CONSECUTIFS: 3,

  // Courriel. Variables disponibles : {matricule} {mois} {annee} {nomMois}.
  EXPEDITEUR_NOM: 'Service des Ressources Humaines',
  EMAIL_REPONSE: '',
  OBJET_EMAIL: 'Votre bulletin de salaire - {nomMois} {annee}',
  CORPS_EMAIL:
    'Bonjour,\n\n' +
    'Veuillez trouver ci-joint votre bulletin de salaire du mois de {nomMois} {annee} ' +
    '(matricule {matricule}).\n\n' +
    'Ce document est strictement personnel et confidentiel. ' +
    'Pour toute question, contactez le Service des Ressources Humaines.\n\n' +
    'Cordialement,\nLe Service des Ressources Humaines',
  // Mode test : si renseigné, TOUS les courriels sont envoyés à cette adresse.
  EMAIL_REDIRECTION: '',
  // Destinataire du rapport de fin de traitement (vide = compte exécutant).
  EMAIL_RAPPORT: ''
};

/**
 * Bibliothèques chargées depuis le CDN, dans l'ordre d'évaluation.
 * Chaque fichier est vérifié par empreinte SHA-256 avant exécution : un
 * contenu modifié côté CDN est refusé.
 */
var BIBLIOTHEQUES = [
  {
    nom: 'web-streams-polyfill 3.3.3',
    url: 'https://cdn.jsdelivr.net/npm/web-streams-polyfill@3.3.3/dist/polyfill.min.js',
    sha256: 'g500ruWAwC/bUXRIHO+6SbsI8jp6kbyhVqnIM0KTDK8='
  },
  {
    nom: 'pdf-lib 1.17.1',
    url: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
    sha256: 'D5pcrQeUHwgmWGyU4InYm5GMRuXBfPLVo8b2ZuO8aU8='
  },
  {
    nom: 'pdf.js worker 2.16.105',
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/legacy/build/pdf.worker.min.js',
    sha256: 'Gb9+1c39vpgKaOUJa7IKuYYr6OZdmuT4KsGNK8+su0A='
  },
  {
    nom: 'pdf.js 2.16.105',
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/legacy/build/pdf.min.js',
    sha256: 'bDOb6ru3SpcFYIKEuXFVETu+/hzgAR3Avz0luNxrMu4='
  }
];

var NOMS_MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Retourne la configuration effective (défauts + propriétés du script). */
function lireConfig_() {
  var proprietes = PropertiesService.getScriptProperties().getProperties();
  var config = {};
  Object.keys(CONFIG_DEFAUT).forEach(function (cle) {
    var defaut = CONFIG_DEFAUT[cle];
    var valeur = Object.prototype.hasOwnProperty.call(proprietes, cle) ? proprietes[cle] : undefined;
    if (valeur === undefined || valeur === null) {
      config[cle] = defaut;
    } else if (typeof defaut === 'number') {
      config[cle] = Number(valeur);
    } else if (typeof defaut === 'boolean') {
      config[cle] = String(valeur).toLowerCase() === 'true';
    } else {
      config[cle] = String(valeur);
    }
  });
  return config;
}

/** Vérifie que la configuration est exploitable ; lève une erreur sinon. */
function validerConfig_(config) {
  var erreurs = [];
  ['DOSSIER_SOURCE_ID', 'DOSSIER_RACINE_ID', 'SHEET_CORRESPONDANCE_ID'].forEach(function (cle) {
    if (!config[cle]) erreurs.push(cle + ' n\'est pas renseigné.');
  });
  try {
    compilerRegexMatricule_(config.REGEX_MATRICULE);
  } catch (e) {
    erreurs.push('REGEX_MATRICULE invalide : ' + e.message);
  }
  if (config.PERIODE && !/^\d{4}-(0[1-9]|1[0-2])$/.test(config.PERIODE)) {
    erreurs.push('PERIODE doit être au format AAAA-MM (ex. 2026-10).');
  }
  if (erreurs.length) {
    throw new Error('Configuration incomplète :\n- ' + erreurs.join('\n- '));
  }
}
