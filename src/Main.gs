/**
 * Automatisation des bulletins de salaire : découpage du PDF maître,
 * archivage Racine / AAAA / MM et envoi individuel par courriel.
 *
 * Points d'entrée :
 *   - verifierConfiguration() : contrôle à blanc, aucun fichier ni courriel.
 *   - lancerTraitement()      : démarre le traitement du PDF du dossier source.
 *   - traiterLot()            : reprise automatique (appelée par déclencheur).
 *   - afficherEtat()          : progression du traitement en cours.
 *   - reinitialiserTraitement() : abandonne le traitement en cours.
 */

/** Démarre un nouveau traitement puis enchaîne immédiatement le premier lot. */
async function lancerTraitement() {
  var debut = Date.now();
  var config = lireConfig_();
  validerConfig_(config);

  var verrou = LockService.getScriptLock();
  if (!verrou.tryLock(10000)) throw new Error('Un lot est déjà en cours d\'exécution.');
  try {
    var etatExistant = lireEtat_();
    if (etatExistant) {
      throw new Error('Un traitement est déjà en cours (' + etatExistant.fichierNom + ', page ' +
        etatExistant.pageSuivante + '/' + (etatExistant.nbPages || '?') + ', statut ' + etatExistant.statut +
        '). Lancez traiterLot() pour le reprendre ou reinitialiserTraitement() pour l\'abandonner.');
    }
    var fichier = trouverPdfMaitre_(config);
    var maintenant = new Date();
    var periode = determinerPeriode_(config, maintenant);
    var arborescence = preparerArborescence_(config, periode);
    var idTraitement = Utilities.formatDate(maintenant, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
    var journalId = config.CREER_JOURNAL ? creerJournal_(arborescence.mois, periode, idTraitement) : '';
    sauvegarderEtat_(nouvelEtat_(fichier, periode, arborescence, journalId, idTraitement));
    console.log('Traitement ' + idTraitement + ' initialisé pour « ' + fichier.getName() + ' », période ' +
      periode.annee + '/' + periode.mois + '.');
  } finally {
    verrou.releaseLock();
  }
  await executerLot_(debut);
}

/** Gestionnaire du déclencheur temporel de reprise. */
async function traiterLot() {
  await executerLot_(Date.now());
}

async function executerLot_(debut) {
  var config = lireConfig_();
  var verrou = LockService.getScriptLock();
  if (!verrou.tryLock(10000)) {
    console.warn('Un autre lot est en cours d\'exécution : abandon de ce déclenchement.');
    return;
  }
  var etat = lireEtat_();
  if (!etat) {
    supprimerDeclencheurs_();
    verrou.releaseLock();
    console.log('Aucun traitement en cours.');
    return;
  }

  var etaitEnAttenteQuota = etat.statut === STATUTS_TRAITEMENT.EN_ATTENTE_QUOTA;
  var lignesJournal = [];
  var issue;
  try {
    issue = await traiterPages_(config, etat, debut, lignesJournal);
  } catch (e) {
    issue = 'ERREUR';
    gererErreurLot_(config, etat, e);
  } finally {
    ecrireJournal_(etat.journalId, lignesJournal);
    verrou.releaseLock();
  }

  var maintenant = new Date();
  if (issue === 'PAUSE') {
    planifierReprise_(new Date(maintenant.getTime() + config.DELAI_REPRISE_MS));
  } else if (issue === 'QUOTA') {
    etat.statut = STATUTS_TRAITEMENT.EN_ATTENTE_QUOTA;
    sauvegarderEtat_(etat);
    console.warn('Quota quotidien d\'envoi épuisé à la page ' + (etat.pageSuivante + 1) + '.');
    planifierReprise_(dateRepriseQuota_(config, maintenant, etaitEnAttenteQuota));
  } else if (issue === 'TERMINE') {
    finaliserTraitement_(config, etat);
  }
}

/**
 * Boucle principale : traite les pages à partir de l'index de reprise
 * jusqu'à la fin du document, au budget de temps ou à l'épuisement du quota.
 */
async function traiterPages_(config, etat, debut, lignesJournal) {
  chargerBibliotheques_();
  var annuaire = chargerAnnuaire_(config);
  var regex = compilerRegexMatricule_(config.REGEX_MATRICULE);
  var pdf = await ouvrirPdfMaitre_(DriveApp.getFileById(etat.fichierId));

  if (etat.nbPages === null) {
    etat.nbPages = pdf.nbPages;
  } else if (etat.nbPages !== pdf.nbPages) {
    throw new Error('Le PDF maître a changé depuis le début du traitement (' + etat.nbPages +
      ' pages attendues, ' + pdf.nbPages + ' trouvées).');
  }
  var contexte = {
    config: config,
    etat: etat,
    annuaire: annuaire,
    regex: regex,
    pdf: pdf,
    dossierMois: DriveApp.getFolderById(etat.dossierMoisId),
    dossierAnomalies: DriveApp.getFolderById(etat.dossierAnomaliesId),
    lignesJournal: lignesJournal
  };

  etat.lots++;
  etat.statut = STATUTS_TRAITEMENT.EN_COURS;
  var traitees = 0;
  console.log('Lot ' + etat.lots + ' : reprise à la page ' + (etat.pageSuivante + 1) + '/' + etat.nbPages + '.');

  while (etat.pageSuivante < etat.nbPages) {
    // Au moins une page par lot, pour garantir la progression.
    if (traitees > 0 && (Date.now() - debut >= config.BUDGET_TEMPS_MS ||
        (config.MAX_PAGES_PAR_LOT > 0 && traitees >= config.MAX_PAGES_PAR_LOT))) {
      sauvegarderEtat_(etat);
      console.log('Lot ' + etat.lots + ' interrompu après ' + traitees + ' pages (prochaine page : ' +
        (etat.pageSuivante + 1) + ').');
      return 'PAUSE';
    }
    var resultat = await traiterPage_(contexte, etat.pageSuivante);
    if (resultat.quotaEpuise) {
      sauvegarderEtat_(etat);
      return 'QUOTA';
    }
    etat.pageSuivante++;
    etat.echecsConsecutifs = 0;
    traitees++;
    // Sauvegarde après chaque page : une reprise ne renvoie jamais un bulletin déjà envoyé.
    sauvegarderEtat_(etat);
  }
  return 'TERMINE';
}

/** Traite une page : extraction, découpage, archivage, routage. */
async function traiterPage_(contexte, index) {
  var etat = contexte.etat;
  var numeroPage = index + 1;
  var matricule = null;
  var detail = '';

  try {
    var texte = await extraireTextePage_(contexte.pdf, index);
    matricule = extraireMatricule_(texte, contexte.regex);
  } catch (e) {
    detail = 'Texte illisible : ' + e.message;
  }

  var octets;
  try {
    octets = await extrairePage_(contexte.pdf, index);
  } catch (e) {
    etat.compteurs.erreurs++;
    console.error('Page ' + numeroPage + ' : découpage impossible — ' + e.message);
    contexte.lignesJournal.push(ligneJournal_(etat, numeroPage, matricule, STATUTS.ERREUR, null, '',
      'Découpage impossible : ' + e.message));
    return {};
  }

  var email = emailPourMatricule_(contexte.annuaire, matricule);
  if (!email) {
    // Règle 4 — routage impossible : archivage en anomalie, pas d'envoi.
    if (!detail) {
      detail = !matricule ? 'Matricule introuvable sur la page'
        : Object.prototype.hasOwnProperty.call(contexte.annuaire, matricule)
          ? 'Email manquant, invalide ou ambigu dans la table de correspondance'
          : 'Matricule absent de la table de correspondance';
    }
    var fichierAnomalie = enregistrerPdf_(contexte.dossierAnomalies, octets, nomAnomalie_(numeroPage));
    etat.compteurs.anomalies++;
    console.warn('ALERTE page ' + numeroPage + ' (matricule « ' + (matricule || '?') + ' ») : ' + detail);
    contexte.lignesJournal.push(ligneJournal_(etat, numeroPage, matricule, STATUTS.ANOMALIE,
      fichierAnomalie, '', detail));
    return {};
  }

  if (quotaEmailsRestant_() <= 0) return { quotaEpuise: true };

  var fichier = enregistrerPdf_(contexte.dossierMois, octets, nomBulletin_(matricule));
  try {
    envoyerBulletin_(contexte.config, etat.periode, matricule, email, fichier);
  } catch (e) {
    if (/too many times|quota|limit exceeded/i.test(e.message)) {
      // Quota atteint malgré le contrôle préalable : la page sera reprise en entier.
      fichier.setTrashed(true);
      return { quotaEpuise: true };
    }
    etat.compteurs.archives++;
    etat.compteurs.echecsEnvoi++;
    console.error('Page ' + numeroPage + ' : échec d\'envoi à ' + email + ' — ' + e.message);
    contexte.lignesJournal.push(ligneJournal_(etat, numeroPage, matricule, STATUTS.ECHEC_ENVOI,
      fichier, email, e.message));
    return {};
  }
  etat.compteurs.archives++;
  etat.compteurs.envoyes++;
  contexte.lignesJournal.push(ligneJournal_(etat, numeroPage, matricule, STATUTS.ENVOYE, fichier, email, ''));
  return {};
}

/** Erreur bloquante d'un lot : nouvelle tentative différée, puis arrêt. */
function gererErreurLot_(config, etat, erreur) {
  etat.echecsConsecutifs = (etat.echecsConsecutifs || 0) + 1;
  console.error('Erreur bloquante (tentative ' + etat.echecsConsecutifs + '/' + config.MAX_ECHECS_CONSECUTIFS +
    ') à la page ' + (etat.pageSuivante + 1) + ' : ' + (erreur.stack || erreur.message));
  if (etat.echecsConsecutifs >= config.MAX_ECHECS_CONSECUTIFS) {
    etat.statut = STATUTS_TRAITEMENT.ECHEC;
    sauvegarderEtat_(etat);
    supprimerDeclencheurs_();
    envoyerAlerteAdministrateur_(config, 'Traitement interrompu',
      'Le traitement ' + etat.id + ' (' + etat.fichierNom + ') est arrêté après ' + etat.echecsConsecutifs +
      ' échecs consécutifs à la page ' + (etat.pageSuivante + 1) + '/' + (etat.nbPages || '?') + '.\n\n' +
      'Dernière erreur : ' + erreur.message + '\n\n' +
      'Après correction, exécutez traiterLot() pour reprendre à cette page.');
    return;
  }
  sauvegarderEtat_(etat);
  planifierReprise_(new Date(Date.now() + 5 * 60 * 1000));
}

/** Clôture : contrôle d'intégrité, rapport, purge de l'état et des déclencheurs. */
function finaliserTraitement_(config, etat) {
  supprimerDeclencheurs_();
  var c = etat.compteurs;
  var integre = c.archives + c.anomalies === etat.nbPages;
  try {
    classerPdfMaitre_(config, etat.fichierId);
  } catch (e) {
    console.error('Impossible de déplacer le PDF maître : ' + e.message);
  }
  var rapport = [
    'Traitement ' + etat.id + ' terminé.',
    '',
    'Fichier source       : ' + etat.fichierNom,
    'Période              : ' + etat.periode.mois + '/' + etat.periode.annee,
    'Pages du PDF maître  : ' + etat.nbPages,
    'Bulletins archivés   : ' + c.archives,
    '  dont envoyés       : ' + c.envoyes,
    '  dont échecs envoi  : ' + c.echecsEnvoi,
    'Anomalies            : ' + c.anomalies,
    'Erreurs de découpage : ' + c.erreurs,
    'Lots d\'exécution     : ' + etat.lots,
    '',
    'Contrôle d\'intégrité (bulletins + anomalies = pages) : ' + (integre ? 'CONFORME' :
      'NON CONFORME (' + (c.archives + c.anomalies) + ' / ' + etat.nbPages + ')'),
    '',
    'Archives : https://drive.google.com/drive/folders/' + etat.dossierMoisId,
    etat.journalId ? 'Journal  : https://docs.google.com/spreadsheets/d/' + etat.journalId : ''
  ].join('\n');
  console.log(rapport);
  PropertiesService.getScriptProperties().setProperty(CLE_DERNIER_RAPPORT, rapport);
  purgerEtat_();
  var aTraiter = c.anomalies + c.echecsEnvoi + c.erreurs;
  envoyerAlerteAdministrateur_(config,
    'Rapport ' + etat.periode.mois + '/' + etat.periode.annee + (aTraiter ? ' - ' + aTraiter + ' cas à traiter' : ''),
    rapport);
}

/** Contrôle à blanc de l'installation : n'écrit rien et n'envoie rien. */
async function verifierConfiguration() {
  var config = lireConfig_();
  validerConfig_(config);
  var racine = DriveApp.getFolderById(config.DOSSIER_RACINE_ID);
  var annuaire = chargerAnnuaire_(config);
  var matricules = Object.keys(annuaire);
  var sansEmail = matricules.filter(function (m) { return !annuaire[m]; });
  chargerBibliotheques_();
  var fichier = trouverPdfMaitre_(config);
  var pdf = await ouvrirPdfMaitre_(fichier);
  var regex = compilerRegexMatricule_(config.REGEX_MATRICULE);
  var apercu = [];
  for (var i = 0; i < Math.min(3, pdf.nbPages); i++) {
    var matricule = extraireMatricule_(await extraireTextePage_(pdf, i), regex);
    apercu.push('page ' + (i + 1) + ' → ' + (matricule || 'AUCUN MATRICULE') +
      (matricule ? (emailPourMatricule_(annuaire, matricule) ? ' (email trouvé)' : ' (NON ROUTABLE)') : ''));
  }
  var quota = quotaEmailsRestant_();
  var message = [
    'Configuration valide.',
    'Dossier racine        : ' + racine.getName(),
    'Table de correspondance : ' + matricules.length + ' matricules, dont ' + sansEmail.length + ' sans email valide',
    'PDF maître            : ' + fichier.getName() + ' (' + pdf.nbPages + ' pages)',
    'Aperçu                : ' + apercu.join(' ; '),
    'Quota d\'envoi restant : ' + quota + (quota < pdf.nbPages ? ' (INSUFFISANT : reprise le lendemain)' : ''),
    config.EMAIL_REDIRECTION ? 'MODE TEST : courriels redirigés vers ' + config.EMAIL_REDIRECTION : ''
  ].join('\n');
  console.log(message);
  return message;
}

/** Affiche la progression du traitement en cours, ou le dernier rapport. */
function afficherEtat() {
  var etat = lireEtat_();
  var message = etat
    ? 'Traitement ' + etat.id + ' — ' + etat.statut + ' — page ' + etat.pageSuivante + '/' + (etat.nbPages || '?') +
      ' — ' + JSON.stringify(etat.compteurs)
    : (PropertiesService.getScriptProperties().getProperty(CLE_DERNIER_RAPPORT) || 'Aucun traitement.');
  console.log(message);
  return message;
}

/** Abandonne le traitement en cours (les fichiers déjà créés sont conservés). */
function reinitialiserTraitement() {
  supprimerDeclencheurs_();
  purgerEtat_();
  console.log('État et déclencheurs supprimés.');
}
