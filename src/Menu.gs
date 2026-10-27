/**
 * Menu « Bulletins de salaire » dans le Google Sheet de correspondance.
 * Nécessite que le projet soit rattaché au Sheet (Extensions > Apps Script).
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bulletins de salaire')
    .addItem('Vérifier la configuration', 'menuVerifier')
    .addItem('Lancer l\'envoi des bulletins…', 'menuLancer')
    .addSeparator()
    .addItem('Voir l\'avancement', 'menuAvancement')
    .addItem('Abandonner le traitement en cours…', 'menuAbandonner')
    .addToUi();
}

async function menuVerifier() {
  await depuisMenu_(async function (ui) {
    ui.alert('Vérification', await verifierConfiguration(), ui.ButtonSet.OK);
  });
}

/** Contrôle à blanc, confirmation, puis lancement en arrière-plan. */
async function menuLancer() {
  await depuisMenu_(async function (ui) {
    var etat = lireEtat_();
    if (etat) {
      ui.alert('Traitement déjà en cours', afficherEtat(), ui.ButtonSet.OK);
      return;
    }
    var resume = await verifierConfiguration();
    var reponse = ui.alert('Lancer l\'envoi des bulletins ?',
      resume + '\n\nLes courriels partiront de votre compte (' + utilisateurCourant_() + ').',
      ui.ButtonSet.YES_NO);
    if (reponse !== ui.Button.YES) return;

    initialiserTraitement_();
    // Le premier lot tourne par déclencheur : le Sheet n'est pas bloqué 5 minutes.
    planifierReprise_(new Date(Date.now() + 1000));
    ui.alert('Traitement lancé',
      'Les envois démarrent d\'ici une minute et se poursuivent automatiquement.\n' +
      'Suivez l\'avancement via « Voir l\'avancement ». Le rapport final sera envoyé à ' +
      destinataireRapport_(lireConfig_()) + '.', ui.ButtonSet.OK);
  });
}

async function menuAvancement() {
  await depuisMenu_(function (ui) {
    ui.alert('Avancement', afficherEtat(), ui.ButtonSet.OK);
  });
}

async function menuAbandonner() {
  await depuisMenu_(function (ui) {
    if (!lireEtat_()) {
      ui.alert('Aucun traitement en cours.');
      return;
    }
    var reponse = ui.alert('Abandonner le traitement ?',
      afficherEtat() + '\n\nLes bulletins déjà archivés et envoyés sont conservés ; les pages restantes ' +
      'ne seront pas traitées.', ui.ButtonSet.YES_NO);
    if (reponse === ui.Button.YES) {
      reinitialiserTraitement();
      ui.alert('Traitement abandonné.');
    }
  });
}

/** Contrôle d'accès et affichage des erreurs pour les actions du menu. */
async function depuisMenu_(action) {
  var ui = SpreadsheetApp.getUi();
  try {
    verifierAutorisation_(lireConfig_());
    await action(ui);
  } catch (e) {
    ui.alert('Bulletins de salaire', e.message, ui.ButtonSet.OK);
  }
}

function utilisateurCourant_() {
  return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
}

function verifierAutorisation_(config) {
  if (!config.UTILISATEURS_AUTORISES) return;
  var autorises = config.UTILISATEURS_AUTORISES.split(',').map(function (adresse) {
    return adresse.trim().toLowerCase();
  });
  var utilisateur = utilisateurCourant_();
  if (!utilisateur || autorises.indexOf(utilisateur) === -1) {
    throw new Error('Accès refusé : ' + (utilisateur || 'utilisateur non identifié') +
      ' n\'est pas autorisé à utiliser ce menu.');
  }
}
