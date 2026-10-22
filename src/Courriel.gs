/**
 * Routage et envoi des bulletins via GmailApp.
 */

function remplirModele_(modele, valeurs) {
  return String(modele).replace(/\{(\w+)\}/g, function (tout, cle) {
    return Object.prototype.hasOwnProperty.call(valeurs, cle) ? valeurs[cle] : tout;
  });
}

function echapperHtml_(texte) {
  return String(texte).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quotaEmailsRestant_() {
  return MailApp.getRemainingDailyQuota();
}

/** Envoie le bulletin à l'employé (ou à l'adresse de redirection en mode test). */
function envoyerBulletin_(config, periode, matricule, email, fichier) {
  var valeurs = {
    matricule: matricule,
    mois: periode.mois,
    annee: periode.annee,
    nomMois: NOMS_MOIS[Number(periode.mois) - 1]
  };
  var objet = remplirModele_(config.OBJET_EMAIL, valeurs);
  var corps = remplirModele_(config.CORPS_EMAIL, valeurs);
  var destinataire = email;
  if (config.EMAIL_REDIRECTION) {
    destinataire = config.EMAIL_REDIRECTION;
    objet = '[TEST - destinataire réel : ' + email + '] ' + objet;
  }
  var options = {
    name: config.EXPEDITEUR_NOM,
    attachments: [fichier.getBlob()],
    htmlBody: echapperHtml_(corps).replace(/\n/g, '<br>')
  };
  if (config.EMAIL_REPONSE) options.replyTo = config.EMAIL_REPONSE;
  GmailApp.sendEmail(destinataire, objet, corps, options);
}

function destinataireRapport_(config) {
  return config.EMAIL_RAPPORT || Session.getEffectiveUser().getEmail();
}

function envoyerAlerteAdministrateur_(config, objet, message) {
  try {
    MailApp.sendEmail(destinataireRapport_(config), '[Bulletins de salaire] ' + objet, message);
  } catch (e) {
    console.error('Impossible d\'envoyer l\'alerte administrateur : ' + e.message);
  }
}
